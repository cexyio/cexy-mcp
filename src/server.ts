import { CexyClient, type FetchLike } from "@cexyio/cexy";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "./config.js";
import { Redactor, createLogger, type Logger } from "./redact.js";
import { fail, ok } from "./result.js";
import { accountTools } from "./tools/account.js";
import type { ToolContext, ToolDef } from "./tools/common.js";
import { publicTools } from "./tools/public.js";
import { tradeTools } from "./tools/trade.js";
import { USER_AGENT_SUFFIX, VERSION } from "./version.js";

export const SERVER_NAME = "cexy";

// The guard reads only these private copies: the exported lists below are frozen snapshots, so
// code embedding this package cannot change what is refused.
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /withdraw(?!als$)/i, // create_withdrawal, withdraw, ... (list_withdrawals is the only allowed match)
  /transfer/i,
  /sub_?account/i,
  /pool/i,
  /deposit_?address/i,
  /api_?key/i,
  /login|logout|auth|2fa|two_factor|totp|password|session/i,
  /admin|operator|internal/i,
  /export/i,
];
const EXEMPTIONS: ReadonlySet<string> = new Set(["list_withdrawals", "get_sub_account_balances"]);

/**
 * Tool names that must never exist in this server, whatever the configuration: fund
 * movements, address creation, key management, auth, admin and exports. A frozen copy, for
 * reading only.
 */
export const FORBIDDEN_TOOL_PATTERNS: readonly RegExp[] = Object.freeze(FORBIDDEN_PATTERNS.map((p) => new RegExp(p.source, p.flags)));

/**
 * Exact tool names allowed although a forbidden pattern matches them. Each one is read-only and was
 * approved on its own (list_withdrawals: history; get_sub_account_balances: parent-only balances
 * read). Any other name containing these fragments stays refused. A frozen copy, for reading only.
 */
export const FORBIDDEN_PATTERN_EXEMPTIONS: readonly string[] = Object.freeze([...EXEMPTIONS]);

/** True when a tool with this name must never be registered. */
export function isForbiddenToolName(name: string): boolean {
  return !EXEMPTIONS.has(name) && FORBIDDEN_PATTERNS.some((p) => p.test(name));
}

export const INSTRUCTIONS = [
  "CEXY.io exchange tools: market data (markets, tickers, order books, trades, candles, assets, fees) and, when an",
  "API key is configured, read-only views of the user's balances (and their sub-accounts' balances), orders, trades,",
  "deposits, withdrawals and ledger.",
  "The server is read-only by default. Trading tools (place_order, cancel_order, cancel_all_orders) exist only when",
  "the user starts it with CEXY_MCP_ENABLE_TRADING=true and an API key with the trade scope; orders are then REAL",
  "and irreversible once filled, so confirm every order with the user first. Optional guardrails: CEXY_MCP_ALLOWED_MARKETS",
  "and CEXY_MCP_MAX_ORDER_NOTIONAL. This server never moves funds: it has no withdrawal, transfer or deposit-address",
  "tools, and CEXY API keys cannot withdraw. Amounts are decimal strings; timestamps are ISO 8601. Lists are capped;",
  "page with next_cursor or next_offset. Call get_server_status to see what is enabled.",
].join(" ");

export interface CreateServerOptions {
  config: McpConfig;
  /** Injected into CexyClient (tests use a mock). Default: global fetch. It must honour `redirect: "manual"`. */
  fetch?: FetchLike;
  logger?: Logger;
  /** Passed to CexyClient (tests disable the limiter and retries). */
  clientOptions?: { maxRetries?: number; rateLimit?: false; timeoutMs?: number };
}

export interface CexyMcp {
  server: McpServer;
  client: CexyClient;
  toolNames: string[];
  redactor: Redactor;
}

/** The tools registered for a configuration, in registration order. */
export function toolsFor(config: McpConfig): ToolDef[] {
  const tools = [...publicTools];
  if (config.apiKey !== null && config.apiSecret !== null) tools.push(...accountTools);
  if (config.tradingEnabled && config.apiKey !== null) tools.push(...tradeTools);
  for (const t of tools) {
    if (isForbiddenToolName(t.name)) {
      throw new Error(`refusing to register forbidden tool ${t.name}`);
    }
  }
  return tools;
}

export function createServer(options: CreateServerOptions): CexyMcp {
  const { config } = options;
  const redactor = new Redactor([config.apiKey, config.apiSecret]);
  const logger = options.logger ?? createLogger(redactor);

  const client = new CexyClient({
    ...(config.apiKey !== null && config.apiSecret !== null ? { apiKey: config.apiKey, apiSecret: config.apiSecret } : {}),
    baseUrl: config.baseUrl,
    userAgentSuffix: USER_AGENT_SUFFIX,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clientOptions ?? {}),
    onRetry: (info) => logger.debug("retrying request", { ...info }),
  });

  const server = new McpServer({ name: SERVER_NAME, title: "CEXY.io", version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { client, config, redactor, logger };

  const tools = toolsFor(config);
  for (const tool of tools) {
    const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        const out = await tool.handler(args, ctx);
        logger.info(`tool ${tool.name} ok`, { ms: Date.now() - started });
        return ok(out.summary, out.data, redactor);
      } catch (err) {
        const result = fail(err, redactor);
        const body = (result.structuredContent as { error: { code: string } }).error;
        logger.warn(`tool ${tool.name} failed`, { ms: Date.now() - started, code: body.code });
        if (body.code === "INTERNAL_ERROR") logger.error(`tool ${tool.name} internal error`, { error: String(err) });
        return result;
      }
    };
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      handler,
    );
  }

  if (config.tradingFlagIgnored !== null) {
    logger.warn(
      `CEXY_MCP_ENABLE_TRADING="${config.tradingFlagIgnored}" is ignored: only the exact value "true" enables trading`,
    );
  }
  if (config.tradingRequested && !config.tradingEnabled) {
    logger.warn("CEXY_MCP_ENABLE_TRADING is set but no API key is configured; trading tools are not registered");
  }
  logger.info(`CEXY MCP server ${VERSION} ready`, {
    base_url: config.baseUrl,
    authenticated: config.apiKey !== null,
    trading_enabled: config.tradingEnabled,
    tools: tools.length,
  });

  return { server, client, toolNames: tools.map((t) => t.name), redactor };
}
