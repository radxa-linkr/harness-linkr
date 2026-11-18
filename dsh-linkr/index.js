/**
 * Host half of the dsh-linkr bundle.
 *
 * Turns a Linkr KVM-over-IP device into the agent's eyes and hands on the
 * controlled host computer: the tools capture the host's screen and inject
 * mouse/keyboard input, and the routes serve the same live session to the
 * Web UI's right-column screen panel.
 *
 * One operation, two callers: every tool and every route goes through the one
 * `LinkrClient` this plugin creates — there is no second input path and no
 * second session. The panel and the agent therefore always see the same host,
 * at the same moment, on the same media socket.
 *
 * This file is wiring only. The modules under `host/` own the config schema,
 * the activity ring, the client lifecycle, the routes and the tools; they share
 * exactly one `deps` object, created per apply, so nothing leaks between two
 * applied plugins.
 *
 * No package imports at all: a linked bundle resolves modules from the workspace,
 * which cannot see the DSH installation, so this file uses Node built-ins plus
 * the transport half of this same package (`./lib`). Row config fields are
 * documented in cordis.patch.yml and docs/CONTRACT.md section 3.
 */
import { createActivity, createPanelChannel } from './host/activity.js';
import { createClientManager } from './host/client.js';
import { Config, normalizeConfig } from './host/config.js';
import { registerRoutes } from './host/routes.js';
import { registerTools } from './host/tools.js';

export { Config };

export const name = 'linkr';
export const inject = ['tools', 'webServer'];

export function apply(ctx, rawConfig) {
  /**
   * The one bundle of state every module below reads and writes. Created per
   * apply: the client, the activity ring and the panel subscribers belong to
   * this applied plugin and are never module-level.
   */
  const deps = {
    ctx,
    /** The row config this run reads from; a settings write updates it in place. */
    config: normalizeConfig(rawConfig),
    /**
     * Set by `POST /linkr/disconnect`: a person stopped the session, so nothing
     * the panel does on its own (a retrying `<img>`, a stray frame request) may
     * start it again — the device belongs to other clients until somebody asks
     * explicitly. `POST /linkr/connect`, a tool call and a settings write all
     * clear it.
     */
    explicitStop: false,
  };

  deps.panel = createPanelChannel();
  deps.activity = createActivity(deps.panel);
  deps.client = createClientManager(deps);

  ctx.effect(
    () => () => {
      // Disposing must leave nothing behind: no live stream (the route effect
      // stopped those first), no SSE subscriber, no session still holding the
      // device in MJPEG mode.
      deps.panel.closeAll();
      deps.client.dispose();
    },
    'linkr: release the device session',
  );

  ctx.effect(() => registerRoutes(ctx, deps), 'linkr: screen and panel route');
  ctx.effect(() => registerTools(ctx, deps), 'linkr: agent tools');
}
