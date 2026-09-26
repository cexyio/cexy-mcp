/**
 * Opt-in smoke test against the public API (no credentials, 4 GET requests):
 *   CEXY_LIVE_TESTS=1 npm run test:live
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Redactor, createLogger } from "../src/redact.js";
import { createServer } from "../src/server.js";

const live = process.env.CEXY_LIVE_TESTS === "1";

describe.skipIf(!live)("live public API (CEXY_LIVE_TESTS=1)", () => {
  it("get_server_status, list_markets (limit 3), get_orderbook for the first market", async () => {
    // Public tools only: never pass credentials to the live test.
    const config = loadConfig({ CEXY_BASE_URL: "https://api.cexy.io" });
    const logs: string[] = [];
    const { server, toolNames } = createServer({
      config,
      logger: createLogger(new Redactor([]), { write: (l) => logs.push(l) }),
      clientOptions: { maxRetries: 1 },
    });
    expect(toolNames).not.toContain("get_balances");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "live-test", version: "0" });
    await server.connect(b);
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult;

    const status = await call("get_server_status");
    expect(status.isError, JSON.stringify(status.content)).toBeFalsy();
    const s = status.structuredContent as Record<string, unknown>;
    expect(typeof s.server_time).toBe("string");
    expect(typeof s.maintenance_mode).toBe("boolean");

    const markets = await call("list_markets", { limit: 3 });
    expect(markets.isError, JSON.stringify(markets.content)).toBeFalsy();
    const list = (markets.structuredContent as { markets: { symbol: string; last_price?: unknown }[] }).markets;
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(3);

    const first = list[0]!.symbol;
    const book = await call("get_orderbook", { symbol: first, depth: 5 });
    expect(book.isError, JSON.stringify(book.content)).toBeFalsy();
    const bk = book.structuredContent as { bids: string[][]; asks: string[][] };
    expect(bk.bids.length).toBeLessThanOrEqual(5);
    for (const [p, q] of [...bk.bids, ...bk.asks]) {
      expect(typeof p).toBe("string");
      expect(typeof q).toBe("string");
    }

    console.error(
      `[live] ${(status.content[0] as { text: string }).text.split("\n")[0]} | markets: ${list.map((m) => m.symbol).join(", ")} | ` +
        `${(book.content[0] as { text: string }).text.split("\n")[0]}`,
    );
    await client.close();
    await server.close();
  });
});
