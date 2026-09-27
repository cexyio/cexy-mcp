import { afterEach, describe, expect, it } from "vitest";
import { TRADE_ENV, data, harness, order, structured, type Call, type Harness } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const BOOK = data({
  symbol: "BTC/USDT",
  sequence: 7,
  timestamp: "2026-09-26T10:00:00Z",
  bids: [
    ["99", "1"],
    ["98", "5"],
  ],
  asks: [
    ["101", "0.5"],
    ["102", "1"],
  ],
});

/** Echoes the POSTed order back as an open order. */
const placeRoute = (c: Call) => {
  const b = c.body as Record<string, string>;
  return {
    body: data({
      order: order({ symbol: b.symbol, side: b.side, type: b.type, price: b.price, quantity: b.quantity ?? "0", client_order_id: b.client_order_id }),
      fills: [],
    }),
  };
};

const ambiguousMessage = (id: string) =>
  `The order may or may not have been placed. Call get_order with client_order_id=${id} before trying again; do not place a new order.`;

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/trading/orders");

function env(extra: Record<string, string> = {}) {
  return { ...TRADE_ENV, ...extra };
}

describe("place_order", () => {
  it("always sets a UUID client_order_id and returns the order state", async () => {
    h = await harness(env(), { "POST /trading/orders": placeRoute });
    const r = await h.call("place_order", { symbol: "btc/usdt", side: "buy", type: "limit", price: "100", quantity: "0.1" });
    expect(r.isError).toBeFalsy();
    const body = posts(h.calls)[0]!.body as Record<string, unknown>;
    expect(body.client_order_id).toMatch(UUID);
    expect(body.symbol).toBe("BTC/USDT");
    expect(body.price).toBe("100");
    expect(structured(r)).toMatchObject({ client_order_id: body.client_order_id, recovered: false, order: { status: "open" } });
    expect(h.calls[0]!.headers.get("idempotency-key")).toBeTruthy();
  });

  it("keeps a client_order_id supplied by the caller", async () => {
    h = await harness(env(), { "POST /trading/orders": placeRoute });
    const id = "3f2a9c1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b";
    await h.call("place_order", { symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1", client_order_id: id });
    expect((posts(h.calls)[0]!.body as Record<string, unknown>).client_order_id).toBe(id);
  });

  it("rejects a non-UUID client_order_id and non-decimal amounts", async () => {
    h = await harness(env(), { "POST /trading/orders": placeRoute });
    const bad = [
      { client_order_id: "mine-1" },
      { quantity: "1e3" },
      { quantity: "-1" },
      { quantity: 1 },
      { price: "0" },
    ];
    for (const b of bad) {
      const r = await h.call("place_order", { symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1", ...b });
      expect(r.isError, JSON.stringify(b)).toBe(true);
    }
    expect(posts(h.calls)).toHaveLength(0);
  });

  it("never re-sends after an ambiguous failure: one POST, then a lookup by client_order_id", async () => {
    h = await harness(env(), {
      "POST /trading/orders": () => ({ status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "try later", request_id: "req_9" } } }),
    });
    const r = await h.call("place_order", { symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1" });
    expect(posts(h.calls)).toHaveLength(1);
    const lookup = h.calls.find((c) => c.path.startsWith("/trading/orders/by-client-id/"));
    const lookedUp = lookup?.path.split("/").pop() ?? "";
    expect(lookedUp).toBe((posts(h.calls)[0]!.body as Record<string, string>).client_order_id);
    // Ambiguous (5xx): never presented as retryable; the agent is told to check get_order first.
    expect(r.isError).toBe(true);
    expect(structured(r).error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      request_id: "req_9",
      retryable: false,
      client_order_id: lookedUp,
      message: ambiguousMessage(lookedUp),
    });
  });

  describe("ambiguous failures (F10)", () => {
    const CID = "3f2a9c1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b";
    const args = { symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1", client_order_id: CID };

    async function placeWith(fetch: (input: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) {
      const { loadConfig } = await import("../src/config.js");
      const { createServer } = await import("../src/server.js");
      const { createLogger, Redactor } = await import("../src/redact.js");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const config = loadConfig(env());
      const { server } = createServer({
        config,
        fetch,
        logger: createLogger(new Redactor([]), { write: () => undefined }),
        clientOptions: { rateLimit: false, maxRetries: 0, ...(timeoutMs ? { timeoutMs } : {}) },
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "0" });
      await server.connect(b);
      await client.connect(a);
      const r = await client.callTool({ name: "place_order", arguments: args });
      await client.close();
      await server.close();
      return r.structuredContent as { error: Record<string, unknown> };
    }
    const notFound = () =>
      new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such order" } }), { status: 404 });

    it("network error: retryable false, client_order_id and the get_order instruction", async () => {
      const s = await placeWith(async (input) => {
        if (input.includes("by-client-id")) return notFound();
        throw new TypeError("fetch failed: ECONNRESET");
      });
      expect(s.error).toMatchObject({ code: "CONNECTION_ERROR", retryable: false, client_order_id: CID, message: ambiguousMessage(CID) });
    });

    it("timeout: retryable false with the get_order instruction", async () => {
      const s = await placeWith(async (input, init) => {
        if (input.includes("by-client-id")) return notFound();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }, 50);
      expect(s.error).toMatchObject({ code: "TIMEOUT", retryable: false, client_order_id: CID, message: ambiguousMessage(CID) });
    });

    it("500 whose lookup also fails (state unknown): retryable false", async () => {
      const s = await placeWith(async () =>
        new Response(JSON.stringify({ error: { code: "INTERNAL", message: "oops", request_id: "r5" } }), { status: 500 }),
      );
      expect(s.error).toMatchObject({ code: "ORDER_STATE_UNKNOWN", retryable: false, client_order_id: CID, message: ambiguousMessage(CID) });
    });

    it("a definitive refusal (422) keeps its own message and still carries client_order_id", async () => {
      const s = await placeWith(async () =>
        new Response(JSON.stringify({ error: { code: "INSUFFICIENT_FUNDS", message: "not enough USDT", request_id: "r4" } }), { status: 422 }),
      );
      expect(s.error).toMatchObject({ code: "INSUFFICIENT_FUNDS", message: "not enough USDT", retryable: false, client_order_id: CID });
    });
  });

  it("enforces CEXY_MCP_ALLOWED_MARKETS", async () => {
    h = await harness(env({ CEXY_MCP_ALLOWED_MARKETS: "ETH/USDT" }), { "POST /trading/orders": placeRoute });
    const r = await h.call("place_order", { symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1" });
    expect(r.isError).toBe(true);
    expect(structured(r).error.code).toBe("GUARDRAIL_REJECTED");
    expect(structured(r).error.retryable).toBe(false);
    const ok = await h.call("place_order", { symbol: "eth/usdt", side: "buy", type: "limit", price: "1", quantity: "1" });
    expect(ok.isError).toBeFalsy();
    expect(posts(h.calls)).toHaveLength(1);
  });

  describe("CEXY_MCP_MAX_ORDER_NOTIONAL", () => {
    const cap = env({ CEXY_MCP_MAX_ORDER_NOTIONAL: "100" });
    const routes = { "POST /trading/orders": placeRoute, "GET /markets/BTC/USDT/orderbook": BOOK };

    it.each([
      ["limit buy within cap", { side: "buy", type: "limit", price: "50", quantity: "2" }, true],
      ["limit buy over cap", { side: "buy", type: "limit", price: "50", quantity: "2.01" }, false],
      ["limit sell priced below the bid (fills at the bid)", { side: "sell", type: "limit", price: "10", quantity: "1.1" }, false],
      ["limit sell within cap", { side: "sell", type: "limit", price: "90", quantity: "1" }, true],
      ["market buy walking the asks: 0.5*101 + 0.4*102 = 91.3", { side: "buy", type: "market", quantity: "0.9" }, true],
      ["market buy walking the asks: 0.5*101 + 0.5*102 = 101.5", { side: "buy", type: "market", quantity: "1" }, false],
      ["market buy deeper than the book", { side: "buy", type: "market", quantity: "5" }, false],
      ["market buy by quote_quantity", { side: "buy", type: "market", quote_quantity: "100" }, true],
      ["market buy by quote_quantity over cap", { side: "buy", type: "market", quote_quantity: "100.01" }, false],
      ["market sell at the best bid", { side: "sell", type: "market", quantity: "1" }, true],
      ["market sell over cap", { side: "sell", type: "market", quantity: "1.02" }, false],
      ["stop_market by quantity cannot be bounded", { side: "buy", type: "stop_market", quantity: "0.1", stop_price: "90" }, false],
      ["stop_limit buy is bounded by its price", { side: "buy", type: "stop_limit", quantity: "1", price: "95", stop_price: "90" }, true],
      ["stop_limit sell cannot be bounded", { side: "sell", type: "stop_limit", quantity: "0.1", price: "95", stop_price: "96" }, false],
    ])("%s", async (_label, args, allowed) => {
      h = await harness(cap, routes);
      const r = await h.call("place_order", { symbol: "BTC/USDT", ...args });
      if (allowed) {
        expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
        expect(structured(r).notional_check.max_order_notional).toBe("100");
        expect(posts(h.calls)).toHaveLength(1);
      } else {
        expect(r.isError).toBe(true);
        expect(structured(r).error.code).toBe("GUARDRAIL_REJECTED");
        expect(posts(h.calls)).toHaveLength(0);
      }
    });

    it("rejects a market buy when the book cannot be fetched", async () => {
      h = await harness(cap, { "POST /trading/orders": placeRoute });
      const r = await h.call("place_order", { symbol: "BTC/USDT", side: "buy", type: "market", quantity: "0.1" });
      expect(r.isError).toBe(true);
      expect(posts(h.calls)).toHaveLength(0);
    });
  });
});

describe("cancel tools", () => {
  it("cancel_all_orders sends the symbol in the body", async () => {
    h = await harness(env(), { "POST /trading/orders/cancel-all": data(
      { cancelled: ["a", "b"], already_closed: [], failed: [], failures: [], has_more: false }) });
    const r = await h.call("cancel_all_orders", { symbol: "btc/usdt" });
    expect(h.calls[0]!.body).toEqual({ symbol: "BTC/USDT" });
    expect(structured(r)).toMatchObject({ symbol: "BTC/USDT", cancelled: ["a", "b"] });
  });

  it("cancel_all_orders is one call by default and reports already_closed, failures and has_more", async () => {
    h = await harness(env(), { "POST /trading/orders/cancel-all": data({
      cancelled: ["a"], already_closed: ["b"], failed: ["c"], has_more: true,
      failures: [{ order_id: "c", code: "MARKET_UNAVAILABLE", message: "market halted" }] }) });
    const r = await h.call("cancel_all_orders", { symbol: "BTC/USDT" });
    expect(h.calls).toHaveLength(1);
    expect(structured(r)).toMatchObject({ already_closed: ["b"], failed: ["c"], has_more: true,
      failures: [{ order_id: "c", code: "MARKET_UNAVAILABLE" }] });
    expect(JSON.stringify(r.content)).toContain("until_done=true");
  });

  it("cancel_all_orders with until_done repeats while has_more and merges the rounds", async () => {
    let n = 0;
    h = await harness(env(), { "POST /trading/orders/cancel-all": () => ({ body: data(n++ === 0
      ? { cancelled: ["a"], already_closed: [], failed: [], failures: [], has_more: true }
      : { cancelled: ["b"], already_closed: ["c"], failed: [], failures: [], has_more: false }) }) });
    const r = await h.call("cancel_all_orders", { symbol: "BTC/USDT", until_done: true });
    expect(h.calls).toHaveLength(2);
    expect(h.calls.every((c) => (c.body as { symbol?: string }).symbol === "BTC/USDT")).toBe(true);
    expect(structured(r)).toMatchObject({ cancelled: ["a", "b"], already_closed: ["c"], rounds: 2, stopped: "done" });
  });

  it("cancel_order by client_order_id resolves the id first", async () => {
    h = await harness(env(), {
      "GET /trading/orders/by-client-id/cid-1": data(order({ id: "ord_7" })),
      "DELETE /trading/orders/ord_7": data(order({ id: "ord_7", status: "cancelled" })),
    });
    const r = await h.call("cancel_order", { client_order_id: "cid-1" });
    expect(structured(r).order).toMatchObject({ id: "ord_7", status: "cancelled" });
  });
});
