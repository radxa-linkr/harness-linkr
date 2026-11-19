/**
 * OpenCode 2.x native plugin for Linkr KVM.
 *
 * OpenCode imports this package and calls `setup(ctx)`; the plugin contributes
 * two first-class tools, `linkr_status` and `linkr_computer_use`, through
 * `ctx.tool.transform()`. They are the same tools the MCP server exposes, backed
 * by the same `mcp-linkr` runtime and the same transport, so a machine can use
 * either integration without changing behaviour.
 *
 * Configuration comes from the `options` object of the `plugins` entry in
 * `opencode.json`; environment variables fill in whatever is absent (the same
 * `LINKR_*` names the MCP adapter uses). Loading never touches the device: no
 * session is opened and no ffmpeg is spawned until a tool call asks for one.
 *
 * This is the repository-local build: it imports `../../mcp-linkr/`. Run
 * `node scripts/sync-core.mjs` once in the checkout (materializes the transport)
 * before loading it. A published npm package would bundle that runtime.
 */
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Plugin } from '@opencode/plugin';

import { readConfig } from '../../mcp-linkr/config.js';
import { createLinkrTools, TOOLS } from '../../mcp-linkr/tools.js';
import { createPanelServer } from './panel-server.js';
import LinkrPanelRpc from './gui/rpc.js';
import { publicSettings, readSettings, validatePatch, writeSettings } from './settings.js';

export const id = 'opencode-linkr';

/** The tool names this plugin registers (`ctx.tool.list()` ids). */
export const TOOL_IDS = Object.freeze(['linkr_status', 'linkr_computer_use', 'linkr_panel']);

/** `options` keys that map 1:1 onto the MCP adapter's environment variables. */
const ENV_BY_OPTION = {
  baseUrl: 'LINKR_BASE_URL',
  username: 'LINKR_USERNAME',
  password: 'LINKR_PASSWORD',
  passwordFile: 'LINKR_PASSWORD_FILE',
  codec: 'LINKR_CODEC',
  streamFps: 'LINKR_STREAM_FPS',
  jpegQuality: 'LINKR_JPEG_QUALITY',
  ffmpegPath: 'LINKR_FFMPEG_PATH',
  saveDir: 'LINKR_SAVE_DIR',
  idleStopMs: 'LINKR_IDLE_STOP_MS',
  manageVideoMode: 'LINKR_MANAGE_VIDEO_MODE',
};

/**
 * The project directory this plugin was loaded for, when the host reports it.
 * Captures default to `<project>/.linkr/captures` so the model can read the
 * image without an external-directory permission prompt.
 */
export function projectDirectory(location) {
  const directory = location?.directory;
  return typeof directory === 'string' && directory !== '' ? directory : '';
}

/**
 * The same config object the MCP server uses: plugin options first, then the
 * environment, then the saved settings file (merged by setup).
 */
export function configFromOptions(options = {}, env = process.env) {
  const merged = { ...env };
  for (const [option, variable] of Object.entries(ENV_BY_OPTION)) {
    const value = options?.[option];
    if (value === undefined || value === null || value === '') continue;
    merged[variable] = String(value);
  }
  return readConfig(merged);
}

/**
 * MCP content blocks → OpenCode tool content.
 *
 * A capture is reported as a file content block pointing at the JPEG the
 * runtime already saved (the model sees the image), followed by the same text
 * the MCP tool returns (size, path, the untrusted-data reminder).
 */
export function toContent(result, { projectDir = '' } = {}) {
  const content = [];
  const saved = typeof result?.value?.path === 'string' ? result.value.path : '';
  // Only reference the file when the session may read it; a capture saved
  // outside the project would otherwise show a permission error to the model.
  const readable = saved !== '' && (projectDir === '' || saved.startsWith(projectDir));
  if (readable) {
    content.push({ type: 'file', uri: pathToFileURL(saved).href, mime: 'image/jpeg', name: basename(saved) });
  }
  for (const block of result?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
  }
  if (content.length === 0) content.push({ type: 'text', text: '(no output)' });
  return content;
}

/** The panel tool is plugin-specific (the MCP adapter has its own panel tool). */
const PANEL_TOOL = {
  name: 'linkr_panel',
  description:
    'Open or close the Linkr live screen panel. "open" starts a local, token-gated page on 127.0.0.1 ' +
    'and returns its URL; the page shows the same session these tools drive (live MJPEG, pointer and ' +
    'keyboard input, paste, recent activity) so a person can watch and take over. "state" reports the ' +
    'running panel URL. "close" stops the page. The panel is loopback-only and cannot be reached from ' +
    'the network.',
  input: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'state', 'close'], description: 'open | state | close' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

/** The MCP tool names this plugin re-exports (the panel tool is plugin-local). */
const NATIVE_TOOL_IDS = Object.freeze(['linkr_status', 'linkr_computer_use']);

