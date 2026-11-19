#!/usr/bin/env node
/**
 * A late close event from the previous media socket must not tear down the one
 * started after stop(). stop() closes the old WebSocket asynchronously; a quick
 * restart can assign the new socket before the old 'close' handler runs.
 *
 * A stub WebSocket holds the close event so the interleaving is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { MediaSession } from '../lib/media.js';
import { CANNED_JPEG } from './fake-device.mjs';

class FakeWebSocket {
  static instances = [];
  static heldCloses = [];

  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.#emit('open', {});
      setTimeout(() => this.#emit('message', { data: CANNED_JPEG }), 0);
    }, 0);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }

  send() {}

  close() {
    this.closed = true;
    this.readyState = 3;
    FakeWebSocket.heldCloses.push(() => this.#emit('close', { code: 1000, reason: 'bye' }));
  }

  #emit(type, event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

test('a late close from the replaced socket does not stop the new session', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  FakeWebSocket.heldCloses = [];
  const device = { origin: 'http://127.0.0.1:1', whep: async () => ({ answer: 'stub-token' }) };
  const session = new MediaSession(device, { codec: 'mjpeg' });
  t.after(() => {
    session.stop();
    globalThis.WebSocket = original;
  });

  await session.start({ timeoutMs: 5000 });
  assert.equal(session.open, true, 'first socket open');

  session.stop();
  await session.start({ timeoutMs: 5000 });
  assert.equal(session.open, true, 'second socket open');
  assert.equal(FakeWebSocket.heldCloses.length, 1, 'the first close is still pending');

  // Now deliver the old socket's close while the new socket is open.
  FakeWebSocket.heldCloses.shift()();
  await sleep(100);
  assert.equal(session.open, true, 'the replaced socket close must be ignored');

  const frame = await session.waitFrame({ after: 0, timeoutMs: 3000 });
  assert.ok(frame && frame.jpeg.length > 0, 'frames still flow on the new socket');
});
