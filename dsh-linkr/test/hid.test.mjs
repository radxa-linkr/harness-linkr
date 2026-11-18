/**
 * Golden byte vectors for the HID encoders (CONTRACT.md §2.5.1–2.5.2).
 *
 * The expected bytes below are written by hand from the wire format:
 *
 *   frame      = [0x02 mouse | 0x01 keyboard][protobuf body]
 *   mouse body = tag1(0x08) type, tag2(0x10) buttons, tag3(0x19) absX,
 *                tag4(0x21) absY, tag5(0x29) relativeX, tag6(0x31) relativeY,
 *                tag7(0x38) verticalWheelDelta, tag8(0x40) horizontalWheelDelta
 *   double     = 8 bytes little-endian IEEE754:  0.5 -> 00 00 00 00 00 00 e0 3f
 *                                                0.0 -> 00 00 00 00 00 00 00 00
 *   key body   = tag1(0x08) state, tag2(0x12) len key, tag3(0x1a) len code
 *
 * They are deliberately not produced by the encoder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeMouse, encodeKey, keyEventsForText, parseCombo, KEY_TABLE } from '../lib/hid.js';
import { LinkrError } from '../lib/linkr.js';

/** '02 08 01' -> '020801' */
function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

const HALF = '00 00 00 00 00 00 e0 3f'; // 0.5
const ZERO = '00 00 00 00 00 00 00 00'; // 0.0

test('golden: mouse move to the middle writes every double, buttons 0 included', () => {
  const encoded = encodeMouse({ type: 1, x: 0.5, y: 0.5 });
  assert.equal(
    hex(encoded),
    hexString(`
      02
      08 01
      10 00
      19 ${HALF}
      21 ${HALF}
      29 ${ZERO}
      31 ${ZERO}
    `),
  );
  assert.equal(encoded.length, 41);
});

test('golden: left mouse button down carries buttons=1 and the press position', () => {
  assert.equal(
    hex(encodeMouse({ type: 2, buttons: 1, x: 0.5, y: 0.5 })),
    hexString(`
      02
      08 02
      10 01
      19 ${HALF}
      21 ${HALF}
      29 ${ZERO}
      31 ${ZERO}
    `),
  );
});

test('golden: left mouse button up clears the button mask', () => {
  assert.equal(
    hex(encodeMouse({ type: 4, buttons: 0, x: 0.5, y: 0.5 })),
    hexString(`
      02
      08 04
      10 00
      19 ${HALF}
      21 ${HALF}
      29 ${ZERO}
      31 ${ZERO}
    `),
  );
});

test('golden: wheel down one line sets verticalWheelDelta only', () => {
  assert.equal(
    hex(encodeMouse({ type: 3, x: 0.5, y: 0.5, wheelY: 1 })),
    hexString(`
      02
      08 03
      10 00
      19 ${HALF}
      21 ${HALF}
      29 ${ZERO}
      31 ${ZERO}
      38 01
    `),
  );
});

test("golden: wheel up is a ten-byte two's-complement varint", () => {
  // protobuf int32 -1 -> uint64 0xFFFF_FFFF_FFFF_FFFF -> ff*9 then 01
  assert.equal(
    hex(encodeMouse({ type: 3, x: 0.5, y: 0.5, wheelY: -1 })),
    hexString(`
      02
      08 03
      10 00
      19 ${HALF}
      21 ${HALF}
      29 ${ZERO}
      31 ${ZERO}
      38 ff ff ff ff ff ff ff ff ff 01
    `),
  );
});

test('golden: key down for "a"/KeyA', () => {
  assert.equal(
    hex(encodeKey({ key: 'a', code: 'KeyA', down: true })),
    hexString(`
      01
      08 01
      12 01 61
      1a 04 4b 65 79 41
    `),
  );
});

test('golden: key up for "a"/KeyA flips state to 0', () => {
  assert.equal(
    hex(encodeKey({ key: 'a', code: 'KeyA', down: false })),
    hexString(`
      01
      08 00
      12 01 61
      1a 04 4b 65 79 41
    `),
  );
});

test('golden: Enter uses the named-key strings', () => {
  assert.equal(
    hex(encodeKey({ key: 'Enter', code: 'Enter', down: true })),
    hexString(`
      01
      08 01
      12 05 45 6e 74 65 72
      1a 05 45 6e 74 65 72
    `),
  );
});

test('keyEventsForText("Hi!") holds Shift only where the layout needs it', () => {
  assert.deepEqual(keyEventsForText('Hi!'), [
    { key: 'Shift', code: 'ShiftLeft', down: true },
    { key: 'H', code: 'KeyH', down: true },
    { key: 'H', code: 'KeyH', down: false },
    { key: 'Shift', code: 'ShiftLeft', down: false },
    { key: 'i', code: 'KeyI', down: true },
    { key: 'i', code: 'KeyI', down: false },
    { key: 'Shift', code: 'ShiftLeft', down: true },
    { key: '!', code: 'Digit1', down: true },
    { key: '!', code: 'Digit1', down: false },
    { key: 'Shift', code: 'ShiftLeft', down: false },
  ]);
});