/** Plain `{ name, description, input, execute }` infos for `editor.add()`. */
export function nativeTools(tools, { projectDir = '' } = {}) {
  const definitions = TOOLS.filter((tool) => NATIVE_TOOL_IDS.includes(tool.name));
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    input: definition.inputSchema,
    execute: async (args = {}, context = {}) => {
      const result = await tools.callTool(definition.name, args ?? {}, { signal: context.signal });
      if (result?.isError) {
        const text = (result.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();
        throw new Error(text === '' ? 'Linkr call failed' : text);
      }
      const metadata = result?.value && typeof result.value === 'object' ? result.value : {};
      return { content: toContent(result, { projectDir }), metadata };
    },
  }));
}

export default Plugin.define({
  id,
  async setup(ctx) {
    const projectDir = projectDirectory(ctx?.location);
    // Saved settings (written by the panel's form) outrank the opencode.json
    // options and the LINKR_* environment, so a person can fix a connection
    // without editing JSON. Loading never touches the device.
    let saved = await readSettings();
    const buildConfig = () => {
      const mergedOptions = { ...(ctx?.options ?? {}), ...saved };
      const next = configFromOptions(mergedOptions);
      // Keep captures inside the session's directory unless the user chose a
      // path (or the environment did): the agent can then read the JPEG.
      if (projectDir !== '' && !mergedOptions.saveDir && !process.env.LINKR_SAVE_DIR) {
        next.saveDir = join(projectDir, '.linkr', 'captures');
      }
      return next;
    };
    let config = buildConfig();
    // The tools are rebuilt when the settings change; the registered tools, the
    // panel server and the GUI all talk to this stable facade.
    const runtime = { current: createLinkrTools(config) };
    const linkr = {
      callTool: (...args) => runtime.current.callTool(...args),
      onFrame: (listener) => runtime.current.onFrame(listener),
      panelState: () => runtime.current.panelState(),
      keepAlive: () => runtime.current.keepAlive?.(),
      stop: () => runtime.current.stop(),
      latest: () => runtime.current.latest(),
    };
    let panelFps = Math.max(2, Math.min(15, Number(config.client.fps) || 10));
    let panel = null;
    const openPanel = async () => {
      if (panel === null) panel = await createPanelServer({ tools: linkr, fps: panelFps });
      return panel;
    };
    const closePanel = async () => {
      if (panel === null) return;
      const running = panel;
      panel = null;
      await running.close();
    };
    const panelUrl = () => (panel === null ? '' : panel.url);

    /** Persist a settings patch, rebuild the device tools and restart the panel. */
    const applySettings = async (patch) => {
      const clean = validatePatch(patch ?? {});
      const next = { ...saved, ...clean };
      await writeSettings(next);
      saved = next;
      config = buildConfig();
      panelFps = Math.max(2, Math.min(15, Number(config.client.fps) || 10));
      await closePanel();
      const previous = runtime.current;
      runtime.current = createLinkrTools(config);
      await previous.dispose();
      const server = await openPanel();
      return { url: server.url, running: true, settings: publicSettings(config, saved) };
    };

    // The desktop-app GUI panel is a browser window: it asks this RPC for the
    // loopback URL instead of starting a server itself.
    await ctx.rpc.register(LinkrPanelRpc, {
      open: async () => {
        const server = await openPanel();
        return { url: server.url, running: true };
      },
      state: async () => ({ url: panelUrl(), running: panel !== null }),
      close: async () => {
        await closePanel();
        return { ok: true };
      },
      settings: async () => publicSettings(config, saved),
      saveSettings: async (input) => applySettings(input ?? {}),
    });

    const panelTool = {
      ...PANEL_TOOL,
      execute: async (args = {}) => {
        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
        if (action === 'open') {
          const server = await openPanel();
          return {
            content: [
              { type: 'text', text: `Linkr 面板已启动：${server.url}\n在浏览器打开即可观看和操作；面板与 agent 共用同一个设备会话。` },
            ],
            metadata: { url: server.url },
          };
        }
        if (action === 'state') {
          const running = panel !== null;
          return {
            content: [{ type: 'text', text: running ? `Linkr 面板：${panelUrl()}` : 'Linkr 面板未启动；用 action "open" 启动。' }],
            metadata: running ? { url: panelUrl() } : {},
          };
        }
        if (action === 'close') {
          await closePanel();
          return { content: [{ type: 'text', text: 'Linkr 面板已关闭。' }] };
        }
        throw new Error('action must be "open", "state" or "close"');
      },
    };
    await ctx.tool.transform((editor) => {
      for (const tool of nativeTools(linkr, { projectDir })) editor.add(tool);
      editor.add(panelTool);
    });
    return async () => {
      await closePanel();
      await runtime.current.dispose();
    };
  },
});
