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
 * Build the same config object the MCP server uses, with plugin options taking
 * precedence over the environment.
 */
/**
 * The project directory this plugin was loaded for, when the host reports it.
 * Captures default to `<project>/.linkr/captures` so the model can read the
 * image without an external-directory permission prompt.
 */
export function projectDirectory(location) {
  const directory = location?.directory;
  return typeof directory === 'string' && directory !== '' ? directory : '';
}

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

/** Plain `{ name, description, input, execute }` infos for `editor.add()`. */
export function nativeTools(tools, { projectDir = '' } = {}) {
  const definitions = TOOLS.filter((tool) => TOOL_IDS.includes(tool.name));
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
    const config = configFromOptions(ctx?.options ?? {});
    const projectDir = projectDirectory(ctx?.location);
    // Keep captures inside the session's directory unless the user chose a
    // path (or the environment did): the agent can then read the JPEG.
    if (projectDir !== '' && !ctx?.options?.saveDir && !process.env.LINKR_SAVE_DIR) {
      config.saveDir = join(projectDir, '.linkr', 'captures');
    }
    const tools = createLinkrTools(config);
    const panelFps = Math.max(2, Math.min(15, Number(config.client.fps) || 10));
    let panel = null;
    const panelTool = {
      ...PANEL_TOOL,
      execute: async (args = {}) => {
        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
        if (action === 'open') {
          if (panel === null) panel = await createPanelServer({ tools, fps: panelFps });
          return {
            content: [
              { type: 'text', text: `Linkr 面板已启动：${panel.url}\n在浏览器打开即可观看和操作；面板与 agent 共用同一个设备会话。` },
            ],
            metadata: { url: panel.url },
          };
        }
        if (action === 'state') {
          return {
            content: [{ type: 'text', text: panel === null ? 'Linkr 面板未启动；用 action "open" 启动。' : `Linkr 面板：${panel.url}` }],
            metadata: panel === null ? {} : { url: panel.url },
          };
        }
        if (action === 'close') {
          if (panel !== null) {
            await panel.close();
            panel = null;
          }
          return { content: [{ type: 'text', text: 'Linkr 面板已关闭。' }] };
        }
        throw new Error('action must be "open", "state" or "close"');
      },
    };
    await ctx.tool.transform((editor) => {
      for (const tool of nativeTools(tools, { projectDir })) editor.add(tool);
      editor.add(panelTool);
    });
    return async () => {
      if (panel !== null) {
        await panel.close();
        panel = null;
      }
      await tools.dispose();
    };
  },
});
