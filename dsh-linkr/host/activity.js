/**
 * The bounded activity ring and the panel channel of the dsh-linkr Host half.
 *
 * One ring per applied plugin: the newest entries of what the agent and the
 * panel did with the device (CONTRACT §12.1). The panel channel is the fan-out
 * the ring and the panel's own control events share: a small control backlog
 * plus every open SSE response. Both are created per apply and handed around
 * through `deps`, so two applied plugins never share state.
 */

/**
 * Control events for the Web UI screen panel, on a channel of their own: the
 * frame stream carries pixels, and an "open" riding it would be parsed as a
 * JPEG. The backlog is small and control-shaped, so a panel that mounts after
 * the agent said "open" still gets the message.
 */
const PANEL_LIMIT = 16;
export const PANEL_ACTIONS = ['open', 'focus', 'close'];

/**
 * The activity ring the panel shows under the picture (CONTRACT §12.1): the
 * newest entries of what the agent and the panel did with the device. The ring
 * itself lives inside `apply` (one per applied plugin); only the fan-out to the
 * SSE subscribers is shared with the panel channel above.
 */
const LOG_LIMIT = 100;
const LOG_REPLAY = 50;
const LOG_DETAIL_MAX = 160;

/** One short line, whatever came in: no newlines, no runaway sentences. */
export function oneLine(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > LOG_DETAIL_MAX ? `${flat.slice(0, LOG_DETAIL_MAX - 1)}\u2026` : flat;
}

/** The panel channel: the control backlog and every open panel SSE response. */
export function createPanelChannel() {
  const panelState = { events: [], subscribers: new Set(), last: null };

  /** Send one activity entry to every panel stream, beside the panel records. */
  function publishLog(entry) {
    const frame = `data: ${JSON.stringify({ type: 'log', entry })}\n\n`;
    for (const response of panelState.subscribers) {
      try {
        response.write(frame);
      } catch {
        panelState.subscribers.delete(response);
      }
    }
  }

  /** Publish one panel control event to the backlog and to every open SSE stream. */
  function publishPanel(action) {
    const record = { type: 'panel', action, at: Date.now() };
    panelState.last = record;
    panelState.events.push(record);
    if (panelState.events.length > PANEL_LIMIT) {
      panelState.events.splice(0, panelState.events.length - PANEL_LIMIT);
    }
    const frame = `data: ${JSON.stringify(record)}\n\n`;
    for (const response of panelState.subscribers) {
      try {
        response.write(frame);
      } catch {
        panelState.subscribers.delete(response);
      }
    }
    return record;
  }

  /** What the panel channel last said and who is listening, for `state`. */
  function panelInfo() {
    return {
      last: panelState.last === null ? '' : panelState.last.action,
      at: panelState.last === null ? 0 : panelState.last.at,
      subscribers: panelState.subscribers.size,
    };
  }

  function openPanelStream(req, res, replayLogs) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': linkr panel stream\n\n');
    for (const event of panelState.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    // A panel that mounts after the fact still gets the recent activity, oldest
    // first, so the log fills without a second request (CONTRACT §12.1).
    if (typeof replayLogs === 'function') {
      for (const entry of replayLogs()) {
        res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
      }
    }
    panelState.subscribers.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* the close handler removes it */
      }
    }, 20000);
    ping.unref?.();
    const cleanup = () => {
      clearInterval(ping);
      panelState.subscribers.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  function closePanelStreams() {
    for (const response of [...panelState.subscribers]) {
      try {
        response.end();
      } catch {
        /* already gone */
      }
    }
    panelState.subscribers.clear();
  }

  return {
    publish: publishPanel,
    publishLog,
    info: panelInfo,
    openStream: openPanelStream,
    closeAll: closePanelStreams,
    subscriberCount: () => panelState.subscribers.size,
  };
}

/** The activity ring: what the agent and the panel did with the device. */
export function createActivity(panel) {
  /** The newest entries of this plugin's activity, cleared when apply runs again. */
  const activity = { entries: [] };
  /** The password we last resolved; no entry may ever carry it. */
  let knownPassword = '';

  /** Scrub anything secret out of a detail before it is stored or published. */
  function redact(text) {
    let value = typeof text === 'string' ? text : String(text ?? '');
    if (knownPassword.length >= 3) value = value.split(knownPassword).join('\u2022\u2022\u2022\u2022\u2022\u2022');
    // A base URL may carry credentials; those never belong in a log line.
    value = value.replace(/\/\/[^/@\s]+@/g, '//');
    return value;
  }

  /** Append one entry to the ring and hand it to every open panel stream. */
  function record({ source, action, detail, ok = true, params = null }) {
    const entry = {
      at: Date.now(),
      // Only what the agent did and what happened to the device: a person's own
      // clicks, keys and connects are theirs (CONTRACT §13.1), so a `panel` source
      // can no longer reach the ring at all.
      source: source === 'agent' ? 'agent' : 'host',
      action: oneLine(action),
      detail: oneLine(redact(detail)),
      ok: ok !== false,
      // Additive machine-readable form of the same operation, so the panel can
      // phrase the row in the user's language instead of echoing English.
      params: cleanParams(params),
    };
    activity.entries.push(entry);
    if (activity.entries.length > LOG_LIMIT) {
      activity.entries.splice(0, activity.entries.length - LOG_LIMIT);
    }
    panel.publishLog(entry);
    return entry;
  }

  /**
   * The `params` half of an entry: primitives only, scrubbed and capped like a
   * detail, so nothing secret can ride along and the JSON stays small.
   */
  function cleanParams(params) {
    if (params === null || typeof params !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) out[key] = value;
        continue;
      }
      if (typeof value === 'boolean') {
        out[key] = value;
        continue;
      }
      if (typeof value === 'string') out[key] = oneLine(redact(value));
    }
    return out;
  }

  /** The password we last resolved; no entry may ever carry it. */
  function setPassword(value) {
    if (typeof value === 'string' && value !== '') knownPassword = value;
  }

  /** The entries a late panel gets when it mounts (oldest first). */
  function replay() {
    return activity.entries.slice(-LOG_REPLAY);
  }

  /** The body of `GET /linkr/log`: the whole ring, or only entries at/after `since`. */
  function logPayload(rawSince) {
    const since = rawSince === null || rawSince.trim() === '' ? null : Number(rawSince);
    const entries =
      since !== null && Number.isFinite(since) ? activity.entries.filter((entry) => entry.at >= since) : activity.entries.slice();
    return { ok: true, entries, at: Date.now() };
  }

  return { record, setPassword, replay, logPayload };
}
