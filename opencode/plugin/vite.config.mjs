/**
 * Builds the plugin's `./gui-experimental` bundle (dist/gui-experimental.cjs).
 * The OpenCode GUI preset compiles the Solid JSX, externalizes the modules the
 * desktop app provides and writes one CommonJS file.
 */
import { defineConfig } from 'vite';
import { gui } from '@opencode/plugin/gui/vite';

export default defineConfig({
  plugins: [gui({ entry: 'gui/index.jsx', outFile: 'dist/gui-experimental.cjs' })],
});
