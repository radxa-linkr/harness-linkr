/**
 * The GUI panel body: an iframe of the plugin's own loopback web panel.
 *
 * The window side cannot read files or start servers, so it asks the server part
 * for the panel URL over the `opencode-linkr.panel` RPC. The page itself is the
 * same one `linkr_panel` returns: live screen, pointer/keyboard input, paste,
 * screenshots and activity. The panel is loaded with `&embed=1` so the page can
 * drop its page chrome for the sidebar.
 */
import { createSignal, onMount, Show } from 'solid-js';

import { usePlugin } from '@opencode/plugin/gui';

import { definition } from './definition.js';
import PanelRpc from './rpc.js';

export function ScreenPanel() {
  const ctx = usePlugin();
  const [url, setUrl] = createSignal('');
  const [error, setError] = createSignal('');
  const [nonce, setNonce] = createSignal(0);

  const withEmbed = (raw) => `${raw}${raw.includes('?') ? '&' : '?'}embed=1`;

  async function start() {
    setError('');
    try {
      if (!ctx.client) throw new Error(ctx.t('panel.hint.rpc'));
      const rpc = ctx.client.rpc(PanelRpc);
      const answer = await rpc.open({});
      if (!answer || typeof answer.url !== 'string' || answer.url === '') throw new Error(ctx.t('panel.hint.rpc'));
      setUrl(withEmbed(answer.url));
      setNonce((value) => value + 1);
    } catch (cause) {
      setError(String(cause && cause.message ? cause.message : cause));
    }
  }

  onMount(() => {
    void start();
  });

  return (
    <div class="linkr-gui">
      <header>
        <span class="name">{ctx.t('title')}</span>
        <span class="spacer" />
        <Show when={url() !== ''}>
          <button type="button" onClick={() => setNonce((value) => value + 1)}>
            {ctx.t('panel.refresh')}
          </button>
          <button type="button" onClick={() => window.open(url(), '_blank', 'noopener')}>
            {ctx.t('panel.openBrowser')}
          </button>
        </Show>
      </header>
      <Show
        when={error() === ''}
        fallback={<div class="status error">{error()}</div>}
      >
        <Show when={url() !== ''} fallback={<div class="status">{ctx.t('panel.loading')}</div>}>
          <div class="frame">
            <iframe
              title={ctx.t('title')}
              src={`${url()}&n=${nonce()}`}
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}

export { definition };
