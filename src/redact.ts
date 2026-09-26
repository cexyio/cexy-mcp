/**
 * Redaction for everything the server emits: tool results, errors and stderr logs.
 * The configured key and secret are replaced wherever they appear, and so are
 * credential-looking header values and `ak_` key ids.
 */

export const REDACTED = "[REDACTED]";

const HEADER_PATTERN = /\b(authorization|x-api-key|x-api-secret|cookie|set-cookie)(["']?\s*[:=]\s*["']?)([^"',;\s}]+(?:\s+[^"',;\s}]+)?)/gi;
const KEY_ID_PATTERN = /\bak_[A-Za-z0-9_-]{4,}/g;

export class Redactor {
  readonly #secrets: string[];

  constructor(secrets: (string | null | undefined)[]) {
    // Longest first, so a secret that contains another is replaced whole.
    this.#secrets = secrets.filter((s): s is string => typeof s === "string" && s.length >= 4).sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.#secrets) out = out.split(s).join(REDACTED);
    out = out.replace(HEADER_PATTERN, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
    out = out.replace(KEY_ID_PATTERN, REDACTED);
    return out;
  }

  /** Deep-redacts a JSON-like value (strings only are changed). */
  redactValue<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v: unknown) => this.redactValue(v)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.redactValue(v);
      return out as T;
    }
    return value;
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * A logger that writes one redacted line per event to stderr (stdout carries the MCP
 * protocol and must never be written to).
 */
export function createLogger(
  redactor: Redactor,
  options: { level?: LogLevel; write?: (line: string) => void } = {},
): Logger {
  const min = LEVELS[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    let extra = "";
    if (fields && Object.keys(fields).length > 0) {
      try {
        extra = " " + JSON.stringify(fields);
      } catch {
        extra = " [unserializable fields]";
      }
    }
    write(redactor.redact(`[cexy-mcp] ${level}: ${msg}${extra}`) + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "debug" || v === "warn" || v === "error" ? v : "info";
}
