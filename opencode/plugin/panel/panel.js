/* Linkr shared-computer panel: live MJPEG, pointer/keyboard input, paste, activity. */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const token = params.get('t') || '';
  const embed = params.has('embed');
  if (embed) document.body.classList.add('embed');
  // The desktop panel passes the app's appearance; a standalone page falls
  // back to the system preference (see the CSS media query).
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  const withToken = (path) => `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const frame = $('frame');
  const hint = $('hint');
  const statusDot = $('status-dot');
  const statusText = $('status');
  const metrics = $('metrics');
  const activityList = $('activity-list');
  const pasteBox = $('paste-box');
  const pasteText = $('paste-text');
  const toast = $('toast');

  let streamNonce = 0;
  let retry = null;
  let fit = true;
  let busy = false;
  let lastPoint = null;
  let dragStart = null;
  let dragged = false;
  let clickTimer = null;
  let clickPoint = null;
  let stateTimer = null;

  const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn']);
  const NAMED = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const PUNCT = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };

  let lastParentNotice = 0;
  /** Tell the desktop panel that this page can no longer reach its server. */
  function reportPanelError(message) {
    const now = Date.now();
    if (now - lastParentNotice < 3000) return;
    lastParentNotice = now;
    try {
      window.parent.postMessage({ type: 'linkr-panel-error', message: String(message) }, '*');
    } catch {
      /* a standalone page has no parent to tell */
    }
  }

  function showToast(text, ok = false) {
    toast.textContent = String(text);
    toast.className = ok ? 'toast ok' : 'toast';
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  function setStatus(kind, text) {
    statusDot.className = `dot ${kind}`;
    statusText.textContent = text;
  }

  async function api(path, body) {
    let response;
    try {
      response = await fetch(withToken(path), body === undefined ? { cache: 'no-store' } : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      reportPanelError(error.message || error);
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function pixelPoint(event) {
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const width = frame.naturalWidth || rect.width;
    const height = frame.naturalHeight || rect.height;
    const x = Math.round(((event.clientX - rect.left) / rect.width) * width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * height);
    return [Math.max(0, Math.min(width - 1, x)), Math.max(0, Math.min(height - 1, y))];
  }

  function sendInput(payload) {
    if (busy) return;
    busy = true;
    api('/input.json', payload)
      .catch((error) => showToast(String(error.message || error)))
      .finally(() => { busy = false; refreshState(); });
  }

  function startStream() {
    clearTimeout(retry);
    frame.hidden = false;
    hint.hidden = true;
    frame.src = withToken(`/stream?n=${Date.now()}-${(streamNonce += 1)}`);
  }

  frame.addEventListener('load', () => {
    hint.hidden = true;
    setStatus('on', '已连接 · 实时画面');
  });
  frame.addEventListener('error', () => {
    if (frame.hidden) return;
    reportPanelError('stream failed');
    setStatus('err', '未连接或设备不可达');
    hint.hidden = false;
    hint.textContent = '连接失败：检查设备是否在线、账号密码是否正确。3 秒后重试…';
    frame.hidden = true;
    retry = setTimeout(startStream, 3000);
  });

  function comboForEvent(event) {
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === '' || MODIFIERS.has(key)) return null;
    if (key === 'Dead' || key === 'Unidentified' || key === 'Process') return null;
    const code = typeof event.code === 'string' ? event.code : '';
    let base = '';
    let fromCode = false;
    if (/^Key[A-Z]$/.test(code)) { base = code.slice(3).toLowerCase(); fromCode = true; }
    else if (/^Digit[0-9]$/.test(code)) { base = code.slice(5); fromCode = true; }
    else if (/^Numpad[0-9]$/.test(code)) { base = code.slice(6); fromCode = true; }
    else if (PUNCT[code]) { base = PUNCT[code]; fromCode = true; }
    else if (key === ' ') base = 'space';
    else if (key.length === 1) base = key;
    else if (NAMED.has(key) || /^F[0-9]{1,2}$/.test(key)) base = key;
    else return null;
    const parts = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.metaKey) parts.push('meta');
    if (event.shiftKey && (fromCode || base.length > 1)) parts.push('shift');
    parts.push(base);
    return parts.join('+');
  }

  stage.addEventListener('keydown', (event) => {
    const combo = comboForEvent(event);
    if (combo === null) return;
    event.preventDefault();
    if (event.repeat) return;
    sendInput({ action: 'key', keys: combo });
  });
  stage.addEventListener('keyup', (event) => {
    if (comboForEvent(event) !== null) event.preventDefault();
  });
  stage.addEventListener('focus', () => {
    if (frame.hidden) return;
    hint.hidden = true;
  });

  frame.addEventListener('pointermove', (event) => {
    lastPoint = pixelPoint(event) || lastPoint;
    if (dragStart !== null && !dragged) {
      const dx = event.clientX - dragStart.clientX;
      const dy = event.clientY - dragStart.clientY;
      if (Math.hypot(dx, dy) > 4) dragged = true;
    }
  });

  frame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 2) return;
    stage.focus();
    dragStart = { clientX: event.clientX, clientY: event.clientY, point: pixelPoint(event) };
    dragged = false;
  });

  frame.addEventListener('pointerup', (event) => {
    if (dragStart === null) return;
    const start = dragStart;
    dragStart = null;
    if (!dragged) return;
    const to = pixelPoint(event);
    if (!start.point || !to) return;
    sendInput({ action: 'drag', from_coordinate: start.point, to_coordinate: to });
  });

  frame.addEventListener('click', (event) => {
    if (dragged) { dragged = false; return; }
    const point = pixelPoint(event);
    if (!point) return;
    clickPoint = point;
    clearTimeout(clickTimer);
    // Delay one click so the second click of a double-click can replace it.
    clickTimer = setTimeout(() => sendInput({ action: 'click', coordinate: point }), 190);
  });

  frame.addEventListener('dblclick', (event) => {
    clearTimeout(clickTimer);
    const point = pixelPoint(event);
    if (point) sendInput({ action: 'double_click', coordinate: point });
  });

  frame.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const point = pixelPoint(event);
    if (point) sendInput({ action: 'right_click', coordinate: point });
  });

  frame.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = pixelPoint(event) || lastPoint;
    const tick = (value) => Math.max(1, Math.min(10, Math.round(Math.abs(value) / 40) || 1));
    if (Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      sendInput({ action: 'scroll', direction: event.deltaY > 0 ? 'down' : 'up', amount: tick(event.deltaY), ...(point ? { coordinate: point } : {}) });
    } else {
      sendInput({ action: 'scroll', direction: event.deltaX > 0 ? 'right' : 'left', amount: tick(event.deltaX), ...(point ? { coordinate: point } : {}) });
    }
  }, { passive: false });

  $('refresh').addEventListener('click', () => { hint.textContent = ''; startStream(); });
  $('fit').addEventListener('click', () => {
    fit = !fit;
    stage.classList.toggle('fit', fit);
    $('fit').classList.toggle('btn-on', fit);
    $('fit').setAttribute('aria-pressed', String(fit));
  });
  $('capture').addEventListener('click', () => window.open(withToken('/frame.jpg'), '_blank', 'noopener'));
  $('disconnect').addEventListener('click', async () => {
    try {
      await api('/input.json', { action: 'disconnect' });
      frame.hidden = true;
      frame.removeAttribute('src');
      hint.hidden = false;
      hint.textContent = '已断开。点「刷新画面」重新连接。';
      setStatus('', '已断开');
    } catch (error) {
      showToast(String(error.message || error));
    }
  });

  $('paste').addEventListener('click', () => {
    pasteBox.hidden = !pasteBox.hidden;
    if (!pasteBox.hidden) pasteText.focus();
  });
  $('paste-close').addEventListener('click', () => { pasteBox.hidden = true; });
  $('paste-send').addEventListener('click', async () => {
    const text = pasteText.value;
    if (text.trim() === '') return;
    const unicode = /[^\x00-\x7f]/.test(text);
    try {
      await api('/input.json', unicode ? { action: 'paste', text } : { action: 'type', text });
      showToast('已发送', true);
      pasteText.value = '';
      pasteBox.hidden = true;
    } catch (error) {
      showToast(String(error.message || error));
    }
  });

  function renderActivity(entries) {
    activityList.textContent = '';
    if (!Array.isArray(entries) || entries.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '暂无活动';
      activityList.appendChild(li);
      return;
    }
    for (const entry of entries) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      const when = Number(entry.at);
      time.textContent = Number.isFinite(when) ? new Date(when).toLocaleTimeString() : '';
      li.appendChild(time);
      li.appendChild(document.createTextNode(`${entry.action || ''}${entry.detail ? ` · ${entry.detail}` : ''}`));
      activityList.appendChild(li);
    }
  }

  async function refreshState() {
    try {
      const payload = await api('/state.json');
      const state = payload.state || {};
      if (state.connected) {
        setStatus('on', '已连接');
        metrics.textContent = [state.codec && state.codec.toUpperCase(), state.width && state.height ? `${state.width}×${state.height}` : '', state.fps ? `${state.fps} fps` : ''].filter(Boolean).join(' · ') || '—';
      } else if (!frame.hidden) {
        setStatus('warn', '等待画面…');
      }
      renderActivity(payload.activity);
    } catch {
      /* the panel itself is up; the stream error path reports device trouble */
    }
  }

  stage.classList.add('fit');
  startStream();
  refreshState();
  stateTimer = setInterval(refreshState, 2000);
  window.addEventListener('beforeunload', () => clearInterval(stateTimer));
})();
