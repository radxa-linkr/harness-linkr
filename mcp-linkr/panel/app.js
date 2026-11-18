/* MCP Apps JSON-RPC bridge; dependency-free, using the published UI protocol. */
(() => {
  const picture = Object.assign(document.createElement('img'), {
    id: 'picture',
    alt: 'Linkr 被控机实时画面',
    draggable: false,
    hidden: true,
  });
  const $ = (id) => (id === 'picture' ? picture : document.getElementById(id));
  const viewId = crypto.randomUUID();
  const pending = new Map();
  let nextId = 0,
    hostOrigin,
    ready = false,
    tearingDown = false,
    timer,
    heartbeat;
  let previewUrl = '',
    fallback = false,
    state = {},
    stopped = false,
    controlViewId = '',
    frameAt = 0;
  let busy = false,
    controlIntent = null,
    inputCount = 0,
    inputQueue = Promise.resolve(),
    pointerDown;
  let settingsInfo = null,
    settingsToken = '',
    settingsAvailable = false,
    settingsOpen = false,
    saving = false,
    fitWidth = true,
    revision = -1;
  let clipboard = null,
    clipboardProbeAt = 0,
    clipboardBusy = false;
  let guideDismissed = false;
  try {
    guideDismissed = localStorage.getItem('linkr-guide-dismissed') === '1';
  } catch {
    /* storage is optional */
  }
  const targetOrigin = () =>
    hostOrigin && hostOrigin !== 'null' ? hostOrigin : '*';
  const notify = (method, params = {}) =>
    window.parent.postMessage(
      { jsonrpc: '2.0', method, params },
      targetOrigin(),
    );
  function request(method, params, timeout = 30000) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('宿主响应超时，请重试或重新打开面板。'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(
        { jsonrpc: '2.0', id, method, params },
        targetOrigin(),
      );
    });
  }
  const controlling = () => controlViewId === viewId;
  const fresh = () =>
    state.connected && frameAt > 0 && Date.now() - frameAt < 3000;
  function fail(error) {
    $('error').textContent = error.message || String(error);
    $('error').hidden = false;
  }
  function hostContext(context) {
    if (context?.theme) {
      document.documentElement.style.colorScheme = context.theme;
      document.documentElement.dataset.theme = context.theme;
    }
    for (const [key, value] of Object.entries(
      context?.styles?.variables || {},
    )) {
      if (key.startsWith('--') && typeof value === 'string')
        document.documentElement.style.setProperty(key, value);
    }
    for (const side of ['top', 'right', 'bottom', 'left'])
      document.documentElement.style.setProperty(
        `--safe-${side}`,
        `${Math.max(0, Number(context?.safeAreaInsets?.[side]) || 0)}px`,
      );
  }
  function applyState(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.revision === 'number' && value.revision < revision) return;
    if (typeof value.revision === 'number' && value.revision !== revision) {
      revision = value.revision;
      clipboard = null;
      clipboardProbeAt = 0;
      frameAt = 0;
      picture.remove();
      picture.removeAttribute('src');
      pointerDown = null;
    }
    if (value.state) state = value.state;
    if (typeof value.stopped === 'boolean') stopped = value.stopped;
    if (typeof value.controlViewId === 'string')
      controlViewId = value.controlViewId;
    if (typeof value.frameAt === 'number') frameAt = value.frameAt;
    if (value.settings) settingsInfo = value.settings;
    if (Array.isArray(value.activity)) renderActivity(value.activity);
    render();
  }
  async function refreshClipboard() {
    if (!previewUrl || clipboardBusy || !state.connected || saving || stopped)
      return;
    if (Date.now() - clipboardProbeAt < 10000) return;
    clipboardBusy = true;
    clipboardProbeAt = Date.now();
    try {
      const response = await fetch(previewUrl + 'clipboard.json', {
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const value = await response.json();
      if (value.revision === revision) {
        clipboard = value.clipboard;
        render();
      }
    } catch {
      // Unknown capability is not proof that Linkrd is missing.
    } finally {
      clipboardBusy = false;
    }
  }
  function applyResult(result) {
    if (result?.isError)
      throw new Error(
        (result.content || [])
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('\n'),
      );
    const url = result?._meta?.linkr?.previewUrl;
    if (
      typeof url === 'string' &&
      /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/$/.test(url)
    )
      previewUrl = url;
    const token = result?._meta?.linkr?.settingsToken;
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token))
      settingsToken = token;
    applyState(result?.structuredContent);
    return result;
  }
  async function tool(name, args = {}) {
    return applyResult(await request('tools/call', { name, arguments: args }));
  }
  function renderActivity(entries) {
    $('activity-empty').hidden = entries.length > 0;
    $('activity-list').replaceChildren(
      ...entries.slice(0, 6).map((entry) => {
        const li = document.createElement('li'),
          time = document.createElement('time'),
          action = document.createElement('span'),
          detail = document.createElement('span');
        time.textContent = new Date(entry.at).toLocaleTimeString('zh-CN', {
          hour12: false,
        });
        action.textContent = entry.action;
        detail.textContent = entry.detail;
        detail.className = 'detail';
        li.append(time, action, detail);
        return li;
      }),
    );
  }
  function fillSettings() {
    if (!settingsInfo) return;
    for (const [id, key, fallback] of [
      ['base-url', 'baseUrl', ''],
      ['username', 'username', ''],
      ['codec', 'codec', 'auto'],
      ['fps', 'streamFps', 20],
      ['jpeg-quality', 'jpegQuality', 4],
      ['ffmpeg-path', 'ffmpegPath', ''],
    ])
      $(id).value = settingsInfo[key] ?? fallback;
    $('password').value = '';
    updatePasswordHint();
  }
  function updatePasswordHint() {
    let same = false;
    try {
      same =
        new URL($('base-url').value).origin ===
          new URL(settingsInfo?.baseUrl).origin &&
        $('username').value.trim() === settingsInfo.username;
    } catch {
      /* incomplete address */
    }
    const keep = Boolean(settingsInfo?.passwordSaved && same);
    $('password').required = !keep;
    $('password').placeholder = keep ? '留空 = 保持不变' : '请输入设备密码';
    $('password-note').textContent = keep
      ? '已保存密码，此处不回显。'
      : '密码仅保存在本机，不会回显。';
  }
  async function loadSettings() {
    if (!previewUrl || !settingsToken)
      throw new Error('本机登录服务尚未就绪，请重新打开面板。');
    const response = await fetch(previewUrl + 'settings.json', {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error('无法读取登录设置，请重新打开面板。');
    settingsInfo = await response.json();
    settingsAvailable = true;
    fillSettings();
  }
  async function openSettings() {
    settingsOpen = true;
    $('settings-error').hidden = true;
    render();
    try {
      await loadSettings();
    } catch {
      settingsAvailable = false;
      $('settings-error').textContent =
        '当前宿主无法访问本机登录服务，请更新桌面端后重试。';
      $('settings-error').hidden = false;
    }
    render();
  }
  async function submitSettings(path, body) {
    if (saving || !settingsAvailable) return;
    saving = true;
    $('settings-error').hidden = true;
    render();
    try {
      const response = await fetch(previewUrl + path, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          'Content-Type': 'application/json',
          'X-Linkr-Panel-Token': settingsToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const payload = await response.json();
      applyState(payload);
      if (!response.ok || !payload.ok)
        throw new Error(payload.error || '无法保存登录设置，请重试。');
      fillSettings();
      settingsOpen = path === 'logout';
      if (path !== 'logout') {
        $('saved').textContent = '已登录，设置已保存在本机。';
        $('saved').hidden = false;
      }
    } catch (error) {
      $('settings-error').textContent =
        error.message || '无法连接本机登录服务，请重试。';
      $('settings-error').hidden = false;
    } finally {
      saving = false;
      render();
    }
  }
  async function command(action) {
    if (busy) return;
    if (action === 'take_control') controlIntent = true;
    if (action === 'release_control' || action === 'stop')
      controlIntent = false;
    busy = true;
    $('error').hidden = true;
    render();
    try {
      await tool('linkr_panel', { action, viewId });
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
      controlIntent = null;
      render();
    }
  }
  function render() {
    const live = Boolean(state.connected),
      manual = controlling(),
      current = fresh();
    $('viewer').hidden = settingsOpen;
    $('settings-view').hidden = !settingsOpen;
    $('settings-title').textContent = settingsInfo?.passwordSaved
      ? '设备设置'
      : '登录 Linkr';
    $('settings').disabled = !ready || busy || saving;
    $('save-settings').textContent = saving
      ? '正在登录…'
      : settingsInfo?.passwordSaved
        ? '保存并连接'
        : '登录并连接';
    $('login-form')
      .querySelectorAll('input, select, button')
      .forEach((el) => {
        el.disabled = saving;
      });
    $('save-settings').disabled = saving || !settingsAvailable;
    $('close-settings').disabled = saving;
    $('logout').hidden = !settingsInfo?.passwordSaved;
    const configured = Boolean(settingsInfo?.passwordSaved || state.configured);
    $('device-name').textContent =
      state.device?.deviceName || settingsInfo?.username || 'Linkr';
    $('connection').textContent = live
      ? current
        ? '实时'
        : '等待画面'
      : stopped
        ? '已断开'
        : configured
          ? '未连接'
          : '未登录';
    $('status-dot').classList.toggle('live', live && current);
    const clipboardReasons = {
      unconfigured: '设备尚未配置',
      disabled: 'Linkrd 未安装或未启用',
      disconnected: 'Linkrd 程序尚未连接设备',
      unsupported: '当前版本不支持剪贴板',
      'device-error': '设备返回错误',
    };
    $('clipboard-status').hidden = !live || !clipboard || clipboard.available;
    $('clipboard-status').title =
      clipboardReasons[clipboard?.reason] || '剪贴板不可用';
    $('clipboard-status').setAttribute(
      'aria-label',
      `剪贴板 不可用：${$('clipboard-status').title}`,
    );
    $('start').hidden = live;
    $('start').textContent = configured ? '连接' : '登录设备';
    $('start').disabled = !ready || busy || live || saving;
    $('stop').hidden = !live;
    $('stop').disabled = !ready || busy || saving;
    $('capture').disabled = !ready || busy || !current;
    $('paste-toggle').disabled = !manual || !current || busy;
    $('takeover').disabled =
      !ready || busy || !current || Boolean(controlViewId && !manual);
    $('takeover').checked = controlIntent ?? manual;
    $('control-state').textContent = manual
      ? '已接管 · Esc 退出'
      : controlViewId
        ? '其他面板正在接管'
        : '只观看';
    $('control-state').classList.toggle('active', manual);
    $('control-hint').textContent = manual
      ? 'Agent 输入已暂停。点击画面后可用键盘；Esc 退出接管。'
      : '开启后可点击、拖动、滚动和输入，Agent 将暂停输入。';
    $('keyboard').hidden = !manual;
    $('screen').classList.toggle('controlling', manual && current);
    $('screen').classList.toggle('stale', !current);
    $('screen-state').hidden = current;
    $('screen-title').textContent = live
      ? '画面暂停'
      : stopped
        ? '已断开连接'
        : configured
          ? '等待连接'
          : '登录 Linkr';
    $('screen-hint').textContent = live
      ? '正在等待新的画面。可断开后重新连接。'
      : configured
        ? ''
        : '在设置中输入设备地址、用户名和密码。';
    $('screen-hint').hidden = !$('screen-hint').textContent;
    $('frame-info').textContent =
      live && state.width
        ? `${state.codec === 'h264' ? 'H.264' : 'MJPEG'} · ${state.width}×${state.height} · ${state.fps || 0} fps`
        : '尚无画面';
    $('transport').textContent = live
      ? fallback
        ? '兼容预览 · 最高 2 fps'
        : current
          ? `新帧 ${Math.max(0, Date.now() - frameAt)} ms 前`
          : ''
      : '';
    if (!live || saving) {
      picture.remove();
      picture.removeAttribute('src');
      picture.hidden = true;
    } else if (!fallback && previewUrl && !picture.getAttribute('src')) {
      picture.hidden = false;
      picture.src = `${previewUrl}live.mjpeg`;
    }
    if (
      live &&
      !saving &&
      picture.getAttribute('src') &&
      !picture.parentElement
    )
      $('screen').prepend(picture);
    $('screen').classList.toggle('natural-size', !fitWidth && live);
    $('screen').style.aspectRatio =
      !fitWidth && live
        ? 'auto'
        : live && state.width
          ? `${state.width} / ${state.height}`
          : '16 / 9';
    picture.style.width = !fitWidth && live ? `${state.width}px` : '';
    picture.style.height = !fitWidth && live ? `${state.height}px` : '';
    $('guide').hidden = guideDismissed;
    for (const id of ['open-console', 'install-linkrd'])
      $(id).disabled = !/^https?:\/\//.test(
        state.origin || settingsInfo?.baseUrl || '',
      );
    if (state.error && !$('error').textContent) fail(new Error(state.error));
  }
  async function refresh() {
    if (tearingDown) return;
    try {
      if (!document.hidden) {
        if (!fallback && previewUrl) {
          try {
            const response = await fetch(`${previewUrl}status.json`, {
              cache: 'no-store',
              signal: AbortSignal.timeout(2500),
            });
            if (!response.ok) throw new Error('preview unavailable');
            applyState(await response.json());
          } catch {
            fallback = true;
            $('picture').removeAttribute('src');
          }
        }
        if (fallback || !previewUrl) {
          const result = await tool('linkr_panel_frame');
          const image = result.content?.find((item) => item.type === 'image');
          if (
            image &&
            state.connected &&
            result.structuredContent?.revision === revision
          ) {
            $('picture').src = `data:${image.mimeType};base64,${image.data}`;
            $('picture').hidden = false;
          }
        }
        void refreshClipboard();
      }
    } catch (error) {
      fail(error);
    } finally {
      render();
      timer = setTimeout(refresh, fallback ? 500 : 1000);
    }
  }
  $('picture').addEventListener('error', () => {
    if (state.connected && !fallback && !saving) {
      fallback = true;
      $('picture').removeAttribute('src');
    }
  });
  async function sendInput(args) {
    if (!controlling() || !fresh() || tearingDown || controlIntent === false)
      return;
    if (inputCount >= 8) {
      fail(new Error('输入正在处理中，请稍候。'));
      return;
    }
    inputCount += 1;
    inputQueue = inputQueue
      .then(async () => {
        if (controlling() && fresh())
          await tool('linkr_panel_input', { ...args, viewId });
      })
      .catch(fail)
      .finally(() => {
        inputCount -= 1;
      });
    return inputQueue;
  }
  function point(event) {
    const rect = (fitWidth ? $('screen') : picture).getBoundingClientRect();
    const width = Number(state.width),
      height = Number(state.height);
    if (!width || !height) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    const x =
      (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale;
    const y =
      (event.clientY - rect.top - (rect.height - height * scale) / 2) / scale;
    return x >= 0 && y >= 0 && x <= width && y <= height
      ? [Math.round(x), Math.round(y)]
      : null;
  }
  $('start').onclick = () =>
    settingsInfo?.passwordSaved || state.configured
      ? command('start')
      : openSettings();
  $('stop').onclick = () => command('stop');
  $('settings').onclick = () => openSettings();
  $('close-settings').onclick = () => {
    if (!saving) {
      settingsOpen = false;
      $('password').value = '';
      render();
    }
  };
  $('base-url').oninput = updatePasswordHint;
  $('username').oninput = updatePasswordHint;
  // MCP App sandboxes need not grant allow-forms. Keep validation, use an explicit request.
  const login = () => {
    if (!$('login-form').reportValidity()) return;
    void submitSettings('settings', {
      baseUrl: $('base-url').value.trim(),
      username: $('username').value.trim(),
      password: $('password').value,
      codec: $('codec').value,
      streamFps: Number($('fps').value),
      jpegQuality: Number($('jpeg-quality').value),
      ffmpegPath: $('ffmpeg-path').value.trim(),
    });
  };
  $('login-form').onsubmit = (event) => event.preventDefault();
  $('save-settings').onclick = login;
  $('login-form').onkeydown = (event) => {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      login();
    }
  };
  $('logout').onclick = () => submitSettings('logout', {});
  $('fit').onclick = () => {
    fitWidth = !fitWidth;
    $('fit').setAttribute('aria-pressed', String(fitWidth));
    render();
  };
  $('paste-toggle').onclick = () => {
    if (controlling()) $('text').focus();
  };
  const openConsole = () =>
    request('ui/open-link', {
      url: state.origin || settingsInfo?.baseUrl,
    }).catch(fail);
  $('open-console').onclick = openConsole;
  $('install-linkrd').onclick = openConsole;
  $('dismiss-guide').onclick = () => {
    guideDismissed = true;
    try {
      localStorage.setItem('linkr-guide-dismissed', '1');
    } catch {
      /* optional */
    }
    render();
  };
  $('show-guide').onclick = () => {
    settingsOpen = false;
    guideDismissed = false;
    render();
    $('guide').scrollIntoView({ block: 'nearest' });
  };
  $('takeover').onchange = async (event) => {
    await command(event.target.checked ? 'take_control' : 'release_control');
    if (controlling()) $('screen').focus();
  };
  $('capture').onclick = async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = await tool('linkr_computer_use', { action: 'capture' });
      $('saved').textContent =
        `截图已保存：${result.structuredContent?.path || '查看工具结果'}`;
      $('saved').hidden = false;
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
      render();
    }
  };
  $('screen').onpointerdown = (event) => {
    if (!controlling() || !fresh() || ![0, 2].includes(event.button)) return;
    const coordinate = point(event);
    if (!coordinate) return;
    event.preventDefault();
    $('screen').focus();
    $('screen').setPointerCapture(event.pointerId);
    pointerDown = {
      coordinate,
      button: event.button,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  };
  $('screen').onpointerup = (event) => {
    const down = pointerDown;
    pointerDown = null;
    if (!down || down.pointerId !== event.pointerId || !controlling()) return;
    const coordinate = point(event);
    if (!coordinate) return;
    event.preventDefault();
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5)
      void sendInput({
        action: 'drag',
        from_coordinate: down.coordinate,
        to_coordinate: coordinate,
        button: down.button === 2 ? 'right' : 'left',
      });
    else
      void sendInput({
        action: down.button === 2 ? 'right_click' : 'click',
        coordinate,
      });
  };
  $('screen').onpointercancel = () => {
    pointerDown = null;
  };
  $('screen').oncontextmenu = (event) => {
    if (controlling()) event.preventDefault();
  };
  let wheel = null,
    wheelTimer;
  $('screen').addEventListener(
    'wheel',
    (event) => {
      if (!controlling() || !fresh()) return;
      const coordinate = point(event);
      if (!coordinate) return;
      event.preventDefault();
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = horizontal ? event.deltaX : event.deltaY;
      if (!delta) return;
      const direction = horizontal
        ? delta > 0
          ? 'right'
          : 'left'
        : delta > 0
          ? 'down'
          : 'up';
      wheel = {
        action: 'scroll',
        direction,
        coordinate,
        amount: Math.min(
          10,
          (wheel?.direction === direction ? wheel.amount : 0) +
            Math.max(
              1,
              Math.ceil(Math.abs(delta) / (event.deltaMode === 0 ? 80 : 1)),
            ),
        ),
      };
      if (!wheelTimer)
        wheelTimer = setTimeout(() => {
          const args = wheel;
          wheel = null;
          wheelTimer = null;
          void sendInput(args);
        }, 100);
    },
    { passive: false },
  );
  $('screen').onkeydown = (event) => {
    if (!controlling() || !fresh()) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      void command('release_control');
      return;
    }
    if (
      [
        'Control',
        'Alt',
        'Shift',
        'Meta',
        'Dead',
        'Process',
        'Unidentified',
      ].includes(event.key) ||
      event.isComposing
    )
      return;
    const names = {
      ' ': 'space',
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };
    const keys = [
      ...(event.ctrlKey ? ['ctrl'] : []),
      ...(event.altKey ? ['alt'] : []),
      ...(event.shiftKey ? ['shift'] : []),
      ...(event.metaKey ? ['meta'] : []),
      names[event.key] || event.key,
    ].join('+');
    void sendInput({ action: 'key', keys });
  };
  document.querySelectorAll('[data-key]').forEach((button) => {
    button.onclick = () =>
      sendInput({ action: 'key', keys: button.dataset.key });
  });
  const sendText = async () => {
    const text = $('text').value;
    if (!text || !controlling()) return;
    await sendInput({
      action: /^[\x00-\x7f]*$/.test(text) ? 'type' : 'paste',
      text,
    });
  };
  $('text-form').onsubmit = (event) => event.preventDefault();
  $('send-text').onclick = sendText;
  $('text').onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendText();
    }
  };
  async function teardown() {
    tearingDown = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    clearTimeout(wheelTimer);
    $('picture').removeAttribute('src');
    pointerDown = null;
    if (controlling())
      await tool('linkr_panel', { action: 'release_control', viewId }).catch(
        () => {},
      );
  }
  window.addEventListener('message', async (event) => {
    if (
      event.source !== window.parent ||
      (hostOrigin && event.origin !== hostOrigin)
    )
      return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    const waiter = pending.get(msg.id);
    if (waiter && ('result' in msg || 'error' in msg)) {
      hostOrigin = event.origin;
      clearTimeout(waiter.timer);
      pending.delete(msg.id);
      if (msg.error)
        waiter.reject(new Error(msg.error.message || '宿主调用失败'));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result') {
      try {
        applyResult(msg.params);
      } catch (error) {
        fail(error);
      }
    } else if (msg.method === 'ui/notifications/host-context-changed')
      hostContext(msg.params);
    else if (msg.method === 'ui/resource-teardown') {
      await teardown();
      window.parent.postMessage(
        { jsonrpc: '2.0', id: msg.id, result: {} },
        targetOrigin(),
      );
    } else if (msg.method === 'ping' && msg.id != null)
      window.parent.postMessage(
        { jsonrpc: '2.0', id: msg.id, result: {} },
        targetOrigin(),
      );
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && controlling())
      void tool('linkr_panel', { action: 'release_control', viewId }).catch(
        fail,
      );
  });
  (async () => {
    try {
      const init = await request(
        'ui/initialize',
        {
          protocolVersion: '2026-01-26',
          appInfo: { name: 'codex-linkr-screen', version: '0.3.1' },
          appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
        },
        10000,
      );
      hostContext(init.hostContext);
      notify('ui/notifications/initialized');
      ready = true;
      await tool('linkr_panel', {});
      render();
      void refresh();
      try {
        await loadSettings();
        if (
          !settingsInfo.passwordSaved ||
          !settingsInfo.baseUrl ||
          !settingsInfo.username
        )
          settingsOpen = true;
      } catch {
        /* A preconfigured server can still use the MCP preview fallback. */
      }
      render();
      heartbeat = setInterval(() => {
        if (controlling() && !tearingDown)
          void tool('linkr_panel', { action: 'heartbeat', viewId }).catch(fail);
      }, 5000);
    } catch (error) {
      fail(error);
      $('screen-title').textContent = '无法连接宿主';
      $('screen-hint').textContent =
        '请更新桌面端、启用 Linkr 插件后重新打开面板。';
    }
  })();
})();
