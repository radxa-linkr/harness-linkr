import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const server = fileURLToPath(new URL('../index.js', import.meta.url));
export function startMcp(env) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let nextId = 0;
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line); const waiter = pending.get(message.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message.result ?? { isError: true, error: message.error }); }
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.resolve({ processExited: true }); }
    pending.clear();
  });
  function request(method, params) {
    const id = ++nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timed out: ${method}`)); }, 20000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    return { id, result };
  }
  async function close(signal) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    if (signal) child.kill(signal); else child.stdin.end();
    await done;
  }
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const tool = (name, args = {}) => request('tools/call', { name, arguments: args });
  return { child, request, notify, tool, close };
}
