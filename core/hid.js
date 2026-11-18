/**
 * HID encoders for the Linkr media channel — pure functions, no I/O.
 *
 * Frame layout (device and mobile client agree byte for byte):
 *
 *   [1 byte message type][protobuf body]      1 = keyboard, 2 = mouse
 *
 * Mouse body fields:  1 mouse_type varint, 2 buttons varint (always written),
 *                     3 absX double, 4 absY double, 5 relativeX double,
 *                     6 relativeY double, 7 verticalWheelDelta varint,
 *                     8 horizontalWheelDelta varint.
 * Keyboard body:      1 state bool, 2 key string, 3 code string.
 *
 * The device maps the DOM **code** to a Linux keycode; `key` is only a label, so
 * upper-case characters and shifted symbols need a held Shift as well.
 *
 * The field numbers below are the wire contract the device expects; they were
 * verified against the device at fw 1.6.0 and fw 1.7.0.
 */

import { LinkrError } from './linkr.js';

/** Client → device message types. */
export const CLIENT_TYPE_KEYSTROKE = 1;
export const CLIENT_TYPE_MOUSE = 2;

/** Mouse event kinds. */
export const MOUSE_MOVE = 1;
export const MOUSE_DOWN = 2;
export const MOUSE_WHEEL = 3;
export const MOUSE_UP = 4;

/** Button bits (PointerEvent.buttons semantics). */
export const BUTTON_NONE = 0;
export const BUTTON_LEFT = 1;
export const BUTTON_RIGHT = 2;

/* ------------------------------------------------------------------ writer */

class Writer {
  #bytes = [];

  varint(value) {
    // protobuf int32/int64: negatives are encoded as their 64-bit two's complement.
    let v = BigInt.asUintN(64, BigInt(Math.trunc(Number(value) || 0)));
    while (v > 127n) {
      this.#bytes.push(Number(v & 127n) | 128);
      v >>= 7n;
    }
    this.#bytes.push(Number(v));
  }

  tag(field, wire) {
    this.varint((field << 3) | wire);
  }

  intField(field, value) {
    if (value === undefined || value === null || Number(value) === 0) return;
    this.tag(field, 0);
    this.varint(value);
  }

  boolField(field, value) {
    this.tag(field, 0);
    this.varint(value ? 1 : 0);
  }

  stringField(field, value) {
    if (value === undefined || value === null || value.length === 0) return;
    const utf8 = Buffer.from(String(value), 'utf8');
    this.tag(field, 2);
    this.varint(utf8.length);
    for (const byte of utf8) this.#bytes.push(byte);
  }

  doubleField(field, value) {
    if (value === undefined || value === null) return;
    this.tag(field, 1);
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(Number(value));
    for (const byte of buf) this.#bytes.push(byte);
  }

