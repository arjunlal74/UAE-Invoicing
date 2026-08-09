/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free and deliberately redacting: invoice payloads
 * carry TRNs and buyer names, and log aggregation is one of the easiest ways
 * for tax data to leave the UAE region by accident.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'mfaSecret',
  'mfa_secret',
  'mfaCode',
  'clientSecret',
  'apiKey',
  'webhookSecret',
  'credentials',
  'credentialsCipher',
  'credentials_cipher',
  'secret',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[configured] ?? LEVELS.info;
}

function emit(level: Level, contextOrMessage: unknown, maybeMessage?: string) {
  if (LEVELS[level] < threshold()) return;

  const [context, message] =
    typeof contextOrMessage === 'string'
      ? [undefined, contextOrMessage]
      : [contextOrMessage, maybeMessage ?? ''];

  const record = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (c: unknown, m?: string) => emit('debug', c, m),
  info: (c: unknown, m?: string) => emit('info', c, m),
  warn: (c: unknown, m?: string) => emit('warn', c, m),
  error: (c: unknown, m?: string) => emit('error', c, m),
  child(bindings: Record<string, unknown>) {
    return {
      debug: (c: unknown, m?: string) => emit('debug', { ...bindings, ...(typeof c === 'object' && c ? c : {}) }, typeof c === 'string' ? c : m),
      info: (c: unknown, m?: string) => emit('info', { ...bindings, ...(typeof c === 'object' && c ? c : {}) }, typeof c === 'string' ? c : m),
      warn: (c: unknown, m?: string) => emit('warn', { ...bindings, ...(typeof c === 'object' && c ? c : {}) }, typeof c === 'string' ? c : m),
      error: (c: unknown, m?: string) => emit('error', { ...bindings, ...(typeof c === 'object' && c ? c : {}) }, typeof c === 'string' ? c : m),
    };
  },
};
