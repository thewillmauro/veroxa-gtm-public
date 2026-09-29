// Minimal structured logger: one JSON object per line on stdout/stderr.
// Grep-able locally, ingestible by any log drain later. No dependency.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// Field names whose values are always masked, wherever they appear.
const REDACT_KEYS = /(secret|token|password|api[_-]?key|authorization|service[_-]?role)/i

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  base?: LogFields
  write?: (line: string, level: LogLevel) => void
  now?: () => Date
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1)
  }
  return out
}

function defaultWrite(line: string, level: LogLevel): void {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.level ?? 'info']
  const base = options.base ?? {}
  const write = options.write ?? defaultWrite
  const now = options.now ?? (() => new Date())

  const log = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < min) return
    const entry = redact({ ...base, ...fields }) as LogFields
    write(JSON.stringify({ ts: now().toISOString(), level, msg, ...entry }), level)
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  }
}