  frame(type) {
    return Uint8Array.from([type, ...this.#bytes]);
  }
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------- mouse */

/**
 * Mouse event.
 *
 * `type` is one of MOVE(1) / DOWN(2) / WHEEL(3) / UP(4); coordinates are
 * normalized 0..1 of the frame. All four doubles are written even when 0, exactly
 * like the mobile client; wheel deltas are only written when non-zero.
 *
 * @param {{ type: number, buttons?: number, x?: number, y?: number, dx?: number, dy?: number, wheelY?: number, wheelX?: number }} message
 * @returns {Uint8Array}
 */
export function encodeMouse(message = {}) {
  const type = Number(message.type);
  if (![MOUSE_MOVE, MOUSE_DOWN, MOUSE_WHEEL, MOUSE_UP].includes(type)) {
    throw new LinkrError(`unknown mouse type ${String(message.type)}`, {
      sentence: `unknown mouse type "${String(message.type)}": use move, down, wheel or up`,
    });
  }
  const buttons = Math.trunc(finiteOr(message.buttons, 0));
  if (buttons < 0) {
    throw new LinkrError('negative button mask', {
      sentence: 'mouse buttons must be a non-negative bit mask',
    });
  }

  const w = new Writer();
  w.intField(1, type);
  // buttons is written even when 0: the device treats it as "no button held".
  w.tag(2, 0);
  w.varint(buttons);
  w.doubleField(3, finiteOr(message.x, 0));
  w.doubleField(4, finiteOr(message.y, 0));
  w.doubleField(5, finiteOr(message.dx, 0));
  w.doubleField(6, finiteOr(message.dy, 0));
  w.intField(7, Math.trunc(finiteOr(message.wheelY, 0)));
  w.intField(8, Math.trunc(finiteOr(message.wheelX, 0)));
  return w.frame(CLIENT_TYPE_MOUSE);
}

/* ---------------------------------------------------------------- keyboard */

/**
 * One key transition.
 * @param {{ key: string, code: string, down: boolean }} event
 * @returns {Uint8Array}
 */
export function encodeKey(event = {}) {
  const code = event.code === undefined || event.code === null ? '' : String(event.code);
  if (!code) {
    throw new LinkrError('key event without code', {
      sentence: `key event for "${String(event.key ?? '')}" has no DOM code; the device maps codes only`,
    });
  }
  const w = new Writer();
  w.boolField(1, event.down === true);
  w.stringField(2, event.key === undefined || event.key === null ? '' : String(event.key));
  w.stringField(3, code);
  return w.frame(CLIENT_TYPE_KEYSTROKE);
}

/* -------------------------------------------------------------- key tables */

const MODIFIERS = {
  ctrl: { key: 'Control', code: 'ControlLeft' },
  control: { key: 'Control', code: 'ControlLeft' },
  shift: { key: 'Shift', code: 'ShiftLeft' },
  alt: { key: 'Alt', code: 'AltLeft' },
  option: { key: 'Alt', code: 'AltLeft' },
  meta: { key: 'Meta', code: 'MetaLeft' },
  cmd: { key: 'Meta', code: 'MetaLeft' },
  command: { key: 'Meta', code: 'MetaLeft' },
  super: { key: 'Meta', code: 'MetaLeft' },
  win: { key: 'Meta', code: 'MetaLeft' },
};

const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter' },
  return: { key: 'Enter', code: 'Enter' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  tab: { key: 'Tab', code: 'Tab' },
  space: { key: ' ', code: 'Space' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  del: { key: 'Delete', code: 'Delete' },
  insert: { key: 'Insert', code: 'Insert' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  pageup: { key: 'PageUp', code: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
  capslock: { key: 'CapsLock', code: 'CapsLock' },
  printscreen: { key: 'PrintScreen', code: 'PrintScreen' },
  pause: { key: 'Pause', code: 'Pause' },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu' },
  minus: { key: '-', code: 'Minus' },
  equal: { key: '=', code: 'Equal' },
  comma: { key: ',', code: 'Comma' },
  period: { key: '.', code: 'Period' },
  slash: { key: '/', code: 'Slash' },
  backslash: { key: '\\', code: 'Backslash' },
  semicolon: { key: ';', code: 'Semicolon' },
  quote: { key: "'", code: 'Quote' },
  backquote: { key: '`', code: 'Backquote' },
};

/**
 * Named keys the device can press, all lower-case for lookup.
 * @type {Record<string, { key: string, code: string }>}
 */
export const KEY_TABLE = (() => {
  const table = {};
  for (const [name, entry] of Object.entries(NAMED_KEYS)) table[name] = { ...entry };
  for (const [name, entry] of Object.entries(MODIFIERS)) table[name] = { ...entry };
  for (let n = 1; n <= 12; n += 1) table[`f${n}`] = { key: `F${n}`, code: `F${n}` };
  return table;
})();

/** Unshifted punctuation on a US layout → DOM code. */
const UNSHIFTED_CODES = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};

/** Shifted punctuation on a US layout → the character printed on the base key. */
const SHIFTED_BASE = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
};

const MODIFIER_CODES = new Set(['ControlLeft', 'ShiftLeft', 'AltLeft', 'MetaLeft']);

function baseCodeForChar(base) {
  if (base >= '0' && base <= '9') return `Digit${base}`;
  return UNSHIFTED_CODES[base];
}

/** @returns {{ key: string, code: string, shift: boolean } | null} */
function charInfo(ch) {
  if (ch === '\n' || ch === '\r') return { key: 'Enter', code: 'Enter', shift: false };
  if (ch === '\t') return { key: 'Tab', code: 'Tab', shift: false };
  if (ch === ' ') return { key: ' ', code: 'Space', shift: false };
  if (ch >= 'a' && ch <= 'z') return { key: ch, code: `Key${ch.toUpperCase()}`, shift: false };
  if (ch >= 'A' && ch <= 'Z') return { key: ch, code: `Key${ch}`, shift: true };
  if (ch >= '0' && ch <= '9') return { key: ch, code: `Digit${ch}`, shift: false };
  const unshifted = UNSHIFTED_CODES[ch];
  if (unshifted) return { key: ch, code: unshifted, shift: false };
  const base = SHIFTED_BASE[ch];
  if (base) {
    const code = baseCodeForChar(base);
    if (code) return { key: ch, code, shift: true };
  }
  return null;
}

function codepointLabel(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  return `"${ch}" (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`;
}

/** @returns {{ key: string, code: string, shift: boolean, modifier: boolean } | null} */
function resolveToken(token) {
  const text = String(token ?? '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const named = KEY_TABLE[lower];
  if (named) {
    return { ...named, shift: false, modifier: MODIFIER_CODES.has(named.code) };
  }
  if ([...text].length === 1) {
    const info = charInfo(text);
    if (info) return { ...info, modifier: false };
    throw new LinkrError(`cannot type ${text}`, {
      sentence: `cannot type ${codepointLabel(text)}: the device keyboard is US-ASCII only (for Chinese or other Unicode text, install Linkrd on the controlled machine and paste it through its clipboard)`,
    });
  }
  if (text.startsWith('Key') || text.startsWith('Digit') || text.startsWith('Arrow')) {
    // A raw DOM code was passed in; recover the printable label when possible.
    const fromCode = Object.entries(UNSHIFTED_CODES).find(([, code]) => code === text);
    if (fromCode) return { key: fromCode[0], code: text, shift: false, modifier: false };
    return { key: text, code: text, shift: false, modifier: false };
  }
  return null;
}

function unknownKeyError(token) {
  return new LinkrError(`unknown key "${token}"`, {
    sentence: `unknown key "${String(token)}": use a single character, a name like Enter/F5/ArrowUp, or a combo like ctrl+shift+t`,
  });
}

/**
 * Text → ordered down/up pairs. US layout; shifted characters get a held Shift.
 *
 * @param {string} text
 * @returns {Array<{ key: string, code: string, down: boolean }>}
 */
export function keyEventsForText(text) {
  const input = String(text ?? '');
  const events = [];
  for (const ch of input) {
    const info = charInfo(ch);
    if (!info) {
      throw new LinkrError(`cannot type ${ch}`, {
        sentence: `cannot type ${codepointLabel(ch)}: the device keyboard is US-ASCII only (for Chinese or other Unicode text, install Linkrd on the controlled machine and paste it through its clipboard)`,
      });
    }
    if (info.shift) events.push({ key: 'Shift', code: 'ShiftLeft', down: true });
    events.push({ key: info.key, code: info.code, down: true });
    events.push({ key: info.key, code: info.code, down: false });
    if (info.shift) events.push({ key: 'Shift', code: 'ShiftLeft', down: false });
  }
  return events;
}

/**
 * 'ctrl+shift+t' → modifiers down in the written order, key down, key up,
 * modifiers up in reverse. A single name ('Escape', 'f5', 'a') gives one down/up pair.
 *
 * @param {string} combo
 * @returns {Array<{ key: string, code: string, down: boolean }>}
 */
export function parseCombo(combo) {
  const raw = String(combo ?? '');
  const text = raw.trim();
  if (!text) {
    // A panel forwards the DOM key for Space as a lone " ". Treat it as the
    // Space key instead of rejecting it as an empty combo.
    if (raw.length > 0) return parseCombo('space');
    throw new LinkrError('empty key combo', {
      sentence: 'a key combo is required, e.g. "ctrl+alt+t" or "Escape"',
    });
  }
  // A lone '+' is the plus key itself; otherwise split the chord.
  const tokens = text === '+' ? ['+'] : text.split('+').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new LinkrError('empty key combo', {
      sentence: 'a key combo is required, e.g. "ctrl+alt+t" or "Escape"',
    });
  }

  const modifiers = [];
  let target = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const resolved = resolveToken(token);
    if (!resolved) throw unknownKeyError(token);
    const last = i === tokens.length - 1;
    if (!last) {
      if (!resolved.modifier) {
        throw new LinkrError(`"${token}" is not a modifier`, {
          sentence: `"${token}" cannot be held down: only ctrl, shift, alt and meta can precede a key in a combo`,
        });
      }
      if (!modifiers.some((m) => m.code === resolved.code)) {
        modifiers.push({ key: resolved.key, code: resolved.code });
      }
      continue;
    }
    target = resolved;
  }
  if (!target) throw unknownKeyError(text);

  // Shifted characters (upper case, '!') need Shift held unless already asked for.
  if (target.shift && !modifiers.some((m) => m.code === 'ShiftLeft')) {
    modifiers.push({ key: 'Shift', code: 'ShiftLeft' });
  }

  const events = [];
  for (const modifier of modifiers) events.push({ ...modifier, down: true });
  events.push({ key: target.key, code: target.code, down: true });
  events.push({ key: target.key, code: target.code, down: false });
  for (let i = modifiers.length - 1; i >= 0; i -= 1) {
    events.push({ ...modifiers[i], down: false });
  }
  return events;
}
