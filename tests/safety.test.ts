import { CexyConnectionError, CexyTimeoutError, OrderStateUnknownError } from "@cexyio/cexy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Redactor, createLogger } from "../src/redact.js";
import { MAX_RESULT_BYTES, capSize, errorBody } from "../src/result.js";
import { createServer } from "../src/server.js";
import { KEY_ENV, TEST_KEY, TEST_SECRET, TRADE_ENV, data, harness, market, structured, text, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  vi.restoreAllMocks();
});

function assertNoSecrets(s: string) {
  expect(s).not.toContain(TEST_KEY);
  expect(s).not.toContain(TEST_SECRET);
  expect(s).not.toMatch(/x-api-(key|secret)\s*[:=]\s*(?!\[REDACTED\])\S/i);
}

describe("error mapping", () => {
  it("maps CexyApiError to code, message, retryable and request_id", async () => {
    h = await harness(KEY_ENV, {
      "GET /account/balances": () => ({
        status: 403,
        body: { error: { code: "FORBIDDEN", message: "the key lacks the read scope", request_id: "req_123" } },
      }),
    });
    const r = await h.call("get_balances");
    expect(r.isError).toBe(true);
    expect(structured(r).error).toEqual({
      code: "FORBIDDEN",
      message: "the key lacks the read scope",
      retryable: false,
      request_id: "req_123",
      status: 403,
    });
    expect(text(r)).toMatch(/^Error FORBIDDEN: the key lacks the read scope \(request_id req_123\)/);
  });

  it("includes validation fields and rate-limit hints", async () => {
    h = await harness({}, {
      "GET /markets/BTC/USDT": () => ({
        status: 429,
        headers: { "retry-after": "3" },
        body: { error: { code: "RATE_LIMITED", message: "slow down" } },
      }),
      "GET /markets/BTC/USDT/orderbook": () => ({
        status: 400,
        body: { error: { code: "VALIDATION_FAILED", message: "bad", fields: { depth: "too deep" }, request_id: "r2" } },
      }),
    });
    const rl = structured(await h.call("get_ticker", { symbol: "BTC/USDT" })).error;
    expect(rl).toMatchObject({ code: "RATE_LIMITED", retryable: true, retry_after_ms: 3000 });
    const v = structured(await h.call("get_orderbook", { symbol: "BTC/USDT" })).error;
    expect(v).toMatchObject({ code: "VALIDATION_FAILED", fields: { depth: "too deep" }, request_id: "r2" });
  });

  it("maps transport errors and hides unexpected ones", () => {
    expect(errorBody(new CexyTimeoutError("GET /x timed out"))).toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(errorBody(new CexyConnectionError("GET /x failed"))).toMatchObject({ code: "CONNECTION_ERROR", retryable: true });
    expect(errorBody(new OrderStateUnknownError("cid-1", new Error("x")))).toMatchObject({
      code: "ORDER_STATE_UNKNOWN",
      client_order_id: "cid-1",
      retryable: false,
    });
    const internal = errorBody(new Error(`boom ${TEST_SECRET}`));
    expect(internal).toEqual({ code: "INTERNAL_ERROR", message: "Unexpected error in the CEXY MCP server.", retryable: false, request_id: null });
  });
});

describe("secret redaction", () => {
  it("redacts the key and secret from API error messages and tool output", async () => {
    h = await harness(KEY_ENV, {
      "GET /account/balances": () => ({
        status: 401,
        body: {
          error: {
            code: "INVALID_CREDENTIALS",
            message: `bad key ${TEST_KEY} with secret ${TEST_SECRET}; X-API-Secret: ${TEST_SECRET}`,
            request_id: "req_1",
          },
        },
      }),
    });
    const r = await h.call("get_balances");
    const all = JSON.stringify(r);
    assertNoSecrets(all);
    expect(all).toContain("[REDACTED]");
    expect(structured(r).error.code).toBe("INVALID_CREDENTIALS");
    assertNoSecrets(h.logs.join("\n"));
  });

  it("never logs credentials (stderr captured), including internal errors and trading", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, "write");
    const config = loadConfig(TRADE_ENV);
    const fetch = async () => {
      throw new Error(`socket closed; headers were X-API-Key: ${TEST_KEY} X-API-Secret: ${TEST_SECRET}`);
    };
    const { server } = createServer({
      config,
      fetch,
      logger: createLogger(new Redactor([config.apiKey, config.apiSecret]), { level: "debug" }),
      clientOptions: { rateLimit: false, maxRetries: 0 },
    });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await server.connect(b);
    await client.connect(a);
    const r1 = await client.callTool({ name: "get_balances", arguments: {} });
    const r2 = await client.callTool({
      name: "place_order",
      arguments: { symbol: "BTC/USDT", side: "buy", type: "limit", price: "1", quantity: "1" },
    });
    await client.close();
    await server.close();

    expect(written.length).toBeGreaterThan(0);
    assertNoSecrets(written.join(""));
    assertNoSecrets(JSON.stringify([r1, r2]));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("Redactor scrubs configured secrets, credential headers and key ids", () => {
    const r = new Redactor([TEST_KEY, TEST_SECRET]);
    const out = r.redact(`key=${TEST_KEY} secret=${TEST_SECRET} Authorization: Bearer abc.def x-api-key=ak_Zz99other`);
    assertNoSecrets(out);
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("ak_Zz99other");
  });
});

describe("result size cap", () => {
  it("capSize trims the largest list and marks the result truncated", () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, price: "123.456", quantity: "0.001" }));
    const capped = capSize({ symbol: "BTC/USDT", items });
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(capped.truncated).toBe(true);
    expect((capped.items as unknown[]).length).toBeGreaterThan(100);
    expect(capped.truncated_note).toMatch(/dropped the last \d+ items/);
    expect((capped.items as { id: string }[])[0]!.id).toBe("t0");
  });

  it("small results are untouched", () => {
    const r = { a: [1, 2, 3] };
    expect(capSize(r)).toBe(r);
  });

  it("a huge API response comes back under ~20 KB with truncated: true", async () => {
    const long = "x".repeat(300);
    const markets = Array.from({ length: 50 }, (_, i) => market(`M${i}/USDT`, { last_price: `1.${long}` }));
    h = await harness({}, { "GET /markets": data(markets) });
    const r = await h.call("list_markets", { limit: 50 });
    const s = structured(r);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(s.truncated).toBe(true);
    expect(s.markets.length).toBeLessThan(50);
    expect(text(r)).toMatch(/\(truncated\)/);
  });

  it("every tool result stays under the cap for a 50-level book", async () => {
    const levels = Array.from({ length: 500 }, (_, i) => [`${1000 + i}.12345678`, `${i}.87654321`]);
    h = await harness({}, {
      "GET /markets/BTC/USDT/orderbook": data({ symbol: "BTC/USDT", bids: levels, asks: levels, sequence: 1, timestamp: "2026-09-26T10:00:00Z" }),
    });
    const s = structured(await h.call("get_orderbook", { symbol: "BTC/USDT", depth: 50 }));
    expect(s.bids).toHaveLength(50);
    expect(s.asks).toHaveLength(50);
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });
});