test('keyEventsForText maps the US layout, including space and punctuation', () => {
  assert.deepEqual(keyEventsForText('a 1-'), [
    { key: 'a', code: 'KeyA', down: true },
    { key: 'a', code: 'KeyA', down: false },
    { key: ' ', code: 'Space', down: true },
    { key: ' ', code: 'Space', down: false },
    { key: '1', code: 'Digit1', down: true },
    { key: '1', code: 'Digit1', down: false },
    { key: '-', code: 'Minus', down: true },
    { key: '-', code: 'Minus', down: false },
  ]);
});

test('keyEventsForText rejects a non-ASCII character and names it', () => {
  assert.throws(
    () => keyEventsForText('ok汉'),
    (error) => {
      assert.ok(error instanceof LinkrError, 'expected LinkrError');
      assert.match(error.sentence, /汉/);
      assert.match(error.sentence, /U\+6C49/);
      assert.match(error.sentence, /ASCII/);
      // The refusal also says where Unicode input comes from, so the model can
      // send the reader to the Linkrd install guide instead of retrying.
      assert.match(error.sentence, /Linkrd/);
      return true;
    },
  );
  assert.throws(() => keyEventsForText('🙂'), LinkrError);
});

test('parseCombo holds modifiers, then releases them in reverse order', () => {
  assert.deepEqual(parseCombo('ctrl+shift+t'), [
    { key: 'Control', code: 'ControlLeft', down: true },
    { key: 'Shift', code: 'ShiftLeft', down: true },
    { key: 't', code: 'KeyT', down: true },
    { key: 't', code: 'KeyT', down: false },
    { key: 'Shift', code: 'ShiftLeft', down: false },
    { key: 'Control', code: 'ControlLeft', down: false },
  ]);
});

test('parseCombo handles a single named key, a bare character and a shifted character', () => {
  assert.deepEqual(parseCombo('Escape'), [
    { key: 'Escape', code: 'Escape', down: true },
    { key: 'Escape', code: 'Escape', down: false },
  ]);
  assert.deepEqual(parseCombo('a'), [
    { key: 'a', code: 'KeyA', down: true },
    { key: 'a', code: 'KeyA', down: false },
  ]);
  // '!' needs Shift even when the caller did not spell it out.
  assert.deepEqual(parseCombo('ctrl+!'), [
    { key: 'Control', code: 'ControlLeft', down: true },
    { key: 'Shift', code: 'ShiftLeft', down: true },
    { key: '!', code: 'Digit1', down: true },
    { key: '!', code: 'Digit1', down: false },
    { key: 'Shift', code: 'ShiftLeft', down: false },
    { key: 'Control', code: 'ControlLeft', down: false },
  ]);
  assert.deepEqual(parseCombo('f5').map((e) => e.code), ['F5', 'F5']);
  assert.deepEqual(parseCombo('cmd+ArrowUp').map((e) => e.code), [
    'MetaLeft',
    'ArrowUp',
    'ArrowUp',
    'MetaLeft',
  ]);
});

test('parseCombo accepts a lone space as the Space key', () => {
  // A browser panel forwards the keydown for Space as a single " ".
  assert.deepEqual(parseCombo(' '), parseCombo('space'));
  assert.deepEqual(parseCombo(' ').map((e) => e.code), ['Space', 'Space']);
  assert.deepEqual(parseCombo('space'), [
    { key: ' ', code: 'Space', down: true },
    { key: ' ', code: 'Space', down: false },
  ]);
});

test('parseCombo rejects nonsense instead of guessing', () => {
  assert.throws(() => parseCombo(''), LinkrError);
  assert.throws(() => parseCombo('ctrl+madeupkey'), LinkrError);
  assert.throws(() => parseCombo('a+b'), (error) => {
    assert.match(error.sentence, /cannot be held down/);
    return true;
  });
});

test('KEY_TABLE exposes the names the contract lists', () => {
  for (const name of ['enter', 'escape', 'tab', 'f1', 'f12', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'ctrl', 'alt', 'shift', 'meta']) {
    assert.ok(KEY_TABLE[name], `KEY_TABLE.${name} is missing`);
    assert.equal(typeof KEY_TABLE[name].key, 'string');
    assert.equal(typeof KEY_TABLE[name].code, 'string');
  }
});

function hexString(text) {
  return text.replace(/\s+/g, '').toLowerCase();
}
