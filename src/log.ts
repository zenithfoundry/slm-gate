/**
 * The one logger for every slm-gate process: one plain line per call on stderr, `level [scope] message k=v ...`.
 * stderr only, because stdout is a command's own output and, in the MCP server, the stdio transport.
 * Scopes are the words operators already grep for (`[mcp-gate]`, `[ledger]`, ...). Never pass a secret as a field.
 */
type Fields = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'string') return value === '' || /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function write(level: 'info' | 'warn' | 'error', scope: string, message: string, fields?: Fields): void {
  const tail = Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}=${formatValue(value)}`)
    .join('');
  // console.error rather than process.stderr.write: tests silence logs by stubbing it, and the MCP server
  // points console.log at it in stdio mode.
  console.error(`${level} [${scope}] ${message}${tail}`);
}

export const log = {
  info: (scope: string, message: string, fields?: Fields): void => write('info', scope, message, fields),
  warn: (scope: string, message: string, fields?: Fields): void => write('warn', scope, message, fields),
  error: (scope: string, message: string, fields?: Fields): void => write('error', scope, message, fields),
};
