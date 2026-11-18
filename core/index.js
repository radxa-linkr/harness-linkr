/**
 * Linkr transport surface (CONTRACT.md §2; single source in core/).
 *
 * This directory is the source of truth. `scripts/sync-core.mjs` materializes it
 * into `dsh-linkr/lib/` for the plugin package (and the MCP bundle build copies
 * that materialized copy), so a packaged plugin never references a path outside
 * its own package.
 */

export { LinkrClient, LinkrError } from './client.js';
export { encodeKey, encodeMouse, keyEventsForText, parseCombo, KEY_TABLE } from './hid.js';
