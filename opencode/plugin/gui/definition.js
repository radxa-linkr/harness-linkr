/**
 * The GUI half's declarations: copy only. The host assigns the server part's id;
 * panel and command keys are built from `ctx.id` at setup time.
 */
import { Plugin } from '@opencode/plugin/gui';

export const PANEL_TAB_ID = 'screen';
export const PANEL_COMMAND_ID = 'toggle';

export const definition = Plugin.define({
  i18n: {
    en: {
      title: 'Linkr shared computer',
      'command.toggle': 'Linkr: toggle shared computer',
      'command.description': 'Show or hide the live screen of the computer behind the Linkr KVM device',
      group: 'Linkr',
      'panel.refresh': 'Reload',
      'panel.settings': 'Settings',
      'panel.openBrowser': 'Open in browser',
      'settings.baseUrl': 'Device address',
      'settings.username': 'Account',
      'settings.password': 'Password',
      'settings.passwordKept': 'Saved — leave blank to keep it',
      'settings.passwordRequired': 'Required',
      'settings.codec': 'Encoding',
      'settings.codecAuto': 'Auto',
      'settings.save': 'Save & reconnect',
      'settings.cancel': 'Cancel',
      'panel.loading': 'Starting the Linkr panel…',
      'panel.hint.rpc': 'The Linkr panel RPC is not available on this server.',
      'panel.hint.device': 'The panel is up, but the device or its login is not. Fix the Linkr settings, then reload.',
    },
    zh: {
      title: 'Linkr 共享电脑',
      'command.toggle': 'Linkr：打开/关闭共享电脑画面',
      'command.description': '显示或隐藏 Linkr KVM 设备后面那台电脑的实时画面',
      group: 'Linkr',
      'panel.refresh': '刷新',
      'panel.settings': '设置',
      'panel.openBrowser': '在浏览器打开',
      'settings.baseUrl': '设备地址',
      'settings.username': '账号',
      'settings.password': '密码',
      'settings.passwordKept': '已保存，留空则不修改',
      'settings.passwordRequired': '必填',
      'settings.codec': '编码格式',
      'settings.codecAuto': '自动',
      'settings.save': '保存并重连',
      'settings.cancel': '取消',
      'panel.loading': '正在启动 Linkr 面板…',
      'panel.hint.rpc': '这个服务端没有提供 Linkr 面板 RPC。',
      'panel.hint.device': '面板已启动，但设备或账号不可用。检查 Linkr 设置后刷新。',
    },
  },
});
