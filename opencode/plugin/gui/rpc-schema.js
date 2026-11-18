/**
 * The wire contract between the plugin's server part and its GUI panel.
 *
 * The GUI window is a browser context: it cannot start the panel server itself,
 * so it asks the server part for the loopback URL through this RPC. The payloads
 * are plain JSON Schema objects, which is the form `Rpc.define` takes.
 */

export const PANEL_RPC_ID = 'opencode-linkr.panel';

const object = (properties = {}, required = []) => {
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
};

const EMPTY = object({});
const url = (description) => ({ type: 'string', description });
const boolean = (description) => ({ type: 'boolean', description });

export const OPEN_OUTPUT = object({ url: url('Loopback panel URL, including its token.'), running: boolean('The panel server is up.') }, ['url', 'running']);
export const SETTINGS_OUTPUT = object({
  baseUrl: url('Device origin, e.g. http://linkr.local'),
  username: { type: 'string', description: 'Device account name.' },
  codec: { type: 'string', enum: ['auto', 'mjpeg', 'h264'], description: 'Video path.' },
  hasPassword: boolean('A password is configured.'),
  passwordSaved: boolean('The password lives in the plugin settings file.'),
  passwordSource: { type: 'string', description: 'settings, environment or empty.' },
}, ['baseUrl', 'username', 'codec', 'hasPassword', 'passwordSaved', 'passwordSource']);
export const SAVE_INPUT = object({
  baseUrl: url('Device origin; omit to keep the current one.'),
  username: { type: 'string', description: 'Device account name; omit to keep.' },
  password: { type: 'string', description: 'New password; omit or leave empty to keep the current one.' },
  codec: { type: 'string', enum: ['auto', 'mjpeg', 'h264'], description: 'Video path; omit to keep.' },
});
export const SAVE_OUTPUT = object({ url: url('Fresh panel URL for the new configuration.'), running: boolean('The panel server is up.'), settings: SETTINGS_OUTPUT }, ['url', 'running', 'settings']);
export const STATE_OUTPUT = object({ url: url('The current URL, or an empty string.'), running: boolean('The panel server is up.') }, ['url', 'running']);
export const OK = object({ ok: boolean('The request was accepted.') }, ['ok']);

export function panelRpcDefinition() {
  return {
    id: PANEL_RPC_ID,
    methods: {
      open: { input: EMPTY, output: OPEN_OUTPUT },
      state: { input: EMPTY, output: STATE_OUTPUT },
      close: { input: EMPTY, output: OK },
      settings: { input: EMPTY, output: SETTINGS_OUTPUT },
      saveSettings: { input: SAVE_INPUT, output: SAVE_OUTPUT },
    },
    events: {},
  };
}
