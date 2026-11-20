/**
 * The `/linkr` routes of the dsh-linkr Host half.
 *
 * One prefix handler for everything the Web UI panel calls, on the same client
 * the tools use: state, settings, connect/input, the MJPEG stream, the panel SSE
 * channel, the clipboard and the activity log. A registerRoutes() call owns
 * exactly one route and one live-stream registry; its cleanup ends every stream
 * it handed out before the plugin's client is disposed.
 */
import { CONFIG_DEFAULTS, STREAM_FPS_RANGE, WRITABLE_KEYS, normalizeConfig } from './config.js';
import { CAPTURE_TIMEOUT_MS, CREDENTIAL_KEY, MASKED_INPUT, sentence } from './client.js';
import { PANEL_ACTIONS } from './activity.js';

/** Route prefix; every path below is relative to it. */
const ROUTE_PREFIX = '/linkr';

/** What a stopped session answers a panel that retries on its own. */
const STOPPED_SENTENCE = 'the screen session is stopped; POST /linkr/connect to start it';

/** multipart/x-mixed-replace boundary for the live screen stream. */
const BOUNDARY = 'linkrframe';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

export function registerRoutes(ctx, deps, { detachGraceMs = 8000 } = {}) {
  /** Every live screen stream the plugin handed out, so a dispose or a disconnect can end them. */
  const liveStreams = new Set();
  let detachTimer = null;
  let panelClient = null;
  let openingStreams = 0;

  function clearDetachTimer() {
    if (detachTimer !== null) {
      clearTimeout(detachTimer);
      detachTimer = null;
    }
  }

  /** The last viewer is gone: let an untouched, panel-started session go. */
  function schedulePanelDetach() {
    if (!panelClient || openingStreams || liveStreams.size || detachTimer !== null) return;
    const expected = panelClient;
    detachTimer = setTimeout(() => {
      detachTimer = null;
      Promise.resolve()
        .then(() => {
          if (expected !== panelClient || openingStreams || liveStreams.size) return;
          return deps.client.releaseIfIdle({ idleMs: detachGraceMs, expected });
        })
        .then((released) => { if (released && panelClient === expected) panelClient = null; })
        .catch(() => {});
    }, detachGraceMs);
    detachTimer.unref?.();
  }

  async function openPanelSession() {
    const expected = await deps.client.currentClient();
    const alreadyLive = expected.state.connected === true;
    const current = await deps.client.liveClient();
    if (!alreadyLive && !deps.explicitStop) panelClient = current;
    return current;
  }

  function stopLiveStreams() {
    clearDetachTimer();
    panelClient = null;
    for (const entry of [...liveStreams]) {
      try {
        entry.stop();
      } catch {
        /* already gone */
      }
    }
    liveStreams.clear();
  }

  /**
   * `GET /linkr/live.mjpeg`: the newest frame at `streamFps`, one multipart part
   * each, until the client goes away or the session stops. Frames come from the
   * same media socket the tools capture from — this route never opens a second one.
   */
  function openLiveStream(req, res) {
    void (async () => {
      clearDetachTimer();
      openingStreams += 1;
      let current;
      try {
        current = await openPanelSession();
      } catch (error) {
        openingStreams -= 1;
        schedulePanelDetach();
        if (res.destroyed) return;
        // An <img> cannot read a body; the panel turns a failed load into a retry
        // and shows this line in its state text. A stream that cannot start is
        // also worth a row: it is how a dead device looks from the panel side.
        deps.activity.record({ source: 'host', action: 'error', detail: `stream: ${sentence(error)}`, ok: false });
        sendJson(res, 409, { ok: false, error: sentence(error) });
        return;
      }

      openingStreams -= 1;
      if (res.destroyed || deps.explicitStop) {
        schedulePanelDetach();
        if (!res.destroyed) sendJson(res, 409, { ok: false, error: STOPPED_SENTENCE });
        return;
      }
      const fps = Math.max(STREAM_FPS_RANGE[0], Math.min(STREAM_FPS_RANGE[1], deps.config.streamFps || CONFIG_DEFAULTS.streamFps));
      const interval = Math.round(1000 / fps);
      const keepAliveMs = Math.max(5000, Math.floor((deps.config.idleStopMs || CONFIG_DEFAULTS.idleStopMs) / 2));

      let closed = false;
      let pending = null;
      let writing = false;
      let blocked = false;
      let lastWriteAt = 0;
      let throttle = null;
      let unsubscribe = null;
      let watchdog = null;
      let keepAliveAt = Date.now();
      let entry = null;

      const stop = () => {
        if (closed) return;
        closed = true;
        if (throttle !== null) clearTimeout(throttle);
        throttle = null;
        if (watchdog !== null) clearInterval(watchdog);
        watchdog = null;
        if (unsubscribe !== null) {
          try {
            unsubscribe();
          } catch {
            /* the session may be gone already */
          }
          unsubscribe = null;
        }
        if (entry !== null) liveStreams.delete(entry);
        schedulePanelDetach();
        try {
          res.end();
        } catch {
          /* the client is already gone */
        }
      };
      entry = { stop };
      liveStreams.add(entry);
      res.once('close', stop);
      res.once('error', stop);

      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Connection: 'close',
        'X-Accel-Buffering': 'no',
      });

      const writeFrame = (frame) => {
        if (closed || blocked || frame === null || frame === undefined) return false;
        const jpeg = Buffer.isBuffer(frame.jpeg) ? frame.jpeg : Buffer.from(frame.jpeg ?? []);
        if (jpeg.length === 0) return false;
        const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`, 'utf8');
        // One write per frame; a slow panel keeps only the newest one instead of
        // queueing the stream in the response buffer.
        if (!res.write(Buffer.concat([head, jpeg, Buffer.from('\r\n')]))) blocked = true;
        lastWriteAt = Date.now();
        return true;
      };

      // Never more than one part per frame slot: the device may push faster than
      // the panel asked for, and a slow socket must not queue frames forever.
      const pump = () => {
        if (closed || blocked || writing || pending === null) return;
        const wait = lastWriteAt === 0 ? 0 : interval - (Date.now() - lastWriteAt);
        if (wait > 0) {
          if (throttle === null) {
            throttle = setTimeout(() => {
              throttle = null;
              pump();
            }, wait);
            throttle.unref?.();
          }
          return;
        }
        const frame = pending;
        pending = null;
        writing = true;
        try {
          writeFrame(frame);
        } catch {
          stop();
        } finally {
          writing = false;
        }
      };

      unsubscribe = current.onFrame((frame) => {
        pending = frame;
        pump();
      });

      // First frame now, so the pane shows the screen instead of the next tick.
      // connect() already waits for a first frame, so the newest one is usually
      // in hand; only a slow device needs the capture wait.
      const newest = typeof current.latest === 'function' ? current.latest() : null;
      if (newest !== null && newest !== undefined) {
        try {
          writeFrame(newest);
        } catch {
          stop();
        }
      } else {
        try {
          writeFrame(await current.capture({ timeoutMs: CAPTURE_TIMEOUT_MS }));
        } catch {
          // Frames pushed by the socket may still arrive; the watchdog gives up
          // if the session dies instead.
        }
      }

      // A panel that keeps watching is activity the session must not idle out
      // from under it, and a session that stopped must close the response rather
      // than leave the <img> hanging on a stream nobody feeds.
      if (closed) return;
      watchdog = setInterval(() => {
        if (closed) return;
        let live = false;
        try {
          live = current.state?.connected === true;
        } catch {
          live = false;
        }
        if (!live) {
          stop();
          return;
        }
        if (Date.now() - keepAliveAt >= keepAliveMs) {
          keepAliveAt = Date.now();
          current.keepAlive?.();
        }
        // While a panel watches, this tick is the fastest witness of a session
        // that stopped on its own (idle stop, dropped socket).
        deps.client.noteSession('observed');
      }, 1000);
      watchdog.unref?.();

      res.on('drain', () => {
        blocked = false;
        if (pending !== null) pump();
      });
    })();
  }

  /**
   * Apply one settings write. Secret handling follows the credentials doctrine:
   * the password goes to the `linkr/device` record when the credentials service
   * exists and never to a config file; a profile without that service keeps it
   * in the row config so the plugin still works.
   */
  async function saveConfig(body) {
    const input = body && typeof body === 'object' ? body : {};
    const patch = {};
    for (const key of WRITABLE_KEYS) {
      const value = input[key];
      if (value === undefined) continue;
      if (key === 'password') {
        if (typeof value !== 'string') return { ok: false, error: 'password must be a string' };
        // A masked value means the form echoed back what it was shown: keep the
        // stored password. An empty one means the field was never touched.
        if (value === '' || MASKED_INPUT.test(value)) continue;
        patch.password = value;
        continue;
      }
      patch[key] = value;
    }
    const password = patch.password;
    delete patch.password;
    if (Object.keys(patch).length === 0 && password === undefined) {
      return { ok: false, error: 'nothing to change' };
    }

    const credentials = ctx.get?.('credentials');
    const canStorePassword = credentials !== undefined && typeof credentials.modifyRecord === 'function';
    // A store that cannot hold the password leaves config as the only home for it.
    if (password !== undefined && !canStorePassword) patch.password = password;

    const issues = [];
    const next = normalizeConfig({ ...deps.config, ...patch }, issues);
    if (issues.length > 0) return { ok: false, error: issues.map((issue) => issue.message).join('; ') };

    // Persist what normalization produced, not what the form sent: the stored
    // row is then exactly what this run reads back (trailing slashes dropped,
    // numbers clamped into range).
    const durable = {};
    for (const key of Object.keys(patch)) durable[key] = next[key];
    const previousDurable = {};
    for (const key of Object.keys(durable)) previousDurable[key] = deps.config[key];
    const editor = ctx.get?.('configEditor');
    const entry = ctx.fiber?.entry;
    const canEdit = editor !== undefined && typeof editor.edit === 'function' && entry !== undefined;
    const writesRow = Object.keys(durable).length > 0 && canEdit;
    let rowSaved = false;
    let passwordStored = false;

    // The row is the durable home of the non-secret settings; write it first so
    // a failed editor leaves everything (including the password) untouched.
    if (writesRow) {
      try {
        await editor.edit(entry, (current) => ({ ...(current ?? {}), ...durable }));
        rowSaved = true;
      } catch (error) {
        return { ok: false, error: `the settings were not saved: ${sentence(error)}` };
      }
    }

    if (password !== undefined && canStorePassword) {
      try {
        await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: { password } }));
        passwordStored = true;
      } catch (error) {
        // A password write that failed after the row was saved would leave half
        // a settings change; put the previous row values back when possible.
        if (rowSaved) {
          try {
            await editor.edit(entry, (current) => ({ ...(current ?? {}), ...previousDurable }));
            rowSaved = false;
          } catch {
            /* report the failed rollback instead of hiding it */
          }
        }
        return {
          ok: false,
          error: rowSaved
            ? `the password was not stored (${sentence(error)}); the other settings were saved`
            : `the password was not stored: ${sentence(error)}`,
        };
      }
    }

    const applied = rowSaved ? 'profile' : passwordStored ? 'credentials' : 'memory';

    Object.assign(deps.config, next);
    // A settings write is an explicit request to make the device work again.
    deps.explicitStop = false;
    // Different device, account or pace means a different client: drop the live
    // one so the next call dials with the new settings (and releases the old socket).
    await deps.client.dispose();
    const changed = [...new Set([...Object.keys(patch), ...(password !== undefined ? ['password'] : [])])];
    return { ok: true, applied, changed, config: await deps.client.publicConfig() };
  }

  const unregister = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      // These routes can drive another computer's keyboard and mouse: refuse
      // cross-origin callers the way the device firmware refuses them.
      const origin = req.headers.origin;
      if (origin) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(origin).host === req.headers.host;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
          return;
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.startsWith(ROUTE_PREFIX)
        ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
        : url.pathname;

      try {
        if (req.method === 'GET' && path === '/state') {
          sendJson(res, 200, { ok: true, state: await deps.client.stateJson(), panel: deps.panel.info() });
          return;
        }
        if (req.method === 'GET' && path === '/config') {
          sendJson(res, 200, {
            ok: true,
            config: await deps.client.publicConfig(),
            state: await deps.client.stateJson(),
            editable: Boolean(ctx.get?.('configEditor')?.edit),
          });
          return;
        }
        if (req.method === 'POST' && path === '/config') {
          const result = await saveConfig(await readJsonBody(req));
          sendJson(res, result.ok ? 200 : 400, result);
          return;
        }
        if (req.method === 'POST' && path === '/connect') {
          deps.explicitStop = false;
          clearDetachTimer();
          try {
            const current = await openPanelSession();
            schedulePanelDetach();
            // A person connecting is their own act: it changes the session,
            // not the agent's record (CONTRACT §13.1). Only the memory moves.
            deps.client.noteSession('connect');
            sendJson(res, 200, { ok: true, state: current.state, panel: deps.panel.info() });
          } catch (error) {
            sendJson(res, 409, { ok: false, error: sentence(error), state: await deps.client.stateJson() });
          }
          return;
        }
        if (req.method === 'POST' && path === '/disconnect') {
          // Explicit stop: the session ends, the panel's stream closes, and
          // from here on nothing a client does on its own starts it again —
          // a retrying <img> would otherwise hand the device back to us one
          // second after somebody released it (CONTRACT §1.3: restore, then stay off).
          deps.explicitStop = true;
          stopLiveStreams();
          try {
            const current = await deps.client.currentClient();
            await current.disconnect();
            deps.client.noteSession('disconnect');
            sendJson(res, 200, { ok: true, state: current.state });
          } catch (error) {
            sendJson(res, 200, { ok: true, state: await deps.client.stateJson(), warning: sentence(error) });
          }
          return;
        }
        if (req.method === 'GET' && path === '/live.mjpeg') {
          // A stopped session answers instead of reconnecting: the panel
          // retries this image on its own, and that retry must not undo a
          // person's disconnect.
          if (deps.explicitStop) {
            sendJson(res, 409, { ok: false, error: STOPPED_SENTENCE });
            return;
          }
          openLiveStream(req, res);
          return;
        }
        if (req.method === 'GET' && path === '/frame.jpg') {
          if (deps.explicitStop) {
            sendJson(res, 409, { ok: false, error: STOPPED_SENTENCE });
            return;
          }
          try {
            const current = await deps.client.liveClient();
            const frame = await current.capture({ timeoutMs: CAPTURE_TIMEOUT_MS });
            const jpeg = Buffer.isBuffer(frame.jpeg) ? frame.jpeg : Buffer.from(frame.jpeg ?? []);
            res.writeHead(200, {
              'Content-Type': 'image/jpeg',
              'Content-Length': jpeg.length,
              'Cache-Control': 'no-store',
            });
            res.end(jpeg);
          } catch (error) {
            // No frame in hand: 409 carries the reason instead of an empty image,
            // and the ring keeps a row so the panel's history explains it.
            deps.activity.record({ source: 'host', action: 'error', detail: `frame: ${sentence(error)}`, ok: false });
            sendJson(res, 409, { ok: false, error: sentence(error) });
          }
          return;
        }
        if (req.method === 'POST' && path === '/input') {
          // Same rule as the two frame routes: a stopped session takes no
          // panel input, because the call would start a session the person
          // just released. The tools clear the stop first, so they still work.
          if (deps.explicitStop) {
            sendJson(res, 409, { ok: false, error: STOPPED_SENTENCE });
            return;
          }
          const body = await readJsonBody(req);
          if (body === null || typeof body !== 'object' || typeof body.kind !== 'string') {
            sendJson(res, 400, { ok: false, error: 'input needs a kind: "mouse", "key" or "text"' });
            return;
          }
          try {
            // The very call the tools make: one action, one input path. A
            // person's click is not agent activity, so it is not recorded.
            const { result } = await deps.client.applyInput(body);
            sendJson(res, 200, { ok: true, applied: result.applied, detail: result.detail });
          } catch (error) {
            sendJson(res, 409, { ok: false, error: sentence(error) });
          } finally {
            deps.client.noteSession('observed');
          }
          return;
        }
        if (req.method === 'GET' && path === '/clipboard') {
          // The panel asks whether Linkrd's clipboard is usable; the probe is
          // cached for a few seconds and never carries the clipboard text.
          sendJson(res, 200, { ok: true, clipboard: await deps.client.clipboardSnapshot() });
          return;
        }
        if (req.method === 'POST' && path === '/clipboard') {
          // A stopped session takes no paste: the chord would start the
          // session a person just released, exactly like POST /input.
          if (deps.explicitStop) {
            sendJson(res, 409, { ok: false, error: STOPPED_SENTENCE, reason: 'stopped' });
            return;
          }
          const body = await readJsonBody(req);
          const text = typeof body?.text === 'string' ? body.text : '';
          const keys = typeof body?.keys === 'string' ? body.keys.trim() : '';
          if (text === '') {
            sendJson(res, 400, { ok: false, error: 'clipboard needs a non-empty "text"' });
            return;
          }
          try {
            // Writing the clipboard needs no media session; pressing the paste
            // chord does, so only that shape asks the session to come up.
            const current = keys === '' ? await deps.client.currentClient() : await deps.client.liveClient();
            const written = await current.paste({ text, keys });
            // A person's own paste is their act; the panel reads this answer,
            // not the activity ring (CONTRACT §13.1).
            sendJson(res, 200, {
              ok: true,
              bytes: written.bytes,
              maxBytes: written.maxBytes,
              revision: written.revision,
              keys: written.keys,
            });
            deps.client.invalidateClipboard();
          } catch (error) {
            sendJson(res, 409, {
              ok: false,
              error: sentence(error),
              reason: typeof error?.reason === 'string' && error.reason !== '' ? error.reason : 'device-error',
            });
          } finally {
            deps.client.noteSession('observed');
          }
          return;
        }
        if (req.method === 'GET' && path === '/panel/stream') {
          // The panel gets the activity backlog right after the stream opens.
          deps.panel.openStream(req, res, deps.activity.replay);
          return;
        }
        if (req.method === 'GET' && path === '/log') {
          // A reader that missed the stream catches up here (CONTRACT §12.1).
          sendJson(res, 200, deps.activity.logPayload(url.searchParams.get('since')));
          return;
        }
        if (req.method === 'POST' && path === '/panel') {
          const body = await readJsonBody(req);
          const action = typeof body?.action === 'string' ? body.action : '';
          if (!PANEL_ACTIONS.includes(action)) {
            sendJson(res, 400, { ok: false, error: `action must be one of ${PANEL_ACTIONS.join(', ')}` });
            return;
          }
          sendJson(res, 200, { ok: true, event: deps.panel.publish(action), panel: deps.panel.info() });
          return;
        }
        sendJson(res, 404, { ok: false, error: `no route ${req.method} ${ROUTE_PREFIX}${path}` });
      } catch (error) {
        // A body that is not JSON, or anything else that escaped a branch:
        // answer in the shape every caller of these routes expects.
        sendJson(res, 400, { ok: false, error: sentence(error) });
      }
    },
  });

  return () => {
    stopLiveStreams();
    clearDetachTimer();
    unregister();
  };
}
