/**
 * Heal a device left in a session video mode by a killed process.
 *
 * Reads the shared journal (core/journal.js), refuses to touch a session whose
 * owner is still alive, and restores the recorded baseline mode over HTTP. The
 * MCP server wraps this in its cross-process device lease; the DSH plugin calls
 * it before it builds its first client.
 */
import { LinkrDevice } from './linkr.js';
import { clearJournal, pidAlive, readJournal, sameOrigin } from './journal.js';

/**
 * @param {{ baseUrl: string, username: string, password: string }} connection
 * @param {(message: string) => void} [log]
 * @param {{ ownerPid?: number, allowSamePid?: boolean }} [options]
 * @returns {Promise<{ recovered: boolean, mode?: number, reason?: string }>}
 */
export async function recoverStaleSession(connection, log = () => {}, { ownerPid = process.pid, allowSamePid = false } = {}) {
  const journal = await readJournal(connection.baseUrl);
  if (journal === undefined) return { recovered: false, reason: 'no journal' };
  if (!sameOrigin(journal.origin, connection.baseUrl)) {
    return { recovered: false, reason: `journal belongs to ${journal.origin}` };
  }
  const ownedByCaller = journal.pid === ownerPid;
  if (ownedByCaller && !allowSamePid) {
    return { recovered: false, reason: 'journal belongs to this process' };
  }
  if (!ownedByCaller && Number.isInteger(journal.pid) && pidAlive(journal.pid)) {
    return { recovered: false, reason: `session still owned by pid ${journal.pid}` };
  }
  if (!Number.isFinite(journal.baselineMode)) {
    await clearJournal({ force: true, origin: connection.baseUrl });
    return { recovered: false, reason: 'journal has no baseline mode' };
  }
  try {
    const device = new LinkrDevice(connection);
    await device.setVideoMode(journal.baselineMode);
    const mode = await device.videoMode();
    if (mode !== journal.baselineMode) throw new Error('device did not confirm the restored video mode');
    await clearJournal({ force: true, origin: connection.baseUrl });
    log(`restored the device video mode to ${mode} after an unclean shutdown`);
    return { recovered: true, mode };
  } catch (error) {
    log(`could not restore the device video mode: ${error.message}`);
    return { recovered: false, reason: error.message };
  }
}
