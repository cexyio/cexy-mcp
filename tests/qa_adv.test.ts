import { describe, it, expect } from "vitest";
import { harness, KEY_ENV, TRADE_ENV, TEST_KEY, TEST_SECRET, text, structured, data, order } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { toolsFor, createServer } from "../src/server.js";
import { createLogger, Redactor } from "../src/redact.js";

const book = { symbol: "BTC/USDT", sequence: 1, bids: [["100", "1"]], asks: [["101", "1"], ["102", "1"]], timestamp: "2026-09-26T10:00:00Z" };
const placed = (c: any) => ({ body: data({ order: order({ client_order_id: c.body.client_order_id, symbol: c.body.symbol }), fills: [] }) });
const routes = { "GET /markets/BTC/USDT/orderbook": data(book), "POST /trading/orders": placed };
const CAP = { ...TRADE_ENV, CEXY_MCP_MAX_ORDER_NOTIONAL: "100", CEXY_MCP_ALLOWED_MARKETS: "BTC/USDT" };

describe("qa adversarial", () => {
  it("tool lists per config", () => {
    const names = (env: any) => toolsFor(loadConfig(env)).map((t) => t.name);
    console.log("public", names({}));
    console.log("key", names(KEY_ENV));
    console.log("trade-no-key", names({ CEXY_MCP_ENABLE_TRADING: "true" }));
    console.log("trade TRUE", names({ ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "TRUE" }));
    console.log("trade yes", names({ ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "yes" }));
    expect(() => loadConfig({ ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "tru" })).toThrow();
  });

  it("guardrail bypass attempts", async () => {
    const h = await harness(CAP, routes);
    const tries: Record<string, any> = {
      mkt_buy_quote_over: { symbol: "BTC/USDT", side: "buy", type: "market", quote_quantity: "1000" },
      mkt_buy_quote_under_qty_over: { symbol: "BTC/USDT", side: "buy", type: "market", quote_quantity: "1", quantity: "2" },
      mkt_sell_quote_over: { symbol: "BTC/USDT", side: "sell", type: "market", quote_quantity: "1000" },
      mkt_buy_qty_uncovered: { symbol: "BTC/USDT", side: "buy", type: "market", quantity: "5" },
      lowercase_symbol_ok: { symbol: "btc/usdt", side: "buy", type: "limit", quantity: "0.5", price: "100" },
      mixedcase_other: { symbol: "eth/USDT", side: "buy", type: "limit", quantity: "0.5", price: "100" },
      limit_missing_price: { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "0.5" },
      market_with_price: { symbol: "BTC/USDT", side: "buy", type: "market", quantity: "0.5", price: "1" },
      limit_sell_low_price: { symbol: "BTC/USDT", side: "sell", type: "limit", quantity: "2", price: "1" },
      stop_market_qty: { symbol: "BTC/USDT", side: "buy", type: "stop_market", quantity: "0.1", stop_price: "90" },
      stop_market_quote_ok: { symbol: "BTC/USDT", side: "buy", type: "stop_market", quote_quantity: "50", stop_price: "90" },
      stop_limit_sell: { symbol: "BTC/USDT", side: "sell", type: "stop_limit", quantity: "0.1", price: "90", stop_price: "90" },
      zero_qty: { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "0", quote_quantity: "0", price: "1" },
      exponent: { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "1e3", price: "1" },
      space_symbol: { symbol: "BTC/USDT ", side: "buy", type: "limit", quantity: "0.1", price: "1" },
      unicode_symbol: { symbol: "BTC/USDTı", side: "buy", type: "limit", quantity: "0.1", price: "1" },
      extra_field: { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "0.1", price: "1", withdraw: true, address: "x" },
      limit_buy_ok_cid: { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "0.1", price: "100", client_order_id: "11111111-1111-1111-1111-111111111111" },
      limit_buy_bad_cid: { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "0.1", price: "100", client_order_id: "" },
    };
    for (const [k, args] of Object.entries(tries)) {
      const r = await h.call("place_order", args);
      const s = structured(r) as any;
      console.log(k, r.isError ? "ERR" : "OK", r.isError ? (s?.error?.code ?? text(r).slice(0, 120)) : s.order?.symbol);
    }
    const posts = h.calls.filter((c) => c.method === "POST");
    console.log("posts", posts.map((p) => JSON.stringify(p.body)));
    for (const p of posts) expect((p.body as any).client_order_id).toMatch(/^[0-9a-f-]{36}$/);
    await h.close();
  });

  it("cancel_all requires symbol", async () => {
    const h = await harness(TRADE_ENV, { "POST /trading/orders/cancel-all": data({ cancelled: [], failed: [] }) });
    for (const a of [{}, { symbol: "" }, { symbol: null }, { symbol: "*" }]) {
      const r = await h.call("cancel_all_orders", a as any);
      console.log("cancel_all", JSON.stringify(a), r.isError ? "ERR" : "OK");
    }
    expect(h.calls.length).toBe(0);
    await h.close();
  });

  it("credential leaks", async () => {
    const leak = `key=${TEST_KEY} secret=${TEST_SECRET} X-API-Secret: ${TEST_SECRET}`;
    const h = await harness(TRADE_ENV, {
      "GET /account/balances": () => ({ status: 400, body: { error: { code: "VALIDATION_FAILED", message: leak, details: { echo: TEST_SECRET, fields: { a: TEST_SECRET } } } } }),
      "GET /trading/orders": () => ({ status: 500, body: `<html>${leak}</html>` as any }),
      "POST /trading/orders": () => ({ status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: leak, retryable: true } } }),
      "GET /trading/orders/by-client-id/11111111-1111-1111-1111-111111111111": () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: leak } } }),
    });
    const outs: string[] = [];
    for (const [t, a] of [["get_balances", {}], ["list_open_orders", {}], ["place_order", { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "1", price: "1", client_order_id: "11111111-1111-1111-1111-111111111111" }]] as const) {
      const r = await h.call(t, a as any);
      outs.push(JSON.stringify(r));
      console.log(t, text(r).slice(0, 300));
    }
    const all = outs.join("\n") + h.logs.join("\n");
    expect(all).not.toContain(TEST_SECRET);
    expect(all).not.toContain(TEST_KEY);
    await h.close();
  });

  it("fetch throws with secret; timeout on place_order", async () => {
    const config = loadConfig(TRADE_ENV);
    const logs: string[] = [];
    const logger = createLogger(new Redactor([config.apiKey, config.apiSecret]), { level: "debug", write: (l) => logs.push(l) });
    const fetch = async (input: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      if (input.includes("by-client-id")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "nf" } }), { status: 404 });
      throw new Error(`boom ${h.get("x-api-secret")} ${h.get("x-api-key")} ${input}`);
    };
    const { server } = createServer({ config, fetch, logger, clientOptions: { rateLimit: false, maxRetries: 0 } });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [c, s] = InMemoryTransport.createLinkedPair();
    const cl = new Client({ name: "t", version: "0" });
    await server.connect(s); await cl.connect(c);
    const r1 = await cl.callTool({ name: "get_balances", arguments: {} });
    const r2 = await cl.callTool({ name: "place_order", arguments: { symbol: "BTC/USDT", side: "buy", type: "limit", quantity: "1", price: "1" } });
    console.log("r1", JSON.stringify(r1.structuredContent)); console.log("r2", JSON.stringify(r2.structuredContent));
    const all = JSON.stringify([r1, r2]) + logs.join("");
    console.log(logs.join(""));
    expect(all).not.toContain(TEST_SECRET);
  });
});
