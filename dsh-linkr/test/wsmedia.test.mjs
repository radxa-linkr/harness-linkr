/**
 * The ws-media frame format (CONTRACT.md §7.1) and the JPEG byte splitter that
 * turns ffmpeg's image2pipe output into frames.
 *
 * The packet bytes below are written by hand from the header layout; they are not
 * produced by the parser under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWsMediaPacket,
  JpegStreamSplitter,
  WS_MEDIA_HEADER_SIZE,
  WS_MEDIA_TYPE_VIDEO,
  WS_MEDIA_TYPE_AUDIO,
} from '../lib/media.js';
import { LinkrError } from '../lib/linkr.js';
import { CANNED_JPEG } from './fake-device.mjs';

/** 25-byte header + payload, matching the device's big-endian layout. */
function packet({ mediaType = 1, ptsUs = 0n, durationUs = 0n, payload = Buffer.alloc(0), payloadSize } = {}) {
  const head = Buffer.alloc(WS_MEDIA_HEADER_SIZE);
  head[0] = mediaType;
  head.writeBigInt64BE(BigInt(ptsUs), 1);
  head.writeBigUInt64BE(BigInt(durationUs), 9);
  head.writeBigUInt64BE(BigInt(payloadSize ?? payload.length), 17);
  return Buffer.concat([head, payload]);
}

test('golden: a 25-byte ws-media header is parsed field by field', () => {
  // mediaType 1, ptsUs 1234567 (0x12D687), durationUs 33333 (0x8235), payload 'hello'
  const bytes = Buffer.from(
    '01' + // mediaType
      '000000000012d687' + // ptsUs  = 1234567
      '0000000000008235' + // durationUs = 33333
      '0000000000000005' + // payloadSize = 5
      '68656c6c6f', // 'hello'
    'hex',
  );
  assert.equal(bytes.length, WS_MEDIA_HEADER_SIZE + 5);

  const parsed = parseWsMediaPacket(bytes);
  assert.equal(parsed.mediaType, WS_MEDIA_TYPE_VIDEO);
  assert.equal(parsed.ptsUs, 1234567n);
  assert.equal(parsed.durationUs, 33333n);
  assert.equal(parsed.payloadSize, 5n);
  assert.equal(parsed.payload.toString('latin1'), 'hello');
});

test('golden: audio packets and negative pts are accepted', () => {
  const parsed = parseWsMediaPacket(
    packet({ mediaType: WS_MEDIA_TYPE_AUDIO, ptsUs: -1n, durationUs: 20000n, payload: Buffer.from([0xaa]) }),
  );
  assert.equal(parsed.mediaType, WS_MEDIA_TYPE_AUDIO);
  assert.equal(parsed.ptsUs, -1n);
  assert.equal(parsed.durationUs, 20000n);
  assert.equal(parsed.payload.toString('hex'), 'aa');
});

test('a short, mistyped or size-mismatched packet is rejected with a sentence', () => {
  assert.throws(() => parseWsMediaPacket(Buffer.alloc(WS_MEDIA_HEADER_SIZE - 1)), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.match(error.sentence, /25/);
    return true;
  });
  assert.throws(() => parseWsMediaPacket(packet({ mediaType: 3, payload: Buffer.from([1]) })), (error) => {
    assert.match(error.sentence, /media type 3/);
    return true;
  });
  assert.throws(
    () => parseWsMediaPacket(packet({ payload: Buffer.from([1, 2, 3]), payloadSize: 4 })),
    (error) => {
      assert.match(error.sentence, /promises 4 payload bytes/);
      return true;
    },
  );
});

test('splitter: one JPEG in one chunk comes out byte-identical', () => {
  const splitter = new JpegStreamSplitter();
  const frames = splitter.push(CANNED_JPEG);
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(CANNED_JPEG));
  assert.equal(splitter.pending, 0);
});

test('splitter: chunk boundaries anywhere still yield complete frames', () => {
  const splitter = new JpegStreamSplitter();
  const frames = [];
  for (let offset = 0; offset < CANNED_JPEG.length; offset += 777) {
    frames.push(...splitter.push(CANNED_JPEG.subarray(offset, offset + 777)));
  }
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(CANNED_JPEG));
});

test('splitter: a split SOI across chunks is reassembled', () => {
  const splitter = new JpegStreamSplitter();
  assert.deepEqual(splitter.push(CANNED_JPEG.subarray(0, 1)), []); // lone 0xFF
  const frames = splitter.push(CANNED_JPEG.subarray(1));
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(CANNED_JPEG));
});

test('splitter: two concatenated frames and a truncated tail', () => {
  const splitter = new JpegStreamSplitter();
  const both = Buffer.concat([CANNED_JPEG, CANNED_JPEG]);
  assert.equal(splitter.push(both).length, 2);

  const partial = splitter.push(CANNED_JPEG.subarray(0, CANNED_JPEG.length - 2));
  assert.equal(partial.length, 0);
  assert.ok(splitter.pending > 0, 'the partial frame is kept between chunks');
  const finished = splitter.push(CANNED_JPEG.subarray(CANNED_JPEG.length - 2));
  assert.equal(finished.length, 1);
  assert.ok(finished[0].equals(CANNED_JPEG));
});

test('splitter: leading garbage is skipped', () => {
  const splitter = new JpegStreamSplitter();
  const frames = splitter.push(Buffer.concat([Buffer.from('garbage bytes'), CANNED_JPEG]));
  assert.equal(frames.length, 1);
  assert.ok(frames[0].equals(CANNED_JPEG));
});
