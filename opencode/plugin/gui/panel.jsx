/**
 * The GUI panel body: an iframe of the plugin's own loopback web panel.
 *
 * The window side cannot read files or start servers, so it asks the server part
 * for the panel URL over the `opencode-linkr.panel` RPC. The page itself is the
 * same one `linkr_panel` returns: live screen, pointer/keyboard input, paste,
 * screenshots and activity. It is loaded with `&embed=1` (sidebar chrome) and
 * `&theme=<app appearance>` (light/dark follows OpenCode).
 *
 * The page reports a fatal fetch/stream error with `postMessage`; the panel then
 * asks the RPC for a fresh URL and reloads the iframe. That covers the case where
 * the plugin server was reloaded and the old panel port is gone (the page then
 * shows "Failed to fetch" while the iframe URL is stale).
 *
 * The header also carries the connection settings form: address, account,
 * password (blank keeps the current one) and codec. Saving writes the plugin's
 * settings file and rebuilds the device tools, returning a new panel URL.
 */
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';

import { usePlugin } from '@opencode/plugin/gui';

import { definition } from './definition.js';
import PanelRpc from './rpc.js';

export function ScreenPanel() {
  const ctx = usePlugin();
  const [rawUrl, setRawUrl] = createSignal('');
  const [nonce, setNonce] = createSignal(0);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [info, setInfo] = createSignal(null);
  const [form, setForm] = createSignal({ baseUrl: '', username: '', password: '', codec: 'auto' });

  /** Host appearance, so the page follows the app instead of the OS. */
  const mode = createMemo(() => (ctx.appearance?.mode?.() === 'light' ? 'light' : 'dark'));

  const frameUrl = () => {
    if (rawUrl() === '') return '';
    const url = new URL(rawUrl());
    url.searchParams.set('embed', '1');
    url.searchParams.set('theme', mode());
    url.searchParams.set('n', String(nonce()));
    return url.toString();
  };

  const client = () => {
    if (!ctx.client) throw new Error(ctx.t('panel.hint.rpc'));
    return ctx.client.rpc(PanelRpc);
  };

  async function start() {
    setError('');
    try {
      const answer = await client().open({});
      if (!answer || typeof answer.url !== 'string' || answer.url === '') throw new Error(ctx.t('panel.hint.rpc'));
      setRawUrl(answer.url);
      setNonce((value) => value + 1);
    } catch (cause) {
      setError(String(cause && cause.message ? cause.message : cause));
    }
  }

  async function openSettings() {
    try {
      const current = await client().settings({});
      setInfo(current);
      setForm({ baseUrl: current.baseUrl, username: current.username, password: '', codec: current.codec });
      setNotice('');
      setEditing(true);
    } catch (cause) {
      setError(String(cause && cause.message ? cause.message : cause));
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    try {
      const patch = { baseUrl: form().baseUrl, username: form().username, codec: form().codec };
      if (form().password !== '') patch.password = form().password;
      const answer = await client().saveSettings(patch);
      setInfo(answer.settings);
      setRawUrl(answer.url);
      setNonce((value) => value + 1);
      setEditing(false);
      setNotice('');
    } catch (cause) {
      setNotice(String(cause && cause.message ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  let retryTimer = null;
  onMount(() => {
    void start();
    const onMessage = (event) => {
      const data = event?.data;
      if (!data || typeof data !== 'object' || data.type !== 'linkr-panel-error') return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        void start();
      }, 1500);
    };
    window.addEventListener('message', onMessage);
    onCleanup(() => {
      window.removeEventListener('message', onMessage);
      clearTimeout(retryTimer);
    });
  });

  // Follow a live appearance change without re-requesting the URL.
  createEffect(() => {
    mode();
    if (rawUrl() !== '') setNonce((value) => value + 1);
  });

  return (
    <div class={`linkr-gui ${mode()}`}>
      <header>
        <span class="name">{ctx.t('title')}</span>
        <span class="spacer" />
        <Show when={rawUrl() !== '' || editing()}>
          <button type="button" onClick={() => void openSettings()} disabled={busy()}>
            {ctx.t('panel.settings')}
          </button>
        </Show>
        <button type="button" onClick={() => void start()} disabled={busy()}>
          {ctx.t('panel.refresh')}
        </button>
        <Show when={rawUrl() !== ''}>
          <button type="button" onClick={() => window.open(rawUrl(), '_blank', 'noopener')}>
            {ctx.t('panel.openBrowser')}
          </button>
        </Show>
      </header>

      <Show when={editing()}>
        <form class="settings" onSubmit={saveSettings}>
          <label>
            {ctx.t('settings.baseUrl')}
            <input
              value={form().baseUrl}
              placeholder="http://linkr.local"
              onInput={(event) => setForm({ ...form(), baseUrl: event.currentTarget.value })}
            />
          </label>
          <label>
            {ctx.t('settings.username')}
            <input
              value={form().username}
              placeholder="admin"
              onInput={(event) => setForm({ ...form(), username: event.currentTarget.value })}
            />
          </label>
          <label>
            {ctx.t('settings.password')}
            <input
              type="password"
              value={form().password}
              placeholder={info()?.hasPassword ? ctx.t('settings.passwordKept') : ctx.t('settings.passwordRequired')}
              onInput={(event) => setForm({ ...form(), password: event.currentTarget.value })}
            />
          </label>
          <label>
            {ctx.t('settings.codec')}
            <select value={form().codec} onChange={(event) => setForm({ ...form(), codec: event.currentTarget.value })}>
              <option value="auto">{ctx.t('settings.codecAuto')}</option>
              <option value="h264">H.264</option>
              <option value="mjpeg">MJPEG</option>
            </select>
          </label>
          <Show when={notice() !== ''}>
            <p class="notice">{notice()}</p>
          </Show>
          <div class="settings-actions">
            <button class="primary" type="submit" disabled={busy()}>
              {ctx.t('settings.save')}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy()}>
              {ctx.t('settings.cancel')}
            </button>
          </div>
        </form>
      </Show>

      <Show when={error() === ''} fallback={<div class="status error">{error()}</div>}>
        <Show when={rawUrl() !== ''} fallback={<div class="status">{ctx.t('panel.loading')}</div>}>
          <div class="frame">
            <iframe
              title={ctx.t('title')}
              src={frameUrl()}
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}

export { definition };
