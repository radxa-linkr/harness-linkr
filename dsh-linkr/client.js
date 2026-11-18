/**
 * Client half of the dsh-linkr bundle: the live screen of the host computer
 * behind a Linkr KVM device, in the Web UI's right column.
 *
 * The picture is the Host's own MJPEG route (`GET /linkr/live.mjpeg`), so what
 * the user watches is the very frame the agent's `linkr_screen` sees. Pointer
 * and keyboard input travel back through `POST /linkr/input`, the same call the
 * agent's tools make: one session, one input path, two callers.
 *
 * Plain JavaScript on purpose — no build step, no framework, and no Harness
 * Client package is imported. React comes from the page's module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-linkr',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback } = React;

    const name = 'dsh-linkr';
    // Only the two kernel services are required. The right column's own
    // services are joined through ctx.inject() in apply(), so a shell without a
    // right sidebar never drops this plugin.
    const inject = ['slots', 'locale'];
    const NS = 'dsh-linkr';
    const KIND = 'dsh-linkr';

    /* ---------------- the Host routes this panel uses ---------------- */

    const STATE_URL = '/linkr/state';
    const CONFIG_URL = '/linkr/config';
    const CONNECT_URL = '/linkr/connect';
    const DISCONNECT_URL = '/linkr/disconnect';
    const INPUT_URL = '/linkr/input';
    // Clipboard route added in round 10: write text on the controlled machine,
    // optionally press a paste chord for it. Only used for non-ASCII text.
    const CLIPBOARD_URL = '/linkr/clipboard';
    const LIVE_URL = '/linkr/live.mjpeg';
    // Control, not content: the agent's open/focus/close arrive here.
    const PANEL_URL = '/linkr/panel/stream';
    // The Host's activity ring: read once for history, then fed by the channel.
    const LOG_URL = '/linkr/log';

    const POLL_MS = 1000;
    const MOVE_MS = 33; // ~30 pointer moves a second
    const CLICK_MS = 220; // a second press inside this window is a double click
    const RETRY_MS = 900;
    const RETRY_MAX_MS = 8000;
    const DRAG_SLOP = 3; // px before a press becomes a drag
    const STALE_READ_MS = 1500; // a state read older than our Connect may lie about it
    const LOG_LIMIT = 100; // the Host keeps 100; the panel shows the newest 100

    /* ---------------- the Linkrd install guide (CONTRACT §15) ----------------
     * Advice, not state: the panel asks about Linkrd once and then stays quiet.
     * The choice lives in localStorage because it is a preference of this
     * browser, not of the device or the profile; a shell that blocks storage
     * simply sees the guide every session instead of failing.
     */
    const GUIDE_KEY = 'dsh-linkr.linkrd-guide';
    const GUIDE_HIDDEN = 'hidden';
    const readGuidePref = () => {
      try {
        return typeof window === 'undefined' ? null : window.localStorage.getItem(GUIDE_KEY);
      } catch {
        return null;
      }
    };
    const writeGuidePref = (value) => {
      try {
        if (typeof window !== 'undefined') window.localStorage.setItem(GUIDE_KEY, value);
      } catch {
        /* private mode or a storage-less shell: the guide just stays as it is */
      }
    };

    /* ---------------- copy ----------------
     * The same text lives in locale/en.json and locale/zh.json, which the
     * Harness reads for the plugin's own title and description. A plain-JS
     * client artifact cannot import JSON at runtime, so the dictionaries are
     * repeated here; keep the three in step when copy changes.
     */
    const zh = {
      title: '电脑',
      guideTitle: 'Linkr 共享电脑',
      guide: '共享电脑的实时画面，以及 Linkr 完整控制台。',
      openLinkr: '打开 Linkr',
      viewHint: '共享电脑的实时画面；登录与设备管理请在「打开 Linkr」里进行。',
      // The Linkrd install guide (CONTRACT §15). Optional advice, never a
      // blocker: the picture and the keyboard path work without the plugin.
      guideLinkrdTitle: '安装 Linkrd（可选）',
      guideLinkrdBody: '装上后可直连中文粘贴、读回被控机剪贴板，并通过虚拟磁盘投文件；不装也能正常用画面和键鼠。',
      guideLinkrdBenefit1: '中文 / 多行文本一次粘贴',
      guideLinkrdBenefit2: '读回被控机剪贴板',
      guideLinkrdBenefit3: '虚拟磁盘投文件',
      guideLinkrdStepsTitle: '被控机三步',
      guideLinkrdStep1: '设备控制台 → 插件中心，安装并启用 Linkrd',
      guideLinkrdStep2: '挂载 Linkrd.img',
      guideLinkrdStep3: '运行 Linkrd 并保持运行',
      guideLinkrdNote: '终端里粘贴用「仅写入剪贴板」+ Ctrl+Shift+V。',
      guideLinkrdInstall: '打开 Linkr 安装',
      guideLinkrdDismiss: '不再提示',
      guideLinkrdMore: 'Linkrd 安装指引',
      encoding: '编码格式',
      encodingAuto: '自动：能解码就用 H.264',
      encodingMjpeg: 'MJPEG',
      encodingH264: 'H.264',
      frameRate: '帧率',
      frameRateHint: '1–60，越大越流畅，也越占带宽；MJPEG 源约 37 帧封顶。',
      jpegQuality: 'JPEG 质量',
      jpegQualityHint: '仅影响 H.264 路径（-q:v）。',
      ffmpegPath: 'ffmpeg 路径',
      ffmpegPathHint: '留空 = 自动查找',
      validateInteger: '{label} 需要 {min}–{max} 的整数',
      activityTitle: '最近活动',
      activityEmpty: '还没有调用记录',
      actionScreen: '截屏',
      actionMouse: '鼠标',
      actionKey: '按键',
      actionType: '输入',
      actionPanel: '面板',
      actionStatus: '状态',
      actionConnect: '连接',
      actionDisconnect: '断开',
      actionConfig: '设置',
      actionSession: '会话',
      actionDevice: '设备',
      actionError: '错误',
      paste: '粘贴',
      pasteSend: '发送',
      pasteHint: '在此输入要发送的文字',
      pasteSent: '已粘贴 {count} 个字符',
      pasteEmpty: '没有可发送的文字',
      // The clipboard path: the only one that can carry non-ASCII text.
      pasteClipboardSent: '已用剪贴板粘贴 {count} 个字符',
      pasteClipboardFailed: '无法用剪贴板粘贴：{reason}',
      clipboardWriteOnly: '仅写入剪贴板',
      clipboardWriteOnlyDone: '已写入被控机剪贴板，可在终端里用 Ctrl+Shift+V 粘贴',
      clipboardWriteFailed: '无法写入被控机剪贴板：{reason}',
      clipboardTerminalHint: '终端窗口请用 Ctrl+Shift+V 粘贴',
      // Capability line. The reason codes are the Host's, not English prose.
      clipboardUnavailable: '剪贴板 不可用',
      clipboardReasonUnconfigured: '设备尚未配置',
      clipboardReasonDisabled: 'Linkrd 未安装或未启用',
      clipboardReasonDisconnected: 'Linkrd 程序尚未连接设备',
      clipboardReasonUnsupported: '当前版本不支持剪贴板',
      clipboardReasonDeviceError: '设备返回错误',
      logCapture: '截屏 {size}',
      logClick: '点击 ({point})',
      logDoubleClick: '双击 ({point})',
      logRightClick: '右键 ({point})',
      logMove: '移动到 ({point})',
      logScrollUp: '滚动 上 {lines}',
      logScrollDown: '滚动 下 {lines}',
      logDrag: '拖拽 ({from}) → ({to})',
      logKey: '按 {combo}',
      logType: '输入 {count} 个字符',
      logPanelOpen: '打开面板',
      logPanelFocus: '聚焦面板',
      logPanelClose: '关闭面板',
      logStatus: '查看状态',
      stateReading: '正在读取状态…',
      stateUnconfigured: '尚未配置',
      stateUnconfiguredHint: '在设置中填写设备地址、用户名和密码，然后连接。',
      stateConnecting: '正在连接…',
      stateLive: '实时',
      stateStopped: '未连接',
      stateDeviceError: '设备错误',
      stateHostDown: 'Linkr 接口无响应',
      statePaused: '面板已关闭',
      statePausedHint: '重新打开此标签页即可恢复画面。',
      statePictureOff: '画面已停止',
      statePictureOffHint: '会话仍在运行，但面板没有在显示。点“连接”或“刷新画面”恢复。',
      waitingFrame: '等待画面…',
      streamLost: '画面中断，正在重试…',
      device: '设备',
      resolution: '分辨率',
      fps: '帧率',
      connect: '连接',
      disconnect: '断开',
      refreshPicture: '刷新画面',
      fitWidth: '适应宽度',
      settings: '设置',
      close: '关闭',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败',
      loading: '读取配置…',
      baseUrl: '设备地址',
      baseUrlHint: 'http://linkr.local',
      username: '用户名',
      password: '密码',
      passwordStored: '已保存密码，此处不回显。',
      passwordKeep: '留空 = 保持不变',
      configHint: '保存后按新地址重新连接设备。',
      hintAgent: 'Agent 看到并操控的是同一块屏幕。',
      focusHint: '点击画面即可把按键和鼠标发给主机。',
      paneLabel: '主机实时画面',
      actionFailed: '请求没有送达设备',
    };
    const en = {
      title: 'Computer',
      guideTitle: 'Linkr shared computer',
      guide: "The shared machine's picture, plus the full Linkr console.",
      openLinkr: 'Open Linkr',
      viewHint: "The shared computer's live picture. Sign in and change device settings in Open Linkr.",
      guideLinkrdTitle: 'Install Linkrd (optional)',
      guideLinkrdBody: 'Adds Unicode paste, clipboard read-back and file drop here. The picture and keyboard work without it.',
      guideLinkrdBenefit1: 'Paste Chinese and multi-line text at once',
      guideLinkrdBenefit2: 'Read the remote clipboard back',
      guideLinkrdBenefit3: 'Drop files through a virtual disk',
      guideLinkrdStepsTitle: 'Three steps there',
      guideLinkrdStep1: 'Device console → Plugins: install and enable Linkrd',
      guideLinkrdStep2: 'Mount Linkrd.img',
      guideLinkrdStep3: 'Run Linkrd and keep it running',
      guideLinkrdNote: 'In a terminal, use "clipboard only" + Ctrl+Shift+V.',
      guideLinkrdInstall: 'Open Linkr to install',
      guideLinkrdDismiss: 'Do not show again',
      guideLinkrdMore: 'Linkrd install guide',
      encoding: 'Encoding',
      encodingAuto: 'Auto: H.264 when it can decode',
      encodingMjpeg: 'MJPEG',
      encodingH264: 'H.264',
      frameRate: 'Frame rate',
      frameRateHint: '1–60; smoother costs more bandwidth (the MJPEG source tops out near 37).',
      jpegQuality: 'JPEG quality',
      jpegQualityHint: 'Only affects the H.264 path (-q:v).',
      ffmpegPath: 'ffmpeg path',
      ffmpegPathHint: 'empty = auto-detect',
      validateInteger: '{label} needs a whole number from {min} to {max}',
      activityTitle: 'Recent activity',
      activityEmpty: 'No Linkr activity yet.',
      actionScreen: 'Capture',
      actionMouse: 'Mouse',
      actionKey: 'Key',
      actionType: 'Type',
      actionPanel: 'Panel',
      actionStatus: 'Status',
      actionConnect: 'Connect',
      actionDisconnect: 'Disconnect',
      actionConfig: 'Settings',
      actionSession: 'Session',
      actionDevice: 'Device',
      actionError: 'Error',
      paste: 'Paste',
      pasteSend: 'Send',
      pasteHint: 'Type the text to send',
      pasteSent: 'Pasted {count} characters',
      pasteEmpty: 'Nothing to send',
      pasteClipboardSent: 'Pasted {count} characters through the clipboard',
      pasteClipboardFailed: 'Could not paste through the clipboard: {reason}',
      clipboardWriteOnly: 'Write to clipboard only',
      clipboardWriteOnlyDone: "Written to the controlled machine's clipboard; paste it in a terminal with Ctrl+Shift+V",
      clipboardWriteFailed: "Could not write to the controlled machine's clipboard: {reason}",
      clipboardTerminalHint: 'In a terminal window, paste with Ctrl+Shift+V',
      clipboardUnavailable: 'Clipboard unavailable',
      clipboardReasonUnconfigured: 'the device is not configured',
      clipboardReasonDisabled: 'Linkrd is not installed or not enabled',
      clipboardReasonDisconnected: 'Linkrd is not connected',
      clipboardReasonUnsupported: 'this version does not support the clipboard',
      clipboardReasonDeviceError: 'the device returned an error',
      logCapture: 'Capture {size}',
      logClick: 'Click ({point})',
      logDoubleClick: 'Double-click ({point})',
      logRightClick: 'Right-click ({point})',
      logMove: 'Moved to ({point})',
      logScrollUp: 'Scroll up {lines}',
      logScrollDown: 'Scroll down {lines}',
      logDrag: 'Drag ({from}) → ({to})',
      logKey: 'Press {combo}',
      logType: 'Typed {count} characters',
      logPanelOpen: 'Opened the panel',
      logPanelFocus: 'Focused the panel',
      logPanelClose: 'Closed the panel',
      logStatus: 'Checked status',
      stateReading: 'Reading state…',
      stateUnconfigured: 'Not configured yet',
      stateUnconfiguredHint: 'Set the device address, username and password in settings, then connect.',
      stateConnecting: 'Connecting…',
      stateLive: 'Live',
      stateStopped: 'Not connected',
      stateDeviceError: 'Device error',
      stateHostDown: 'The Linkr routes did not answer',
      statePaused: 'Panel closed',
      statePausedHint: 'Open this tab again to bring the picture back.',
      statePictureOff: 'Picture stopped',
      statePictureOffHint: 'A session is live, but this panel is not watching it. Press Connect or Refresh picture to resume.',
      waitingFrame: 'Waiting for the first frame…',
      streamLost: 'The live stream stopped; retrying…',
      device: 'Device',
      resolution: 'Resolution',
      fps: 'FPS',
      connect: 'Connect',
      disconnect: 'Disconnect',
      refreshPicture: 'Refresh picture',
      fitWidth: 'Fit width',
      settings: 'Settings',
      close: 'Close',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed',
      loading: 'Reading config…',
      baseUrl: 'Device address',
      baseUrlHint: 'http://linkr.local',
      username: 'Username',
      password: 'Password',
      passwordStored: 'A password is stored and is never shown here.',
      passwordKeep: 'empty = keep current',
      configHint: 'Saving applies the new address and restarts the live session.',
      hintAgent: 'The agent sees and controls the same screen.',
      focusHint: 'Click the screen to send keys and pointer input to the host computer.',
      paneLabel: 'Live host screen',
      actionFailed: 'That request did not reach the device',
    };

    /**
     * Guide/door glyph: a screen with a pointer arrow on it — the panel is a
     * window onto a machine you can also act on.
     */
    function LinkrGlyph({ size = 22, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          'aria-hidden': 'true',
        },
        h('rect', { x: 2.6, y: 4.2, width: 18.8, height: 12.6, rx: 2.1 }),
        h('path', { d: 'M8.4 20.2h7.2' }),
        h('path', { d: 'M12 16.8v3.4' }),
        h('path', { d: 'M7.4 8.2l2.4 6.1 1.5-2.3 2.5-.8z' }),
      );
    }

    /* ---------------- small helpers ---------------- */

    let nonceSeq = 0;
    /** A fresh stream name: a new one reconnects the picture without a reload. */
    function makeNonce() {
      nonceSeq += 1;
      return Date.now().toString(36) + '-' + nonceSeq.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function round4(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.round(n * 10000) / 10000;
    }

    function clamp01(value) {
      if (!Number.isFinite(value)) return 0;
      return value < 0 ? 0 : value > 1 ? 1 : value;
    }

    /**
     * Map a pointer position onto the picture, 0..1 of the frame.
     *
     * The element box and the painted picture are not the same box: `contain`
     * letterboxes, so the drawn image is centred inside the element and the dark
     * bars around it must not count. Measuring the natural size against the
     * element rect gives that inner box, and it stays right whether the element
     * box exactly matches the picture (auto-sized) or is larger (stretched).
     */
    function mapPoint(image, clientX, clientY) {
      if (!image) return null;
      const rect = image.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return null;
      const naturalWidth = image.naturalWidth || 0;
      const naturalHeight = image.naturalHeight || 0;
      let width = rect.width;
      let height = rect.height;
      let left = rect.left;
      let top = rect.top;
      if (naturalWidth > 0 && naturalHeight > 0) {
        const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
        width = naturalWidth * scale;
        height = naturalHeight * scale;
        left = rect.left + (rect.width - width) / 2;
        top = rect.top + (rect.height - height) / 2;
      }
      const x = (clientX - left) / width;
      const y = (clientY - top) / height;
      return {
        x: clamp01(x),
        y: clamp01(y),
        inside: x >= -0.01 && x <= 1.01 && y >= -0.01 && y <= 1.01,
      };
    }

    /**
     * The Host's short action buckets, named in the reader's language. A token
     * this build does not know is shown as it arrived, so a newer or older Host
     * never leaves a blank cell.
     */
    const ACTION_LABELS = {
      linkr_screen: 'actionScreen',
      linkr_mouse: 'actionMouse',
      linkr_key: 'actionKey',
      linkr_type: 'actionType',
      linkr_panel: 'actionPanel',
      linkr_status: 'actionStatus',
      connect: 'actionConnect',
      disconnect: 'actionDisconnect',
      config: 'actionConfig',
      session: 'actionSession',
      device: 'actionDevice',
      error: 'actionError',
    };

    function actionLabel(t, action) {
      const key = ACTION_LABELS[action];
      return key === undefined ? action : t(key);
    }

    const MODIFIER_LABELS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };

    /** `ctrl+alt+t` → `Ctrl+Alt+T`, the way a key chord is written. */
    function comboLabel(combo) {
      if (typeof combo !== 'string' || combo === '') return '';
      const parts = [];
      for (const raw of combo.split('+')) {
        if (raw === '') continue;
        const lower = raw.toLowerCase();
        if (MODIFIER_LABELS[lower] !== undefined) parts.push(MODIFIER_LABELS[lower]);
        else if (raw.length === 1) parts.push(raw.toUpperCase());
        else parts.push(raw);
      }
      return parts.join('+');
    }

    /** One shared 0..1 → whole percent, so every row rounds the same way. */
    function percentOf(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      return Math.round(number * 100);
    }

    /** `42%, 31%` for a point, or null when the coordinates are not there. */
    function pointLabel(x, y) {
      const px = percentOf(x);
      const py = percentOf(y);
      return px === null || py === null ? null : px + '%, ' + py + '%';
    }

    /**
     * What the agent did, said in the reader's language, from the entry's
     * `params`. Returns null when the entry is not an agent operation this
     * build can phrase, and the caller falls back to the Host's own `detail`.
     */
    function phraseAgentEntry(t, entry) {
      if (entry === null || typeof entry !== 'object') return null;
      const params = entry.params;
      if (params === null || typeof params !== 'object') return null;
      if (entry.action === 'linkr_screen') {
        const width = Number(params.width);
        const height = Number(params.height);
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
        return t('logCapture', { size: width + '×' + height });
      }
      if (entry.action === 'linkr_mouse') {
        const verb = typeof params.action === 'string' ? params.action : '';
        if (verb === 'scroll') {
          const wheelY = Number(params.wheelY);
          if (!Number.isFinite(wheelY) || wheelY === 0) return null;
          const lines = Math.abs(Math.round(wheelY));
          return wheelY > 0 ? t('logScrollDown', { lines }) : t('logScrollUp', { lines });
        }
        if (verb === 'drag') {
          const from = pointLabel(params.x, params.y);
          const to = pointLabel(params.toX, params.toY);
          if (from === null || to === null) return null;
          return t('logDrag', { from, to });
        }
        const point = pointLabel(params.x, params.y);
        if (point === null) return null;
        if (verb === 'click') return t('logClick', { point });
        if (verb === 'double_click') return t('logDoubleClick', { point });
        if (verb === 'right_click') return t('logRightClick', { point });
        if (verb === 'move') return t('logMove', { point });
        return null;
      }
      if (entry.action === 'linkr_key') {
        const combo = comboLabel(params.combo);
        return combo === '' ? null : t('logKey', { combo });
      }
      if (entry.action === 'linkr_type') {
        const chars = Number(params.chars);
        if (!Number.isFinite(chars)) return null;
        return t('logType', { count: chars });
      }
      if (entry.action === 'linkr_panel') {
        const which = params.panelAction;
        if (which === 'open') return t('logPanelOpen');
        if (which === 'focus') return t('logPanelFocus');
        if (which === 'close') return t('logPanelClose');
        return null;
      }
      if (entry.action === 'linkr_status') return t('logStatus');
      return null;
    }

    /** One activity row's identity: the same event, however often it arrives. */
    function logKey(entry) {
      return entry.at + '|' + entry.action + '|' + entry.detail;
    }

    /**
     * Newest first, one row per event, never more than the Host's own ring.
     * Deduping against the kept list is enough: a replayed entry that has
     * already fallen off the end is not on screen to duplicate.
     */
    function mergeLog(previous, row) {
      const key = logKey(row);
      const next = previous.filter((item) => logKey(item) !== key);
      next.push(row);
      next.sort((a, b) => b.at - a.at);
      return next.slice(0, LOG_LIMIT);
    }

    /** `HH:MM:SS` in the reader's own timezone. */
    function clockOf(at) {
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => (value < 10 ? '0' + value : String(value));
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    /** What the Host accepts for the encoding fields; the form checks first. */
    const CODECS = ['auto', 'mjpeg', 'h264'];
    const FPS_RANGE = [1, 60];
    const JPEG_QUALITY_RANGE = [1, 10];

    /**
     * The first encoding field the Host would reject, or null when the form is
     * worth sending. The Host validates again — this only spares a round trip
     * and names the offending field instead of a generic failure.
     */
    function invalidEncodingField(form) {
      if (!CODECS.includes(form.codec)) return { field: 'encoding' };
      const fps = Number(form.streamFps);
      if (!Number.isInteger(fps) || fps < FPS_RANGE[0] || fps > FPS_RANGE[1]) {
        return { field: 'frameRate', min: FPS_RANGE[0], max: FPS_RANGE[1] };
      }
      const quality = Number(form.jpegQuality);
      if (!Number.isInteger(quality) || quality < JPEG_QUALITY_RANGE[0] || quality > JPEG_QUALITY_RANGE[1]) {
        return { field: 'jpegQuality', min: JPEG_QUALITY_RANGE[0], max: JPEG_QUALITY_RANGE[1] };
      }
      return null;
    }

    /**
     * The codec as the bar names it. `state.codec` is a technical token
     * ('mjpeg' / 'h264'), and its upper case is `H264` — the device's own name
     * for that stream is `H.264`, so the two numeric codecs get their dot back.
     */
    function codecLabel(codec) {
      const value = typeof codec === 'string' ? codec.trim() : '';
      if (value === '') return '';
      if (value === 'h264') return 'H.264';
      if (value === 'h265') return 'H.265';
      return value.toUpperCase();
    }

    /** Wheel deltas become whole lines; only the sign is meaningful on the device. */
    function wheelStep(delta) {
      if (!Number.isFinite(delta) || delta === 0) return 0;
      const lines = Math.round(Math.abs(delta) / 40);
      const steps = lines === 0 ? 1 : Math.min(lines, 10);
      return delta > 0 ? steps : -steps;
    }

    const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn']);
    const NAMED_KEYS = new Set([
      'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
      'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    ]);
    // Punctuation by physical code, so a shifted key still travels as its own
    // key plus Shift rather than as an already-shifted character the device
    // could not name.
    const PUNCTUATION_CODES = {
      Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    };

    /**
     * One DOM key event as the `combo` the Host's `parseCombo` reads, or null
     * for a key this panel does not send (a modifier on its own, a dead key).
     *
     * The device maps the DOM `code` to a Linux keycode, so the base key comes
     * from `code` whenever it carries one; `key` only names what is left.
     */
    function comboForEvent(event) {
      const key = typeof event.key === 'string' ? event.key : '';
      if (key === '' || MODIFIER_KEYS.has(key)) return null;
      if (key === 'Dead' || key === 'Unidentified' || key === 'Process') return null;
      const code = typeof event.code === 'string' ? event.code : '';
      let base = '';
      let fromCode = false;
      if (/^Key[A-Z]$/.test(code)) {
        base = code.slice(3).toLowerCase();
        fromCode = true;
      } else if (/^Digit[0-9]$/.test(code)) {
        base = code.slice(5);
        fromCode = true;
      } else if (/^Numpad[0-9]$/.test(code)) {
        base = code.slice(6);
        fromCode = true;
      } else if (PUNCTUATION_CODES[code] !== undefined) {
        base = PUNCTUATION_CODES[code];
        fromCode = true;
      } else if (key === ' ') {
        // The Host's key combos are named tokens; "space" is the name for " ".
        base = 'space';
      } else if (key.length === 1) {
        base = key;
      } else if (NAMED_KEYS.has(key) || /^F[0-9]{1,2}$/.test(key)) {
        base = key;
      } else {
        return null;
      }
      const parts = [];
      if (event.ctrlKey) parts.push('ctrl');
      if (event.altKey) parts.push('alt');
      if (event.metaKey) parts.push('meta');
      // Shift is part of the chord when the base key is the unshifted one. A
      // single character taken from `key` is already shifted, so adding Shift
      // there would shift it twice.
      if (event.shiftKey && (fromCode || base.length > 1)) parts.push('shift');
      parts.push(base);
      return parts.join('+');
    }

    /** Keys typed into the panel's own controls belong to those controls. */
    function isFormTarget(target) {
      if (!target || typeof target.closest !== 'function') return false;
      return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || (payload && payload.ok === false)) {
        const why = (payload && (payload.error || payload.message)) || 'HTTP ' + response.status;
        throw new Error(String(why));
      }
      return payload;
    }

    /* ---------------- the clipboard capability ---------------- */

    /**
     * The Host's reason codes for `GET/POST /linkr/clipboard`. `message` is the
     * Transport's English sentence and stays a tooltip: the code is the part
     * the panel can say in the reader's language.
     */
    const CLIPBOARD_REASON_KEYS = {
      unconfigured: 'clipboardReasonUnconfigured',
      disabled: 'clipboardReasonDisabled',
      disconnected: 'clipboardReasonDisconnected',
      unsupported: 'clipboardReasonUnsupported',
      'device-error': 'clipboardReasonDeviceError',
    };

    /**
     * The capability half of a clipboard answer, and nothing else: `text` is
     * the controlled machine's clipboard content and must not reach component
     * state, the DOM or a log line.
     */
    function clipboardSnapshot(payload) {
      const source = payload && payload.clipboard;
      if (source === null || typeof source !== 'object') return null;
      const hasFlag = typeof source.available === 'boolean';
      const reason = typeof source.reason === 'string' ? source.reason : null;
      if (!hasFlag && reason === null) return null;
      const available = source.available === true || (source.available !== false && reason === '');
      const maxBytes = Number(source.maxBytes);
      return {
        available,
        enabled: source.enabled === true,
        connected: source.connected === true,
        reason: available ? '' : (reason === null || reason === '' ? 'device-error' : reason),
        message: typeof source.message === 'string' ? source.message : '',
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0,
      };
    }

    /** One localized sentence for a known code; an unknown code stays as it is. */
    function clipboardReasonText(t, reason) {
      const key = CLIPBOARD_REASON_KEYS[reason];
      return key === undefined ? reason : t(key);
    }

    /**
     * The guide answers exactly two codes: Linkrd missing/disabled, and the
     * program on the controlled machine not connected. The other reasons are
     * configuration or transport problems that installing Linkrd cannot fix.
     */
    function clipboardWantsGuide(clipboard) {
      if (clipboard === null || clipboard.available) return false;
      return clipboard.reason === 'disabled' || clipboard.reason === 'disconnected';
    }

    /**
     * What the bar says. Every state carries words, not only a dot colour:
     * reading, not configured, connecting, live, stopped with the device's own
     * reason, and the Host's routes not answering at all.
     */
    function describeStatus(t, options) {
      const state = options.state;
      if (options.hostError !== '') {
        return { tone: 'err', text: t('stateHostDown'), detail: options.hostError, detailError: true };
      }
      if (!options.known) return { tone: '', text: t('stateReading'), detail: '', detailError: false };
      if (options.paused) return { tone: '', text: t('statePaused'), detail: t('statePausedHint'), detailError: false };
      const configured = Boolean(state && state.configured);
      if (!configured) {
        return { tone: 'warn', text: t('stateUnconfigured'), detail: t('stateUnconfiguredHint'), detailError: false };
      }
      if (options.busy === 'connect') return { tone: 'warn', text: t('stateConnecting'), detail: '', detailError: false };
      if (options.busy === 'disconnect') return { tone: '', text: t('stateStopped'), detail: '', detailError: false };
      const connected = Boolean(state && state.connected);
      // Stopped is a state of its own, and it says which kind it is: a session
      // that is off, or a live session this panel is not watching.
      if (options.stopped) {
        return connected
          ? { tone: '', text: t('statePictureOff'), detail: t('statePictureOffHint'), detailError: false }
          : { tone: '', text: t('stateStopped'), detail: '', detailError: false };
      }
      if (connected) return { tone: 'on', text: t('stateLive'), detail: '', detailError: false };
      const reason = state && typeof state.error === 'string' ? state.error : '';
      return {
        tone: reason === '' ? '' : 'err',
        text: reason === '' ? t('stateStopped') : t('stateDeviceError'),
        detail: reason === '' ? '' : reason,
        detailError: reason !== '',
      };
    }

    /* ---------------- settings ---------------- */

    function LinkrSettings({ t, onClose, onSaved, onOpenGuide }) {
      const [form, setForm] = useState(null);
      const [masked, setMasked] = useState('');
      const [notice, setNotice] = useState('');
      const [noticeError, setNoticeError] = useState(false);
      const [busy, setBusy] = useState(false);
      const [passwordEdited, setPasswordEdited] = useState(false);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        fetch(CONFIG_URL, { headers: { Accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (!alive.current) return;
            const config = (payload && payload.config) || {};
            setForm({
              baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
              username: typeof config.username === 'string' ? config.username : '',
              password: '',
              // Encoding: read from the Host, with the contract's defaults when
              // an older Host does not send the field at all.
              codec: CODECS.includes(config.codec) ? config.codec : 'auto',
              streamFps: Number.isFinite(config.streamFps) ? String(config.streamFps) : '20',
              jpegQuality: Number.isFinite(config.jpegQuality) ? String(config.jpegQuality) : '4',
              ffmpegPath: typeof config.ffmpegPath === 'string' ? config.ffmpegPath : '',
            });
            setMasked(typeof config.password === 'string' ? config.password : '');
          })
          .catch(() => {
            if (alive.current) setNotice(t('saveFailed'));
          });
        return () => {
          alive.current = false;
        };
      }, [t]);

      const save = async () => {
        if (!form || busy) return;
        // Checked before anything leaves the page, so a typo names its own field.
        const invalid = invalidEncodingField(form);
        if (invalid !== null) {
          setNoticeError(true);
          setNotice(
            invalid.field === 'encoding'
              ? t('saveFailed') + ': ' + t('encoding')
              : t('validateInteger', { label: t(invalid.field), min: invalid.min, max: invalid.max }),
          );
          return;
        }
        setBusy(true);
        setNotice('');
        setNoticeError(false);
        const body = {
          baseUrl: String(form.baseUrl || '').trim(),
          username: String(form.username || '').trim(),
          codec: form.codec,
          streamFps: Number(form.streamFps),
          jpegQuality: Number(form.jpegQuality),
          ffmpegPath: String(form.ffmpegPath || '').trim(),
        };
        // An untouched password field is left out entirely: the stored secret
        // stays as it is and is never round-tripped through this page.
        if (passwordEdited && form.password !== '') body.password = form.password;
        try {
          await postJson(CONFIG_URL, body);
          setNotice(t('saved'));
          setPasswordEdited(false);
          setForm({ ...form, password: '' });
          onSaved();
        } catch (error) {
          // The Host's own sentence, verbatim: it knows what it rejected.
          setNoticeError(true);
          setNotice(t('saveFailed') + ': ' + String((error && error.message) || error));
        } finally {
          setBusy(false);
        }
      };

      if (form === null) {
        return h('div', { className: 'dsh-linkr-settings' }, h('div', { className: 'dsh-linkr-note' }, t('loading')));
      }

      const field = (label, control, note) =>
        h(
          'label',
          { className: 'dsh-linkr-field' },
          h('span', { className: 'dsh-linkr-label' }, label),
          control,
          note ? h('span', { className: 'dsh-linkr-note' }, note) : null,
        );

      return h(
        'div',
        { className: 'dsh-linkr-settings' },
        field(
          t('baseUrl'),
          h('input', {
            className: 'dsh-linkr-input',
            value: form.baseUrl,
            placeholder: t('baseUrlHint'),
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setForm({ ...form, baseUrl: event.target.value }),
          }),
        ),
        field(
          t('username'),
          h('input', {
            className: 'dsh-linkr-input',
            value: form.username,
            spellCheck: false,
            autoComplete: 'username',
            onChange: (event) => setForm({ ...form, username: event.target.value }),
          }),
        ),
        field(
          t('password'),
          h('input', {
            className: 'dsh-linkr-input',
            type: 'password',
            value: form.password,
            placeholder: t('passwordKeep'),
            autoComplete: 'new-password',
            onChange: (event) => {
              setPasswordEdited(true);
              setForm({ ...form, password: event.target.value });
            },
          }),
          // Only ever the mask the Host returns, never a value that could be
          // the secret itself.
          /^[•*]+$/.test(masked) ? t('passwordStored') + ' ' + masked : t('passwordStored'),
        ),
        field(
          t('encoding'),
          h(
            'select',
            {
              className: 'dsh-linkr-input dsh-linkr-select',
              value: form.codec,
              onChange: (event) => setForm({ ...form, codec: event.target.value }),
            },
            h('option', { value: 'auto' }, t('encodingAuto')),
            h('option', { value: 'mjpeg' }, t('encodingMjpeg')),
            h('option', { value: 'h264' }, t('encodingH264')),
          ),
        ),
        field(
          t('frameRate'),
          h('input', {
            className: 'dsh-linkr-input',
            inputMode: 'numeric',
            value: form.streamFps,
            placeholder: '1–60',
            onChange: (event) => setForm({ ...form, streamFps: event.target.value }),
          }),
          t('frameRateHint'),
        ),
        field(
          t('jpegQuality'),
          h('input', {
            className: 'dsh-linkr-input',
            inputMode: 'numeric',
            value: form.jpegQuality,
            placeholder: '1–10',
            onChange: (event) => setForm({ ...form, jpegQuality: event.target.value }),
          }),
          t('jpegQualityHint'),
        ),
        field(
          t('ffmpegPath'),
          h('input', {
            className: 'dsh-linkr-input',
            value: form.ffmpegPath,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => setForm({ ...form, ffmpegPath: event.target.value }),
          }),
          t('ffmpegPathHint'),
        ),
        // The way back to the guide after 不再提示: settings is where someone
        // looks when they want the panel to do more than it does.
        h(
          'div',
          { className: 'dsh-linkr-foot' },
          h(
            'button',
            { className: 'dsh-linkr-btn', onClick: onOpenGuide, title: t('guideLinkrdMore') },
            t('guideLinkrdMore'),
          ),
          h('span', { className: 'dsh-linkr-spacer' }),
        ),
        h(
          'div',
          { className: 'dsh-linkr-foot' },
          h('span', { className: 'dsh-linkr-note' + (noticeError ? ' dsh-linkr-note-error' : '') }, notice || t('configHint')),
          h('span', { className: 'dsh-linkr-spacer' }),
          h('button', { className: 'dsh-linkr-btn dsh-linkr-primary', onClick: save, disabled: busy }, busy ? t('saving') : t('save')),
          h('button', { className: 'dsh-linkr-btn', onClick: onClose }, t('close')),
        ),
      );
    }

    /**
     * The one piece of onboarding this panel carries: install Linkrd on the
     * controlled machine (CONTRACT §15). A card rather than a toast, because its
     * three steps happen in the device console and take minutes, and a notice
     * the reader can act on later beats one that scrolls away.
     *
     * It gates nothing. [打开 Linkr 安装] is the only action and it opens the
     * device console where the plugin center lives; dismissing the card leaves
     * the panel exactly as it was.
     */
    function LinkrLinkrdGuide({ t, onInstall, onDismiss, installable }) {
      const item = (key, text) => h('li', { key }, text);
      return h(
        'div',
        { className: 'dsh-linkr-guide', role: 'note' },
        h(
          'div',
          { className: 'dsh-linkr-guide-head' },
          h('span', { className: 'dsh-linkr-guide-title' }, t('guideLinkrdTitle')),
          h('span', { className: 'dsh-linkr-spacer' }),
          h('button', { className: 'dsh-linkr-btn', onClick: onDismiss, title: t('guideLinkrdDismiss') }, t('guideLinkrdDismiss')),
        ),
        h('div', { className: 'dsh-linkr-guide-body' }, t('guideLinkrdBody')),
        h(
          'ul',
          { className: 'dsh-linkr-guide-list' },
          item('benefit-1', t('guideLinkrdBenefit1')),
          item('benefit-2', t('guideLinkrdBenefit2')),
          item('benefit-3', t('guideLinkrdBenefit3')),
        ),
        h('div', { className: 'dsh-linkr-guide-steps-title' }, t('guideLinkrdStepsTitle')),
        h(
          'ol',
          { className: 'dsh-linkr-guide-steps' },
          item('step-1', t('guideLinkrdStep1')),
          item('step-2', t('guideLinkrdStep2')),
          item('step-3', t('guideLinkrdStep3')),
        ),
        h('div', { className: 'dsh-linkr-guide-body dsh-linkr-guide-soft' }, t('guideLinkrdNote')),
        h(
          'div',
          { className: 'dsh-linkr-guide-foot' },
          h(
            'button',
            {
              className: 'dsh-linkr-btn dsh-linkr-primary',
              onClick: onInstall,
              disabled: !installable,
              title: t('guideLinkrdInstall'),
            },
            t('guideLinkrdInstall'),
          ),
        ),
      );
    }

    /* ---------------- the panel ---------------- */

    function LinkrPanel({ t }) {
      const [snapshot, setSnapshot] = useState(null);
      const [known, setKnown] = useState(false);
      const [hostError, setHostError] = useState('');
      const [nonce, setNonce] = useState(makeNonce);
      const [firstFrame, setFirstFrame] = useState(false);
      const [streamLost, setStreamLost] = useState(false);
      const [paused, setPaused] = useState(false);
      // `stopped` is the user's own "disconnect": the Host starts a session on
      // demand, so a retry after a deliberate stop would quietly undo it.
      const [stopped, setStopped] = useState(false);
      const [fit, setFit] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState('');
      const [inputError, setInputError] = useState('');
      // The Host's activity ring, newest first. It is independent of the
      // picture: entries arrive whether the session is live, stopped or not
      // even configured.
      const [entries, setEntries] = useState([]);
      // 快捷粘贴: normally the clipboard, but a shell that refuses clipboard
      // reads still gets a box to type into.
      const [pasteOpen, setPasteOpen] = useState(false);
      const [pasteText, setPasteText] = useState('');
      // The Host's clipboard capability, never its content. Null means "no
      // answer yet": a failed read or an older Host without the route must not
      // turn into a banner, so the line simply stays away.
      const [clipboard, setClipboard] = useState(null);
      const [clipboardBusy, setClipboardBusy] = useState(false);
      // The Linkrd install guide starts open the first time this browser sees
      // the panel and stays down after 不再提示 (CONTRACT §15). A clipboard
      // paste that fails, or a capability read that loses Linkrd, opens it again.
      const [guideOpen, setGuideOpen] = useState(() => readGuidePref() !== GUIDE_HIDDEN);

      const alive = useRef(true);
      const stageRef = useRef(null);
      const imageRef = useRef(null);
      const retryTimer = useRef(null);
      const retryDelay = useRef(RETRY_MS);
      const gesture = useRef(null);
      const click = useRef(null);
      const mover = useRef({ pending: null, timer: null, at: 0 });
      // One retry of the post-save connect, in case the Host is still restarting.
      const reloadTimer = useRef(null);
      const lastPoint = useRef({ x: 0.5, y: 0.5 });
      // The last capability answer, so a status that turns bad can be told
      // apart from the first read of a mount.
      const clipboardSeen = useRef(null);
      // A poll that was already in flight when Connect resolved can still
      // describe the state from before the session existed; its stale "stopped"
      // must not cancel the stream we just armed.
      const connectedAt = useRef(0);

      const state = snapshot && snapshot.state ? snapshot.state : null;
      const configured = Boolean(state && state.configured);
      const connected = Boolean(state && state.connected);
      // The picture does not hinge on a single failed state read: a transient
      // poll failure must not tear down a stream that is still running.
      const canStream = known && configured && !paused && !stopped;

      /* -- one read of /linkr/state, used by the poll and by every action -- */

      /**
       * One read of `/linkr/state`, shared by the poll, the buttons and the
       * retry gate. An `<img>` cannot read a 409 body, so this is the only way
       * the panel learns that the Host has stopped the session.
       */
      const readState = useCallback(async () => {
        try {
          const response = await fetch(STATE_URL, { headers: { Accept: 'application/json' } });
          const payload = await response.json().catch(() => ({}));
          if (!alive.current) return null;
          setKnown(true);
          if (!response.ok || !payload || payload.ok === false) {
            setHostError(String((payload && payload.error) || 'HTTP ' + response.status));
            return null;
          }
          const next = payload.state || null;
          setSnapshot(payload);
          setHostError('');
          // The Host's stop is a fact, not a suggestion: the panel adopts it as
          // its own intent, so no retry can start a session behind it. A read
          // that predates our own Connect is the one exception.
          const stale = connectedAt.current !== 0 && Date.now() - connectedAt.current < STALE_READ_MS;
          if (next && next.stopped === true && !stale) setStopped(true);
          return next;
        } catch (error) {
          if (!alive.current) return null;
          setKnown(true);
          setHostError(String((error && error.message) || error));
          return null;
        }
      }, []);

      const pull = useCallback(async () => {
        await readState();
      }, [readState]);

      useEffect(() => {
        alive.current = true;
        let timer = null;
        let halted = false;
        const loop = async () => {
          await pull();
          if (halted) return;
          timer = setTimeout(loop, POLL_MS);
        };
        loop();
        return () => {
          halted = true;
          alive.current = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [pull]);

      /* -- the clipboard capability -- */

      /**
       * Adopt one capability answer. A first read must not undo 不再提示; a
       * clipboard that worked and later lost Linkrd is news the guide can act
       * on, so in that case the card comes back.
       */
      const applyClipboard = useCallback((next) => {
        if (!alive.current) return;
        const previous = clipboardSeen.current;
        clipboardSeen.current = next;
        setClipboard(next);
        if (!clipboardWantsGuide(next)) return;
        const worthShowing = previous === null ? readGuidePref() !== GUIDE_HIDDEN : previous.available === true;
        if (worthShowing) setGuideOpen(true);
      }, []);

      /** A successful write proves the route works: no wait for a later read. */
      const markClipboardUsable = useCallback(() => {
        const previous = clipboardSeen.current;
        const next = {
          available: true,
          enabled: true,
          connected: true,
          reason: '',
          message: '',
          maxBytes: previous !== null ? previous.maxBytes : 0,
        };
        clipboardSeen.current = next;
        setClipboard(next);
      }, []);

      /**
       * One read of `GET /linkr/clipboard`, on mount and after the connection
       * state changes — the Host caches it for a few seconds, so this must not
       * ride the one-second state poll. Every failure is silent: the line is
       * advice, not a gate, and an older Host without the route is simply the
       * `unsupported` reason.
       */
      const readClipboard = useCallback(async () => {
        try {
          const response = await fetch(CLIPBOARD_URL, { headers: { Accept: 'application/json' } });
          if (!alive.current) return;
          if (response.status === 404) {
            applyClipboard({
              available: false,
              enabled: false,
              connected: false,
              reason: 'unsupported',
              message: '',
              maxBytes: 0,
            });
            return;
          }
          const payload = await response.json().catch(() => null);
          if (!alive.current) return;
          const next = payload !== null && payload.ok !== false ? clipboardSnapshot(payload) : null;
          if (next === null) setClipboard(null);
          else applyClipboard(next);
        } catch {
          if (alive.current) setClipboard(null);
        }
      }, [applyClipboard]);

      useEffect(() => {
        readClipboard();
      }, [readClipboard, connected]);

      /* -- recent activity -- */

      /**
       * One entry from the channel or from the history read. Rows are merged by
       * identity, so a replayed or re-read entry lands once.
       */
      const pushLog = useCallback((entry) => {
        if (entry === null || typeof entry !== 'object') return;
        const at = Number(entry.at);
        const action = typeof entry.action === 'string' ? entry.action : '';
        if (!Number.isFinite(at) || action === '') return;
        const detail = typeof entry.detail === 'string' ? entry.detail : '';
        const row = { at, action, detail, ok: entry.ok !== false };
        setEntries((previous) => mergeLog(previous, row));
      }, []);

      // History for a page that just opened. An older Host answers 404 and the
      // section simply stays empty — no banner, no retry.
      useEffect(() => {
        let cancelled = false;
        fetch(LOG_URL, { headers: { Accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (cancelled || payload === null || payload.ok === false) return;
            const list = Array.isArray(payload.entries) ? payload.entries : [];
            for (const entry of list) pushLog(entry);
          })
          .catch(() => {
            /* no log route on this Host: the empty state is the whole answer */
          });
        return () => {
          cancelled = true;
        };
      }, [pushLog]);

      // Live entries ride the channel the panel actions already use.
      useEffect(() => {
        panelHooks.log = pushLog;
        return () => {
          if (panelHooks.log === pushLog) panelHooks.log = null;
        };
      }, [pushLog]);

      /* -- the picture -- */

      const requestNewFrame = useCallback(() => {
        if (retryTimer.current !== null) {
          clearTimeout(retryTimer.current);
          retryTimer.current = null;
        }
        retryDelay.current = RETRY_MS;
        setStreamLost(false);
        setFirstFrame(false);
        setNonce(makeNonce());
      }, []);

      /**
       * Retry the picture after a failed load — never into a stopped Host.
       * `/linkr/live.mjpeg` starts a session on demand, so retrying blind would
       * undo a Disconnect; the state is re-read before every attempt because a
       * 409 body is unreadable from an `<img>`.
       */
      const scheduleRetry = useCallback(() => {
        if (retryTimer.current !== null) return;
        const delay = retryDelay.current;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          readState().then((next) => {
            if (!alive.current) return;
            if (next && next.stopped === true) {
              setStopped(true);
              setFirstFrame(false);
              return;
            }
            setNonce(makeNonce());
          }).catch(() => {
            if (alive.current) setNonce(makeNonce());
          });
        }, delay);
        retryDelay.current = Math.min(Math.round(delay * 1.6), RETRY_MAX_MS);
      }, [readState]);

      /**
       * The one way back to a picture: a session first, then a stream. Connect
       * and Refresh both come through here, so a stream is never armed against
       * a stopped Host — `/linkr/live.mjpeg` would answer 409 and, worse, its
       * retry would restart the session the user closed.
       */
      const connectNow = useCallback(async () => {
        if (busy !== '') return false;
        setBusy('connect');
        setNotice('');
        try {
          await postJson(CONNECT_URL, {});
          // Only once the Host owns a session does the stop intent lift.
          connectedAt.current = Date.now();
          setStopped(false);
          requestNewFrame();
          await pull();
          return true;
        } catch (error) {
          setNotice(t('stateDeviceError') + ': ' + String((error && error.message) || error));
          await pull();
          return false;
        } finally {
          setBusy('');
        }
      }, [busy, pull, requestNewFrame, t]);

      const disconnectNow = useCallback(async () => {
        if (busy !== '') return;
        setBusy('disconnect');
        setNotice('');
        // Stop our own stream before the Host stops its session: a stream that
        // outlives the stop would start the session again on reconnect.
        setStopped(true);
        if (retryTimer.current !== null) {
          clearTimeout(retryTimer.current);
          retryTimer.current = null;
        }
        try {
          await postJson(DISCONNECT_URL, {});
          await pull();
        } catch (error) {
          setNotice(t('actionFailed') + ': ' + String((error && error.message) || error));
          await pull();
        } finally {
          setBusy('');
        }
      }, [busy, pull, t]);

      const onFrameLoad = useCallback(() => {
        retryDelay.current = RETRY_MS;
        setFirstFrame(true);
        setStreamLost(false);
      }, []);

      const onFrameError = useCallback(() => {
        setFirstFrame(false);
        setStreamLost(true);
        scheduleRetry();
      }, [scheduleRetry]);

      /* -- input -- */

      const sendInput = useCallback(async (action, report) => {
        try {
          await postJson(INPUT_URL, action);
          if (report) setInputError('');
          return true;
        } catch (error) {
          if (report) setInputError(t('actionFailed') + ': ' + String((error && error.message) || error));
          return false;
        }
      }, [t]);

      const flushMove = useCallback(() => {
        const slot = mover.current;
        if (slot.timer !== null) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
        const point = slot.pending;
        if (!point) return;
        slot.pending = null;
        slot.at = Date.now();
        sendInput({ kind: 'mouse', action: 'move', x: round4(point.x), y: round4(point.y) }, false);
      }, [sendInput]);

      /** At most ~30 moves a second, with the newest position kept for last. */
      const queueMove = useCallback((point) => {
        const slot = mover.current;
        slot.pending = point;
        const wait = MOVE_MS - (Date.now() - slot.at);
        if (wait <= 0) {
          flushMove();
          return;
        }
        if (slot.timer === null) slot.timer = setTimeout(flushMove, wait);
      }, [flushMove]);

      const pointFrom = useCallback((event) => mapPoint(imageRef.current, event.clientX, event.clientY), []);

      /**
       * A press that did not turn into a drag is a click — but a second press
       * within a moment, at the same place, is one double click, so the single
       * click waits CLICK_MS for its partner to arrive.
       */
      const commitClick = useCallback((point) => {
        const prior = click.current;
        if (prior !== null) {
          clearTimeout(prior.timer);
          click.current = null;
          const near = Math.abs(prior.point.x - point.x) < 0.02 && Math.abs(prior.point.y - point.y) < 0.02;
          if (near) {
            sendInput({ kind: 'mouse', action: 'double_click', x: round4(point.x), y: round4(point.y) }, true);
            return;
          }
          sendInput({ kind: 'mouse', action: 'click', x: round4(prior.point.x), y: round4(prior.point.y) }, false);
        }
        const timer = setTimeout(() => {
          click.current = null;
          sendInput({ kind: 'mouse', action: 'click', x: round4(point.x), y: round4(point.y) }, true);
        }, CLICK_MS);
        click.current = { timer, point };
      }, [sendInput]);

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0 && event.button !== 2) return;
        const point = pointFrom(event);
        if (!point || !point.inside) return;
        event.preventDefault();
        // Focus first: the keys that follow belong to the host, not the page.
        const stage = stageRef.current;
        if (stage && typeof stage.focus === 'function') {
          try {
            stage.focus({ preventScroll: true });
          } catch {
            stage.focus();
          }
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* capture is a convenience, not a requirement */
        }
        gesture.current = {
          pointerId: event.pointerId,
          button: event.button,
          x: point.x,
          y: point.y,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
      }, [pointFrom]);

      const onPointerMove = useCallback((event) => {
        const point = pointFrom(event);
        if (!point) return;
        lastPoint.current = { x: point.x, y: point.y };
        const current = gesture.current;
        if (current !== null) {
          if (!current.moved && (Math.abs(event.clientX - current.startX) > DRAG_SLOP || Math.abs(event.clientY - current.startY) > DRAG_SLOP)) {
            current.moved = true;
          }
          if (current.moved) queueMove(point);
          return;
        }
        if (event.pointerType === 'touch') return;
        if (!point.inside) return;
        queueMove(point);
      }, [pointFrom, queueMove]);

      const dropGesture = useCallback((event) => {
        const current = gesture.current;
        if (current === null) return null;
        gesture.current = null;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* the pointer may already be gone */
        }
        return current;
      }, []);

      const onPointerUp = useCallback((event) => {
        const current = gesture.current;
        if (current === null || current.pointerId !== event.pointerId) return;
        const point = pointFrom(event) || { x: current.x, y: current.y, inside: true };
        dropGesture(event);
        if (current.button === 2) {
          if (!current.moved) sendInput({ kind: 'mouse', action: 'right_click', x: round4(point.x), y: round4(point.y) }, true);
          return;
        }
        if (current.moved) {
          sendInput({
            kind: 'mouse',
            action: 'drag',
            x: round4(current.x),
            y: round4(current.y),
            toX: round4(point.x),
            toY: round4(point.y),
          }, true);
          return;
        }
        commitClick({ x: point.x, y: point.y });
      }, [pointFrom, sendInput, commitClick, dropGesture]);

      const onPointerCancel = useCallback((event) => {
        const current = gesture.current;
        if (current === null || current.pointerId !== event.pointerId) return;
        dropGesture(event);
      }, [dropGesture]);

      /**
       * The wheel listener is attached by hand: React's own wheel handler is
       * passive, and a passive handler may not preventDefault(), which would
       * leave the page scrolling behind a picture that is being scrolled.
       */
      useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return undefined;
        const onWheel = (event) => {
          event.preventDefault();
          const point = mapPoint(imageRef.current, event.clientX, event.clientY) || lastPoint.current;
          const wheelY = wheelStep(event.deltaY);
          const wheelX = wheelStep(event.deltaX);
          if (wheelY === 0 && wheelX === 0) return;
          sendInput({
            kind: 'mouse',
            action: 'scroll',
            x: round4(point.x),
            y: round4(point.y),
            wheelY,
            wheelX,
          }, true);
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
      }, [sendInput]);

      const onKeyDown = useCallback((event) => {
        if (isFormTarget(event.target)) return;
        const combo = comboForEvent(event);
        if (combo === null) return;
        // Only a key this panel actually sends loses its page behaviour.
        event.preventDefault();
        sendInput({ kind: 'key', combo }, true);
      }, [sendInput]);

      const onKeyUp = useCallback((event) => {
        if (isFormTarget(event.target)) return;
        if (comboForEvent(event) === null) return;
        // The Host's key action is one complete press-and-release (`parseCombo`
        // emits down then up in reverse order), so the release is already
        // carried by the keydown above. Preventing the default here keeps the
        // page from acting on a key the host has taken.
        event.preventDefault();
      }, []);

      /* -- the Linkrd guide -- */

      const openGuide = useCallback(() => {
        setGuideOpen(true);
        writeGuidePref('open');
      }, []);

      const dismissGuide = useCallback(() => {
        setGuideOpen(false);
        writeGuidePref(GUIDE_HIDDEN);
      }, []);

      /* -- quick paste -- */

      /**
       * One text → the Host. Pure ASCII keeps the HID keyboard path; anything
       * else goes through the Host's clipboard route, because the device
       * keyboard is US-ASCII and would refuse it. An empty string is never sent.
       */
      const sendText = useCallback(async (text) => {
        const value = typeof text === 'string' ? text : '';
        if (value.trim() === '') {
          setNotice(t('pasteEmpty'));
          return false;
        }
        if (clipboardBusy) return false;
        if (/[^\x00-\x7f]/.test(value)) {
          setClipboardBusy(true);
          try {
            // The Host makes a session for `keys` itself, but a panel the user
            // explicitly disconnected should come back the way it does for a
            // keyboard paste, instead of surfacing the Host's 409.
            if (!connected || stopped) {
              const live = await connectNow();
              if (live === false) return false;
            }
            await postJson(CLIPBOARD_URL, { text: value, keys: 'ctrl+v' });
            markClipboardUsable();
            setNotice(t('pasteClipboardSent', { count: value.length }));
            setPasteOpen(false);
            setPasteText('');
            return true;
          } catch (error) {
            // The Host's own sentence says why; the guide is the fix when the
            // reason is Linkrd itself, and harmless advice otherwise.
            setNotice(t('pasteClipboardFailed', { reason: String((error && error.message) || error) }));
            setGuideOpen(true);
            writeGuidePref('open');
            return false;
          } finally {
            setClipboardBusy(false);
          }
        }
        // The Host refuses input while the session is stopped, and "paste did
        // nothing" is a worse answer than one extra round trip: behave like
        // Connect first, then paste into the session that just came up.
        if (!connected || stopped) {
          const live = await connectNow();
          if (live === false) return false;
        }
        const sent = await sendInput({ kind: 'text', text: value }, true);
        if (sent) {
          setNotice(t('pasteSent', { count: value.length }));
          setPasteOpen(false);
          setPasteText('');
        }
        return sent;
      }, [clipboardBusy, connectNow, connected, markClipboardUsable, sendInput, stopped, t]);

      /**
       * 仅写入剪贴板: write the text on the controlled machine without a key
       * chord, for terminal windows that paste with Ctrl+Shift+V themselves.
       * Needs no live session, so this path never connects first.
       */
      const writeClipboard = useCallback(async (text) => {
        const value = typeof text === 'string' ? text : '';
        if (value.trim() === '') {
          setNotice(t('pasteEmpty'));
          return false;
        }
        if (clipboardBusy) return false;
        setClipboardBusy(true);
        try {
          await postJson(CLIPBOARD_URL, { text: value });
          markClipboardUsable();
          setNotice(t('clipboardWriteOnlyDone'));
          setPasteOpen(false);
          setPasteText('');
          return true;
        } catch (error) {
          setNotice(t('clipboardWriteFailed', { reason: String((error && error.message) || error) }));
          setGuideOpen(true);
          writeGuidePref('open');
          return false;
        } finally {
          setClipboardBusy(false);
        }
      }, [clipboardBusy, markClipboardUsable, t]);

      /**
       * A paste gesture on the picture takes the same path as the 粘贴 button,
       * so Chinese goes through the clipboard route instead of being refused by
       * the US-ASCII keyboard. Declared after `sendText` because it uses it.
       */
      const onPaste = useCallback((event) => {
        if (isFormTarget(event.target)) return;
        const data = event.clipboardData;
        const text = data ? data.getData('text/plain') : '';
        if (!text) return;
        event.preventDefault();
        sendText(text);
      }, [sendText]);

      /**
       * The paste control: the clipboard when the shell allows it, and the box
       * when it does not. A clipboard that is missing, refused or empty is not
       * an error — it is the reason the box exists.
       */
      const quickPaste = useCallback(async () => {        let text = '';
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
            text = await navigator.clipboard.readText();
          }
        } catch {
          text = '';
        }
        if (typeof text !== 'string' || text.trim() === '') {
          setPasteOpen(true);
          return;
        }
        await sendText(text);
      }, [sendText]);

      /* -- the bar's actions -- */

      /**
       * A config write restarts the Host plugin, so the session it had is gone
       * with it. Read the new instance's state, connect, and re-arm the stream;
       * when it is not answering yet, try once more on the next breath.
       */
      const onConfigSaved = useCallback(() => {
        if (reloadTimer.current !== null) {
          clearTimeout(reloadTimer.current);
          reloadTimer.current = null;
        }
        pull()
          .catch(() => {})
          .then(() => connectNow())
          .then((okay) => {
            if (okay === false && alive.current) {
              reloadTimer.current = setTimeout(() => {
                reloadTimer.current = null;
                connectNow();
              }, 900);
            }
          });
      }, [connectNow, pull]);

      /* -- panel lifetime: pause the stream while the tab is out of sight -- */

      const pause = useCallback(() => setPaused(true), []);
      const resume = useCallback(() => setPaused(false), []);

      useEffect(() => {
        panelHooks.pause = pause;
        panelHooks.resume = resume;
        return () => {
          if (panelHooks.pause === pause) panelHooks.pause = null;
          if (panelHooks.resume === resume) panelHooks.resume = null;
        };
      }, [pause, resume]);

      // Reopening the tab (or un-hiding the column) brings the picture back
      // even when no panel action asked for it.
      useEffect(() => {
        const stage = stageRef.current;
        if (!stage || typeof IntersectionObserver !== 'function') return undefined;
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setPaused(false);
              return;
            }
          }
        }, { threshold: 0 });
        observer.observe(stage);
        return () => observer.disconnect();
      }, []);

      /* -- teardown -- */

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          if (retryTimer.current !== null) {
            clearTimeout(retryTimer.current);
            retryTimer.current = null;
          }
          if (click.current !== null) {
            clearTimeout(click.current.timer);
            click.current = null;
          }
          if (reloadTimer.current !== null) {
            clearTimeout(reloadTimer.current);
            reloadTimer.current = null;
          }
          const slot = mover.current;
          if (slot.timer !== null) {
            clearTimeout(slot.timer);
            slot.timer = null;
          }
          slot.pending = null;
        };
      }, []);

      /* -- what the bar shows -- */

      const status = describeStatus(t, { state, known, hostError, paused, stopped, busy });
      const deviceName = (state && state.device && state.device.deviceName) || (state && state.origin) || '';
      const width = state && state.width ? state.width : 0;
      const height = state && state.height ? state.height : 0;
      const fps = state && typeof state.fps === 'number' ? state.fps : 0;
      const resolutionText = width > 0 && height > 0 ? width + '×' + height : '—';
      // `fps` is the delivered rate, e.g. 22.4 → "22.4 fps".
      const fpsText = fps > 0 ? String(Math.round(fps * 10) / 10) + ' fps' : '—';
      const codecText = codecLabel(state && state.codec);
      const decoderText = state && typeof state.decoder === 'string' ? state.decoder : '';
      // `H.264 · 1920×1080 · 22 fps`. An older Host sends no codec at all, and
      // then the line simply starts at the resolution.
      const metricParts = [];
      const addMetric = (key, text, title) => {
        if (metricParts.length > 0) {
          metricParts.push(h('span', { key: key + '-sep', className: 'dsh-linkr-sep', 'aria-hidden': 'true' }, '·'));
        }
        // The device name is the longest and least vital part: it is the one
        // allowed to ellipsize when the column is narrow.
        metricParts.push(h('span', { key, className: 'dsh-linkr-metric' + (key === 'device' ? ' dsh-linkr-device' : ''), title }, text));
      };
      if (deviceName) addMetric('device', deviceName, t('device') + ': ' + deviceName);
      if (codecText) addMetric('codec', codecText, decoderText ? codecText + ' · ' + decoderText : codecText);
      addMetric('resolution', resolutionText, t('resolution'));
      addMetric('fps', fpsText, t('fps'));
      // The capability line: the reason code is localized, and the Transport's
      // English sentence stays in the tooltip. Clipboard content never appears
      // here — only whether the route can carry it.
      const clipboardReason = clipboard === null || clipboard.available ? '' : clipboardReasonText(t, clipboard.reason);
      const clipboardTitle = clipboard === null
        ? ''
        : clipboard.available
          ? clipboardText
          : [clipboardReason, clipboard.message].filter((part) => part !== '').join(' · ');
      // The stage is sized by its picture, so with no painted image yet (no
      // stream, or the first frame still on its way) it holds a block open for
      // the waiting/stopped pill.
      const stageClass =
        'dsh-linkr-stage' +
        (fit ? ' dsh-linkr-fit' : '') +
        (canStream ? ' dsh-linkr-live' : '') +
        (canStream && firstFrame ? '' : ' dsh-linkr-empty');
      const alert = inputError || notice;
      // The device's own console address; empty until the Host names one, which
      // is also what disables 打开 Linkr.
      const originRaw = state && typeof state.origin === 'string' ? state.origin.trim() : '';
      const origin = /^https?:\/\/\S+$/i.test(originRaw) ? originRaw.replace(/\/+$/, '') : '';
      const openConsole = () => {
        if (origin === '') return;
        try {
          window.open(origin + '/', '_blank', 'noopener');
        } catch {
          /* a blocked popup is the browser's decision, not a failure to report */
        }
      };

      // With the session live but the panel stopped, the button offers the way
      // back to a picture rather than a Disconnect nobody asked for.
      const watching = connected && !stopped;
      const connectLabel = busy === 'connect'
        ? t('stateConnecting')
        : busy === 'disconnect'
          ? t('stateStopped')
          : watching
            ? t('disconnect')
            : t('connect');

      const overlay = paused
        ? { title: t('statePaused'), text: t('statePausedHint') }
        : stopped
          ? connected
            ? { title: t('statePictureOff'), text: t('statePictureOffHint') }
            : { title: t('stateStopped'), text: '' }
          : known && hostError !== '' && !configured
            ? null
            : !configured
              ? { title: t('stateUnconfigured'), text: t('stateUnconfiguredHint') }
              : !firstFrame
                ? { title: streamLost ? t('streamLost') : t('waitingFrame'), text: '' }
                : null;

      return h(
        'div',
        { className: 'dsh-linkr-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsh-linkr-bar' },
          h(
            'div',
            { className: 'dsh-linkr-card-head' },
            h('span', { className: 'dsh-linkr-card-title', title: t('title') }, t('title')),
            h('span', { className: 'dsh-linkr-spacer' }),
            h(
              'button',
              { className: 'dsh-linkr-btn', onClick: openConsole, disabled: origin === '', title: t('openLinkr') },
              t('openLinkr'),
            ),
          ),
          h(
            'div',
            { className: 'dsh-linkr-row' },
            h('span', { className: 'dsh-linkr-dot' + (status.tone ? ' dsh-linkr-' + status.tone : ''), title: status.text, role: 'img', 'aria-label': status.text }),
            h('span', { className: 'dsh-linkr-status', title: status.text }, status.text),
            clipboard !== null && !clipboard.available
              ? h(
                  'span',
                  { className: 'dsh-linkr-clip', title: clipboardTitle || t('clipboardUnavailable'), role: 'status' },
                  h('span', { className: 'dsh-linkr-clip-dot', 'aria-hidden': 'true' }),
                  t('clipboardUnavailable'),
                )
              : null,
            h('span', { className: 'dsh-linkr-spacer' }),
            h(
              'button',
              {
                className: 'dsh-linkr-btn dsh-linkr-primary',
                onClick: watching ? disconnectNow : connectNow,
                disabled: busy !== '' || !known || hostError !== '' || !configured,
                title: watching ? t('disconnect') : t('connect'),
              },
              connectLabel,
            ),
          ),
          h(
            'div',
            { className: 'dsh-linkr-row dsh-linkr-metrics' },
            ...metricParts,
            h('span', { className: 'dsh-linkr-spacer' }),
            h('button', { className: 'dsh-linkr-btn' + (pasteOpen ? ' dsh-linkr-on' : ''), onClick: quickPaste, disabled: busy !== '' || !known || !configured || paused, title: t('paste'), 'aria-expanded': pasteOpen ? 'true' : 'false' }, t('paste')),
            h('button', { className: 'dsh-linkr-btn', onClick: connectNow, disabled: busy !== '' || !known || !configured || paused, title: t('refreshPicture') }, t('refreshPicture')),
            h(
              'button',
              {
                className: 'dsh-linkr-btn' + (fit ? ' dsh-linkr-on' : ''),
                onClick: () => setFit(!fit),
                'aria-pressed': fit ? 'true' : 'false',
                title: t('fitWidth'),
              },
              t('fitWidth'),
            ),
            h(
              'button',
              {
                className: 'dsh-linkr-btn' + (settingsOpen ? ' dsh-linkr-on' : ''),
                onClick: () => setSettingsOpen(!settingsOpen),
                'aria-expanded': settingsOpen ? 'true' : 'false',
                title: t('settings'),
              },
              t('settings'),
            ),
          ),
          pasteOpen
            ? h(
                'div',
                { className: 'dsh-linkr-paste', role: 'group' },
                h('textarea', {
                  className: 'dsh-linkr-paste-input',
                  rows: 3,
                  value: pasteText,
                  placeholder: t('pasteHint'),
                  autoFocus: true,
                  spellCheck: false,
                  onChange: (event) => setPasteText(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    event.stopPropagation();
                    setPasteOpen(false);
                  },
                }),
                h(
                  'div',
                  { className: 'dsh-linkr-paste-foot' },
                  h(
                    'button',
                    {
                      className: 'dsh-linkr-btn dsh-linkr-primary',
                      onClick: () => sendText(pasteText),
                      disabled: pasteText.trim() === '' || clipboardBusy,
                    },
                    t('pasteSend'),
                  ),
                  // Terminals paste with Ctrl+Shift+V, not Ctrl+V: this writes
                  // the clipboard and leaves the chord to the reader.
                  h(
                    'button',
                    {
                      className: 'dsh-linkr-btn',
                      onClick: () => writeClipboard(pasteText),
                      disabled: pasteText.trim() === '' || clipboardBusy,
                      title: t('clipboardWriteOnly'),
                    },
                    t('clipboardWriteOnly'),
                  ),
                  h('button', { className: 'dsh-linkr-btn', onClick: () => setPasteOpen(false) }, t('close')),
                ),
                h('div', { className: 'dsh-linkr-paste-hint' }, t('clipboardTerminalHint')),
              )
            : null,
          status.detail
            ? h('div', { className: 'dsh-linkr-detail' + (status.detailError ? ' dsh-linkr-error' : ''), title: status.detail }, status.detail)
            : null,
          alert
            ? h(
                'div',
                // A failed input is the error; a plain outcome (a paste that
                // landed) is not.
                { className: 'dsh-linkr-detail' + (inputError === '' ? '' : ' dsh-linkr-error'), title: alert, role: 'status' },
                alert,
              )
            : null,
        ),
        settingsOpen
          ? h(LinkrSettings, {
              t,
              onClose: () => { setSettingsOpen(false); pull(); },
              onSaved: onConfigSaved,
              // The settings row reopens the guide, so 不再提示 is reversible.
              onOpenGuide: () => { setSettingsOpen(false); openGuide(); },
            })
          : null,
        h(
          'div',
          {
            ref: stageRef,
            className: stageClass,
            tabIndex: 0,
            role: 'application',
            'aria-label': t('paneLabel'),
            title: t('focusHint'),
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onKeyDown,
            onKeyUp,
            onPaste,
            onContextMenu: (event) => event.preventDefault(),
          },
          canStream
            ? h('img', {
                key: nonce,
                ref: imageRef,
                className: 'dsh-linkr-img',
                src: LIVE_URL + '?session=' + encodeURIComponent(nonce),
                alt: '',
                draggable: false,
                onLoad: onFrameLoad,
                onError: onFrameError,
              })
            : null,
          overlay
            ? h(
                'div',
                { className: 'dsh-linkr-overlay' },
                h(
                  'div',
                  { className: 'dsh-linkr-pill', role: 'status' },
                  h('div', { className: 'dsh-linkr-pill-title' }, overlay.title),
                  overlay.text ? h('div', { className: 'dsh-linkr-pill-text' }, overlay.text) : null,
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-linkr-hint' },
          h('div', null, t('viewHint')),
          h('div', { className: 'dsh-linkr-hint-soft' }, t('hintAgent')),
        ),
        // Between the hint and the activity log: advice sits under the picture
        // it is about, and above the rows the reader is watching.
        guideOpen
          ? h(LinkrLinkrdGuide, {
              t,
              installable: origin !== '',
              onInstall: openConsole,
              onDismiss: dismissGuide,
            })
          : null,
        h(
          'div',
          { className: 'dsh-linkr-log' },
          h('div', { className: 'dsh-linkr-log-title' }, t('activityTitle')),
          entries.length === 0
            ? h('div', { className: 'dsh-linkr-log-empty' }, t('activityEmpty'))
            : h(
                'ul',
                // A list, not a live region: agent activity arrives in bursts and
                // must not be read aloud row by row.
                { className: 'dsh-linkr-log-list', role: 'log', 'aria-live': 'off' },
                entries.map((entry) => {
                  // An agent operation says what it did in the reader's own
                  // words; anything else (host rows, a failed call, params this
                  // build does not know) keeps the Host's label and sentence.
                  const phrase = entry.ok ? phraseAgentEntry(t, entry) : null;
                  const cells =
                    phrase === null
                      ? [
                          h('span', { key: 'action', className: 'dsh-linkr-log-action' }, actionLabel(t, entry.action)),
                          h('span', { key: 'detail', className: 'dsh-linkr-log-detail' }, entry.detail),
                        ]
                      : [h('span', { key: 'phrase', className: 'dsh-linkr-log-phrase' }, phrase)];
                  return h(
                    'li',
                    {
                      key: entry.at + '|' + entry.action + '|' + entry.detail,
                      className: 'dsh-linkr-log-row' + (entry.ok ? '' : ' dsh-linkr-log-row-error'),
                      // A failed row keeps the detail reachable when the column
                      // is too narrow to show it.
                      title: entry.ok ? undefined : entry.detail,
                    },
                    h('span', { className: 'dsh-linkr-log-time' }, clockOf(entry.at)),
                    ...cells,
                  );
                }),
              ),
        ),
      );
    }

    /* ---------------- styles ----------------
     * Theme tokens only (`--dsw-alias-*`), so light and dark follow the shell.
     * The stage is darkened with the theme's own masks rather than a literal
     * black: a picture needs a quiet surround in both modes, and the tokens are
     * what keep that possible.
     */
    const CSS = `
.dsh-linkr-root { width: 100%; height: 100%; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-linkr-bar { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex: 0 0 auto; }
.dsh-linkr-row { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.dsh-linkr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: 0 0 auto; }
.dsh-linkr-dot.dsh-linkr-on { background: var(--dsw-alias-state-success-primary); }
.dsh-linkr-dot.dsh-linkr-warn { background: var(--dsw-alias-state-warn-primary); }
.dsh-linkr-dot.dsh-linkr-err { background: var(--dsw-alias-state-error-primary); }
.dsh-linkr-status { flex: 1 1 90px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12.5px; }
.dsh-linkr-spacer { flex: 1 1 auto; min-width: 4px; }
.dsh-linkr-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-linkr-card-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-linkr-metrics { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-linkr-metric { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.dsh-linkr-sep { opacity: 0.6; flex: 0 0 auto; }
.dsh-linkr-device { min-width: 0; flex: 0 1 auto; }
.dsh-linkr-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; flex: 0 0 auto; }
.dsh-linkr-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-linkr-btn:disabled { opacity: 0.55; cursor: default; }
.dsh-linkr-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-linkr-btn.dsh-linkr-on { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary); }
.dsh-linkr-btn.dsh-linkr-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.dsh-linkr-detail { font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.dsh-linkr-detail.dsh-linkr-error { color: var(--dsw-alias-state-error-primary); }
.dsh-linkr-stage { position: relative; flex: 0 0 auto; display: flex; align-items: flex-start; justify-content: center; overflow: hidden; outline: none; background-color: var(--dsw-alias-bg-base); background-image: linear-gradient(var(--dsw-alias-bg-mask-1), var(--dsw-alias-bg-mask-1)), linear-gradient(var(--dsw-alias-bg-mask-3), var(--dsw-alias-bg-mask-3)); -webkit-user-select: none; user-select: none; }
.dsh-linkr-stage:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-linkr-stage.dsh-linkr-live { cursor: crosshair; }
.dsh-linkr-stage.dsh-linkr-fit { flex: 0 1 auto; min-height: 0; overflow: auto; }
.dsh-linkr-stage.dsh-linkr-fit .dsh-linkr-img { max-height: 100%; }
/* With no picture there is no content to size the stage: hold a block at the
   picture's own ratio so the waiting/stopped pill has somewhere to sit and the
   first frame does not move anything. */
.dsh-linkr-stage.dsh-linkr-empty { aspect-ratio: 16 / 9; min-height: 160px; }
.dsh-linkr-img { display: block; width: 100%; height: auto; object-fit: contain; -webkit-user-drag: none; user-select: none; }
.dsh-linkr-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; pointer-events: none; }
.dsh-linkr-pill { max-width: 100%; padding: 8px 12px; border-radius: 10px; text-align: center; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.45; }
.dsh-linkr-pill-title { font-weight: 600; }
.dsh-linkr-pill-text { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.dsh-linkr-settings { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex: 0 0 auto; }
.dsh-linkr-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-linkr-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-linkr-input { width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; outline: none; }
.dsh-linkr-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-linkr-select { width: 100%; }
.dsh-linkr-note-error { color: var(--dsw-alias-state-error-primary); }
.dsh-linkr-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-linkr-note { flex: 0 0 auto; font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.dsh-linkr-hint { flex: 0 0 auto; padding: 6px 12px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.dsh-linkr-hint-soft { margin-top: 2px; }
/* The Linkrd install guide (CONTRACT §15): a card between the picture and the
   activity log. A layer-1 surface with the theme's own border keeps it
   secondary in both light and dark — it advises, it never competes with the
   picture for attention. */
.dsh-linkr-guide { flex: 0 0 auto; margin: 8px 10px 4px; padding: 9px 11px; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.dsh-linkr-guide-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-linkr-guide-title { min-width: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-linkr-guide-body { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-linkr-guide-soft { color: var(--dsw-alias-label-tertiary); }
.dsh-linkr-guide-list, .dsh-linkr-guide-steps { margin: 0; padding-left: 17px; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dsh-linkr-guide-steps-title { margin-top: 2px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-linkr-guide-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-linkr-log { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.dsh-linkr-log-title { flex: 0 0 auto; padding: 6px 12px 2px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-linkr-log-list { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0; padding: 0 12px 8px; list-style: none; }
.dsh-linkr-log-row { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-linkr-log-time { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.dsh-linkr-log-action { flex: 0 0 auto; color: var(--dsw-alias-label-primary); }
.dsh-linkr-log-detail { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-linkr-log-phrase { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsh-linkr-log-row-error .dsh-linkr-log-time, .dsh-linkr-log-row-error .dsh-linkr-log-action, .dsh-linkr-log-row-error .dsh-linkr-log-detail, .dsh-linkr-log-row-error .dsh-linkr-log-phrase { color: var(--dsw-alias-state-error-primary); }
.dsh-linkr-paste { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); }
.dsh-linkr-paste-input { width: 100%; min-height: 56px; box-sizing: border-box; resize: vertical; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; outline: none; }
.dsh-linkr-paste-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-linkr-paste-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-linkr-paste-hint { font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-tertiary); }
/* The clipboard capability line: one quiet row under the metrics, a small dot
   for the state and the reason spelled out after it. It is advice, not an
   error, so the text stays secondary in both themes. */
.dsh-linkr-clip { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; max-width: 45%; min-width: 0; font-size: 11px; line-height: 1.2; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-linkr-clip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); flex: 0 0 auto; }
.dsh-linkr-log-empty { flex: 0 0 auto; padding: 2px 12px 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
`;

    /* ---------------- the plugin ---------------- */

    /**
     * What the mounted panel exposes to the panel-action channel. A closed tab
     * has no component to hear "close", so the entries are nullable and the
     * dispatcher tolerates their absence.
     */
    const panelHooks = { pause: null, resume: null, log: null };

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-linkr: dictionaries');
      const t = ctx.locale.bind(NS);

      // The right column's services, once they exist. Kept in a closure rather
      // than in the component because the agent's "open" has to work while the
      // panel is closed — a closed panel has no component to hear it.
      let column = null;

      const rightServices = () => {
        if (column !== null) return column;
        try {
          return ctx.get?.('sidebarRightTabs') ? { sidebarRightTabs: ctx.get('sidebarRightTabs'), sidebarRight: ctx.get?.('sidebarRight') } : null;
        } catch {
          return null;
        }
      };

      /** Reveal the panel: the tab if it exists, and the column always. */
      const openPanel = () => {
        let opened = false;
        const right = rightServices();
        const navigation = right && right.sidebarRight ? right.sidebarRight : null;
        try {
          // Opens the tab, focuses it when it is already open, and widens the
          // column: content the user cannot see is not "opened".
          navigation?.openTab?.(KIND);
          opened = navigation !== null && navigation !== undefined;
        } catch {
          opened = false;
        }
        try {
          // Then put the frame in its normal presentation, so the conversation
          // makes room for it instead of the panel landing on top.
          ctx.get?.('layout')?.openRightbar?.(true, false);
        } catch {
          /* a shell without the layout seat still gets the tab */
        }
        if (opened) panelHooks.resume?.();
        return opened;
      };

      /** Take the panel off screen; the stream pauses with it. */
      const closePanel = () => {
        panelHooks.pause?.();
        let closed = false;
        try {
          const layout = ctx.get?.('layout');
          if (layout && typeof layout.closeRightbar === 'function') {
            layout.closeRightbar();
            closed = true;
          }
        } catch {
          closed = false;
        }
        if (!closed) {
          const right = rightServices();
          const navigation = right && right.sidebarRight ? right.sidebarRight : null;
          try {
            if (navigation && typeof navigation.isExpanded === 'function' && navigation.isExpanded()) {
              navigation.toggleExpanded?.();
              closed = true;
            }
          } catch {
            closed = false;
          }
        }
        return closed;
      };

      const dispatchPanel = (action) => {
        if (action === 'open' || action === 'focus') {
          openPanel();
          // A focus is a reveal, not a reload: the picture keeps running.
          if (action === 'focus') panelHooks.resume?.();
        } else if (action === 'close') {
          closePanel();
        }
      };

      // One EventSource for the plugin's lifetime, not one per panel mount, so
      // closing and reopening the tab cannot leak listeners. A route that is not
      // there (an older Host) is retried with a backoff instead of hammering.
      if (typeof EventSource === 'function') {
        ctx.effect(() => {
          let source = null;
          let retry = null;
          let closed = false;
          let delay = 1500;

          const detach = () => {
            if (source === null) return;
            source.onopen = null;
            source.onmessage = null;
            source.onerror = null;
            try {
              source.close();
            } catch {
              /* already gone */
            }
            source = null;
          };

          const schedule = () => {
            if (closed || retry !== null) return;
            retry = setTimeout(connect, delay);
            delay = Math.min(Math.round(delay * 1.8), 15000);
          };

          function connect() {
            retry = null;
            if (closed) return;
            let openedAt = 0;
            try {
              source = new EventSource(PANEL_URL);
            } catch {
              schedule();
              return;
            }
            source.onopen = () => {
              openedAt = Date.now();
              delay = 1500;
            };
            source.onerror = () => {
              detach();
              schedule();
            };
            source.onmessage = (message) => {
              let record;
              try {
                record = JSON.parse(message.data);
              } catch {
                return;
              }
              if (record === null || typeof record !== 'object') return;
              // Activity is content, not control: it is handled before the
              // stale-action window, because a replayed log entry is still news.
              if (record.type === 'log') {
                panelHooks.log?.(record.entry);
                return;
              }
              if (record.type !== 'panel') return;
              // The Host replays a small backlog so a panel that mounts late
              // still hears it — but an action from before this page opened is
              // history, not a command.
              if (openedAt !== 0 && Number(record.at) > 0 && Number(record.at) < openedAt - 2000) return;
              dispatchPanel(String(record.action || ''));
            };
          }

          connect();
          return () => {
            closed = true;
            if (retry !== null) clearTimeout(retry);
            detach();
          };
        }, 'dsh-linkr: panel channel');
      }

      // The right column is a tab system: a third-party panel joins it as a TAB
      // TYPE (not by registering into `rightbar.session`, which belongs to the
      // sidebar's owner and would make its apply throw).
      ctx.inject(['sidebarRightTabs', 'sidebarRight'], (right) => {
        column = right;
        right.effect(() => () => {
          if (column === right) column = null;
        }, 'dsh-linkr: panel open path');
        right.effect(
          () =>
            right.sidebarRightTabs.register({
              id: NS,
              kind: KIND,
              multiple: false,
              title: () => t('title'),
              // The start page (and the right column's guide tab) is a doorway
              // list built from these entries: one card per panel type.
              guide: [
                {
                  id: 'screen',
                  order: 25,
                  title: () => t('guideTitle'),
                  description: () => t('guide'),
                  icon: LinkrGlyph,
                },
              ],
            }),
          'dsh-linkr: right tab type',
        );
        right.slots.inject('sidebar.right.pane.tab', () =>
          right.slots.register(
            { name: 'sidebar.right.pane.tab', key: NS, locale: NS },
            function DshLinkrPane() {
              return h(LinkrPanel, { t });
            },
          ),
        );
        right.slots.inject('sidebar.right.pane.tab.title', () =>
          right.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: NS, locale: NS },
            function DshLinkrPaneTitle() {
              return t('title');
            },
          ),
        );
      });
    }

    return { apply, inject, name };
  },
});
