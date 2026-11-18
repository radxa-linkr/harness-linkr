/**
 * The package's `./gui-experimental` entry: the Linkr screen panel in OpenCode's
 * desktop app windows. The build (`vite build --config vite.config.mjs`) writes
 * `dist/gui-experimental.cjs`; the host evaluates that file inside every app
 * window and runs `setup` there.
 */
import { Command, MenuItem, Panel, Plugin, Style } from '@opencode/plugin/gui';

import guiCss from './panel.css?inline';
import { PANEL_COMMAND_ID, PANEL_TAB_ID, definition } from './definition.js';
import { ScreenPanel } from './panel.jsx';

export { definition };

function panelKey(ctx) {
  return `${ctx.id}:${PANEL_TAB_ID}`;
}

export default Plugin.define({
  ...definition,
  setup(ctx) {
    ctx.add(Style, guiCss);

    /** Opens the panel tab, or closes it when it is already on screen. */
    const toggle = () => {
      const session = ctx.sessions.current();
      if (!session) return;
      ctx.layout.toggle(panelKey(ctx), session);
    };

    const tab = {
      id: PANEL_TAB_ID,
      get title() {
        return ctx.t('title');
      },
      closable: 'compact',
    };

    ctx.add(Panel, {
      id: PANEL_TAB_ID,
      region: 'side',
      width: 560,
      mobile: {
        get title() {
          return ctx.t('title');
        },
        order: 20,
        kind: 'drawer',
        icon: 'monitor',
        cached: true,
      },
      list: (input) => (input.open.includes(PANEL_TAB_ID) ? [tab] : []),
      render: () => <ScreenPanel />,
    });

    ctx.add(Command, () => ({
      id: PANEL_COMMAND_ID,
      title: ctx.t('command.toggle'),
      description: ctx.t('command.description'),
      keywords: 'linkr kvm computer screen remote desktop',
      group: ctx.t('group'),
      section: 'terminal',
      bind: 'ctrl+alt+l',
      run: toggle,
    }));

    ctx.add(MenuItem, () => ({
      menu: 'session.panel',
      id: PANEL_TAB_ID,
      title: ctx.t('title'),
      icon: 'monitor',
      keybind: `${ctx.id}.${PANEL_COMMAND_ID}`,
      order: 100,
      run: toggle,
    }));
  },
});
