import { DEFAULT_BASE_URL } from "@cexyio/cexy";
import { isPositiveDecimal, normalizeDecimal } from "./decimal.js";

/** Server configuration, read from the MCP client's `env` block. */
export interface McpConfig {
  apiKey: string | null;
  apiSecret: string | null;
  baseUrl: string;
  /** True only when CEXY_MCP_ENABLE_TRADING is set AND credentials are present. */
  tradingEnabled: boolean;
  /** CEXY_MCP_ENABLE_TRADING was exactly "true", whether or not credentials are present. */
  tradingRequested: boolean;
  /** A truthy-looking CEXY_MCP_ENABLE_TRADING value other than "true" (e.g. "1", "yes"), which is ignored. */
  tradingFlagIgnored: string | null;
  /** Per-order cap in quote currency (a decimal string), or null for no cap. */
  maxOrderNotional: string | null;
  /** Upper-case `BASE/QUOTE` symbols, or null for every market. */
  allowedMarkets: string[] | null;
}

export class McpConfigError extends Error {
  override name = "McpConfigError";
}

export const SYMBOL_PATTERN = /^[A-Za-z0-9]{1,20}\/[A-Za-z0-9]{1,20}$/;

/** Values recognised as "off". Anything unrecognised (a typo such as "tru") is a startup error. */
const TRADING_OFF_VALUES = new Set(["", "false", "0", "1", "no", "yes", "off", "on", "true"]);

/**
 * Trading is enabled ONLY by the exact string "true". Every other recognised value, including
 * "1", "yes", "on" and "TRUE", means off (with a warning when it looks like an attempt to enable).
 */
function parseTradingFlag(raw: string | undefined): { enabled: boolean; ignored: string | null } {
  if (raw === "true") return { enabled: true, ignored: null };
  const v = (raw ?? "").trim();
  if (TRADING_OFF_VALUES.has(v.toLowerCase())) {
    const looksOn = ["1", "yes", "on", "true"].includes(v.toLowerCase());
    return { enabled: false, ignored: looksOn ? v : null };
  }
  throw new McpConfigError('CEXY_MCP_ENABLE_TRADING must be exactly "true" to enable trading, or "false"');
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Removes trailing "/" in linear time (a `/\/+$/` regex is polynomial on a long run of slashes). */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return s.slice(0, end);
}

function nonEmpty(raw: string | undefined): string | null {
  const v = raw?.trim();
  return v ? v : null;
}

/** Parses the environment. Throws McpConfigError on invalid settings; never includes secret values in messages. */
export function loadConfig(env: Record<string, string | undefined>): McpConfig {
  const apiKey = nonEmpty(env.CEXY_API_KEY);
  const apiSecret = nonEmpty(env.CEXY_API_SECRET);
  if ((apiKey === null) !== (apiSecret === null)) {
    throw new McpConfigError(
      `CEXY_API_KEY and CEXY_API_SECRET must be set together (only ${apiKey ? "CEXY_API_KEY" : "CEXY_API_SECRET"} is set)`,
    );
  }

  const baseUrl = stripTrailingSlashes(nonEmpty(env.CEXY_BASE_URL) ?? DEFAULT_BASE_URL);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new McpConfigError("CEXY_BASE_URL is not a valid URL");
  }
  if (parsed.protocol === "http:") {
    if (env.CEXY_ALLOW_INSECURE !== "true") {
      throw new McpConfigError("CEXY_BASE_URL must use https:// (http is allowed only for a loopback host with CEXY_ALLOW_INSECURE=true)");
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new McpConfigError("CEXY_ALLOW_INSECURE allows http:// only for localhost, 127.0.0.1 or ::1");
    }
  } else if (parsed.protocol !== "https:") {
    throw new McpConfigError("CEXY_BASE_URL must use https://");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new McpConfigError("CEXY_BASE_URL must not contain credentials, a query string or a fragment");
  }

  const trading = parseTradingFlag(env.CEXY_MCP_ENABLE_TRADING);
  const tradingRequested = trading.enabled;

  let maxOrderNotional: string | null = null;
  const rawCap = nonEmpty(env.CEXY_MCP_MAX_ORDER_NOTIONAL);
  if (rawCap !== null) {
    if (!isPositiveDecimal(rawCap)) {
      throw new McpConfigError("CEXY_MCP_MAX_ORDER_NOTIONAL must be a positive decimal number, e.g. 250 or 99.5");
    }
    maxOrderNotional = normalizeDecimal(rawCap);
  }

  let allowedMarkets: string[] | null = null;
  const rawMarkets = nonEmpty(env.CEXY_MCP_ALLOWED_MARKETS);
  if (rawMarkets !== null) {
    const list = rawMarkets
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const m of list) {
      if (!SYMBOL_PATTERN.test(m)) {
        throw new McpConfigError(`CEXY_MCP_ALLOWED_MARKETS: "${m}" is not a BASE/QUOTE symbol such as BTC/USDT`);
      }
    }
    if (list.length === 0) throw new McpConfigError("CEXY_MCP_ALLOWED_MARKETS is set but lists no market");
    allowedMarkets = [...new Set(list.map((m) => m.toUpperCase()))];
  }

  return {
    apiKey,
    apiSecret,
    baseUrl,
    tradingRequested,
    tradingFlagIgnored: trading.ignored,
    tradingEnabled: tradingRequested && apiKey !== null,
    maxOrderNotional,
    allowedMarkets,
  };
}

/** A description of the configuration that is safe to show (no key, no secret). */
export function publicConfigView(config: McpConfig): Record<string, unknown> {
  return {
    base_url: config.baseUrl,
    authenticated: config.apiKey !== null,
    trading_enabled: config.tradingEnabled,
    max_order_notional: config.maxOrderNotional,
    allowed_markets: config.allowedMarkets,
  };
}
