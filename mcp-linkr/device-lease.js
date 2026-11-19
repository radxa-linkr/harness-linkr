/** An OS-held, cross-process lease. SIGKILL releases it without stale lock files. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { normalizeOrigin, LinkrError } from '../dsh-linkr/lib/linkr.js';

export function leasePort(origin) {
  const key = normalizeOrigin(origin);
  return 30000 + (createHash('sha256').update(key).digest().readUInt32BE(0) % 30000);
}

export async function acquireDeviceLease(origin) {
  const port = leasePort(origin);
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', error => reject(error));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (error) {
    server.close?.();
    throw new LinkrError('device session is busy', {
      sentence: error.code === 'EADDRINUSE'
        ? `another local Linkr session or application holds device lease port ${port}; stop that session before connecting to ${normalizeOrigin(origin)}`
        : `could not acquire the local device lease: ${error.message}`,
    });
  }
  server.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise(resolve => server.close(resolve));
  };
}
