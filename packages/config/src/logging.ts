/**
 * Minimal structured server logging foundation.
 * JSON lines to stdout; transports/levels via env in later phases.
 * NEVER log: passwords, tokens, API/webhook secrets, service-role keys,
 * full submission payloads, file bytes, unnecessary PII.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFieldValue = string | number | boolean | null | undefined;

export interface LogContext {
  requestId?: string;
  correlationId?: string;
  workspaceId?: string;
  actorId?: string;
  service?: string;
}

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "secret",
  "api_key",
  "apikey",
  "service_role",
  "authorization",
  "cookie",
  "set-cookie",
]);

/** Redact sensitive keys (case-insensitive, substring match). Returns a safe copy. */
export function redact<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) || k.toLowerCase().includes("secret")
      ? "[redacted]"
      : redact(v);
  }
  return out as T;
}

function write(level: LogLevel, message: string, context?: LogContext, fields?: Record<string, LogFieldValue>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    lvl: level,
    msg: message,
    ...redact(context ?? {}),
    ...redact(fields ?? {}),
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (m: string, c?: LogContext, f?: Record<string, LogFieldValue>) => write("debug", m, c, f),
  info: (m: string, c?: LogContext, f?: Record<string, LogFieldValue>) => write("info", m, c, f),
  warn: (m: string, c?: LogContext, f?: Record<string, LogFieldValue>) => write("warn", m, c, f),
  error: (m: string, c?: LogContext, f?: Record<string, LogFieldValue>) => write("error", m, c, f),
};
