import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config.js";
import { createLogger, Redactor } from "../src/redact.js";
import { createServer } from "../src/server.js";

export const TEST_KEY = "ak_test_key";
export const TEST_SECRET = "test_secret_value_0123456789";

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export type Route = (call: Call) => { status?: number; body: unknown; headers?: Record<string, string> } | undefined;

/** A mock `fetch` that routes by "METHOD /path" (path without /api/v1) and records every call. */
export function mockFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v1/, ""));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call: Call = { method, path, query: url.searchParams, headers, body };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    const res =
      typeof route === "function" ? (route as Route)(call) : route !== undefined ? { body: route } : undefined;
    if (!res) {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `no mock for ${method} ${path}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json", ...(res.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

export const data = (d: unknown) => ({ data: d });

export interface Harness {
  client: Client;
  toolNames: string[];
  logs: string[];
  calls: Call[];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
}

/** Starts the server with `env` and a mocked fetch, connected to an in-memory MCP client. */
export async function harness(env: Record<string, string>, routes: Record<string, unknown> = {}): Promise<Harness> {
  const config = loadConfig(env);
  const logs: string[] = [];
  const logger = createLogger(new Redactor([config.apiKey, config.apiSecret]), { level: "debug", write: (l) => logs.push(l) });
  const { fetch, calls } = mockFetch(routes);
  const { server, toolNames } = createServer({ config, fetch, logger, clientOptions: { rateLimit: false, maxRetries: 0 } });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return {
    client,
    toolNames,
    logs,
    calls,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const KEY_ENV = { CEXY_API_KEY: TEST_KEY, CEXY_API_SECRET: TEST_SECRET };
export const TRADE_ENV = { ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "true" };

export function text(r: CallToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

export function structured(r: CallToolResult): Record<string, any> {
  return r.structuredContent as Record<string, any>;
}

export function market(symbol: string, extra: Record<string, unknown> = {}) {
  const [base, quote] = symbol.split("/");
  return {
    symbol,
    base_asset: base,
    quote_asset: quote,
    status: "active",
    last_price: "100.5",
    best_bid: "100.4",
    best_ask: "100.6",
    change_24h_percent: "1.25",
    high_24h: "105",
    low_24h: "95",
    volume_24h: "1234.5",
    quote_volume_24h: "124000.1",
    lot_size: "0.0001",
    tick_size: "0.01",
    min_notional: "5",
    min_quantity: "0.0001",
    price_decimals: 2,
    quantity_decimals: 4,
    supported_order_types: ["limit", "market"],
    supported_time_in_force: ["gtc", "ioc"],
    ...extra,
  };
}

export function order(extra: Record<string, unknown> = {}) {
  return {
    id: "ord_1",
    client_order_id: null,
    symbol: "BTC/USDT",
    side: "buy",
    type: "limit",
    status: "open",
    price: "100",
    quantity: "1",
    filled_quantity: "0",
    filled_quote_quantity: "0",
    remaining_quantity: "1",
    reserved_remaining: "100",
    fee_paid: "0",
    time_in_force: "gtc",
    created_at: "2026-09-26T10:00:00Z",
    updated_at: "2026-09-26T10:00:00Z",
    ...extra,
  };
}
