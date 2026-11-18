/** Surgical TOML edits: preserve unrelated sections and all per-tool policies. */
function statements(source) {
  const result = [];
  let start = 0, quote = '', triple = false, depth = 0, comment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (comment) {
      if (ch !== '\n') continue;
      comment = false;
    } else if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (triple && source.slice(i, i + 3) === quote.repeat(3)) { quote = ''; triple = false; i += 2; }
      else if (!triple && ch === quote) quote = '';
      continue;
    } else if (ch === '#') comment = true;
    else if (ch === '"' || ch === "'") {
      quote = ch; triple = source.slice(i, i + 3) === ch.repeat(3);
      if (triple) i += 2;
    } else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    if (ch === '\n' && !quote && depth === 0) {
      result.push({ start, end: i + 1, text: source.slice(start, i + 1) }); start = i + 1;
    }
  }
  if (start < source.length) result.push({ start, end: source.length, text: source.slice(start) });
  return result;
}

function header(text) {
  const match = text.trim().match(/^\[([^\[\]]+)\]\s*(?:#.*)?$/);
  if (!match) return null;
  const parts = match[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+/g);
  if (!parts) return null;
  return parts.map(part => part.startsWith('"') ? JSON.parse(part) : part.startsWith("'") ? part.slice(1, -1) : part).join('.');
}

export function updateCodexConfig(source, { command, server, environment, previous }) {
  const rows = statements(source);
  let section = '';
  let root;
  let envStart;
  let envEnd = source.length;
  const edits = [];
  for (const row of rows) {
    const next = header(row.text);
    if (next) {
      if (section === 'mcp_servers.linkr.env') envEnd = row.start;
      section = next;
      if (section === 'mcp_servers.linkr') root = row;
      if (section === 'mcp_servers.linkr.env') envStart = row.start;
      continue;
    }
    if (section === 'mcp_servers.linkr' && /^\s*(?:command|args|env)\s*=/.test(row.text)) edits.push({ start: row.start, end: row.end, text: '' });
  }
  if (!root && previous) throw new Error('the existing Linkr TOML uses an inline or unsupported table; configuration was left unchanged, merge codex/config.toml.example by hand');
  const merged = { ...(previous?.transport?.env ?? {}), ...environment };
  delete merged.LINKR_PASSWORD;
  delete merged.LINKR_CREDENTIALS_FILE;
  const envBlock = `[mcp_servers.linkr.env]\n${Object.entries(merged).map(([key, value]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${JSON.stringify(value)}`).join('\n')}\n`;
  const transport = `command = ${JSON.stringify(command)}\nargs = [${JSON.stringify(server)}]\n`;
  if (!root) return `${source.trimEnd()}\n\n[mcp_servers.linkr]\n${transport}\n${envBlock}`;
  edits.push({ start: root.end, end: root.end, text: `${root.text.endsWith('\n') ? '' : '\n'}${transport}` });
  if (envStart !== undefined) edits.push({ start: envStart, end: envEnd, text: `${envBlock}\n` });
  else edits.push({ start: source.length, end: source.length, text: `\n${envBlock}` });
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
