/**
 * Device-mode recovery for the MCP server.
 *
 * The journal and the HTTP restore live in the shared transport
 * (`core/journal.js` / `core/recover.js`, materialized under `dsh-linkr/lib/`)
 * so the MCP server and the DSH plugin heal a device the same way. This module
 * adds what is specific to the MCP server: the cross-process device lease must
 * be held while a stale session is repaired.
 */
import { acquireDeviceLease } from './device-lease.js';
import {
  clearJournal,
  journalPath,
  readJournal,
  readJournals,
  stateDirectory,
  writeJournal,
} from '../dsh-linkr/lib/journal.js';
import { recoverStaleSession as recoverOrigin } from '../dsh-linkr/lib/recover.js';

export { clearJournal, journalPath, readJournal, readJournals, stateDirectory, writeJournal };

/**
 * Heal the journal left by a dead MCP server for this device.
 *
 * `config` is the MCP config (`{ client }`) or a plain `{ baseUrl, username,
 * password }` connection. Returns `{ recovered, mode, reason }`; never throws
 * for a missing journal or an unreachable device.
 */
export async function recoverStaleSession(config, log = () => {}, { leaseHeld = false } = {}) {
  const client = config?.client ?? config;
  let release;
  if (!leaseHeld) {
    try {
      release = await acquireDeviceLease(client.baseUrl);
    } catch (error) {
      return { recovered: false, reason: error.message };
    }
  }
  try {
    return await recoverOrigin(
      { baseUrl: client.baseUrl, username: client.username, password: client.password },
      log,
      { allowSamePid: false },
    );
  } finally {
    await release?.();
  }
}
