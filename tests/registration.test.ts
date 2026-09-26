import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FORBIDDEN_TOOL_PATTERNS, INSTRUCTIONS, toolsFor } from "../src/server.js";
import { VERSION } from "../src/version.js";
import { KEY_ENV, TRADE_ENV, harness, type Harness } from "./helpers.js";

const PUBLIC = [
  "get_server_status",
  "list_markets",
  "get_market",
  "get_ticker",
  "get_orderbook",
  "get_recent_trades",
  "get_candles",
  "list_assets",
  "get_fees",
];
const READ = [
  "get_balances",
  "list_open_orders",
  "get_order",
  "get_order_history",
  "get_my_trades",
  "list_deposits",
  "list_withdrawals",
  "get_ledger",
];
const TRADE = ["place_order", "cancel_order", "cancel_all_orders"];

/** Names (and name fragments) that must never be tools of this server. */
const FORBIDDEN_NAMES = [
  "withdraw",
  "create_withdrawal",
  "request_withdrawal",
  "cancel_withdrawal",
  "transfer",
  "internal_transfer",
  "sub_account_transfer",
  "list_sub_accounts",
  "join_pool",
  "exit_pool",
  "list_pools",
  "get_deposit_address",
  "deposit_address",
  "create_api_key",
  "list_api_keys",
  "delete_api_key",
  "login",
  "logout",
  "enable_2fa",
  "admin",
  "export_trades",
  "export_ledger",
];
const FORBIDDEN_FRAGMENTS = /withdraw(?!als$)|transfer|sub_?account|pool|deposit_?address|api_?key|login|auth|2fa|admin|export/i;

const CONFIGS: [string, Record<string, string>, string[]][] = [
  ["no key", {}, PUBLIC],
  ["key", KEY_ENV, [...PUBLIC, ...READ]],
  ["key + trading", TRADE_ENV, [...PUBLIC, ...READ, ...TRADE]],
  ["trading requested without a key", { CEXY_MCP_ENABLE_TRADING: "true" }, PUBLIC],
  ["key, trading \"1\" (only exact \"true\" enables)", { ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "1" }, [...PUBLIC, ...READ]],
  ["key, trading \"yes\"", { ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "yes" }, [...PUBLIC, ...READ]],
  ["key, trading \"TRUE\"", { ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "TRUE" }, [...PUBLIC, ...READ]],
  ["key, trading explicitly false", { ...KEY_ENV, CEXY_MCP_ENABLE_TRADING: "false" }, [...PUBLIC, ...READ]],
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("tool registration", () => {
  for (const [label, env, expected] of CONFIGS) {
    it(`registers exactly the expected tools: ${label}`, async () => {
      h = await harness(env);
      const listed = (await h.client.listTools()).tools.map((t) => t.name);
      expect(listed.sort()).toEqual([...expected].sort());
      expect(h.toolNames.sort()).toEqual([...expected].sort());
    });

    it(`never exposes a forbidden tool: ${label}`, async () => {
      h = await harness(env);
      const listed = (await h.client.listTools()).tools.map((t) => t.name);
      for (const name of listed) {
        expect(FORBIDDEN_NAMES).not.toContain(name);
        expect(FORBIDDEN_FRAGMENTS.test(name) && name !== "list_withdrawals").toBe(false);
        expect(FORBIDDEN_TOOL_PATTERNS.some((p) => p.test(name))).toBe(false);
      }
    });
  }

  it("annotates read tools read-only/open-world and trade tools destructive", async () => {
    h = await harness(TRADE_ENV);
    const tools = (await h.client.listTools()).tools;
    for (const t of tools) {
      if (TRADE.includes(t.name)) {
        expect(t.annotations?.destructiveHint, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(false);
      } else {
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(t.annotations?.openWorldHint, t.name).toBe(true);
        expect(t.annotations?.destructiveHint, t.name).toBe(false);
      }
    }
    const place = tools.find((t) => t.name === "place_order");
    expect(place?.description).toMatch(/REAL/);
    expect(place?.description).toMatch(/irreversible/);
    const cancelAll = tools.find((t) => t.name === "cancel_all_orders");
    expect(cancelAll?.inputSchema.required).toEqual(["symbol"]);
  });

  it("sends server instructions covering read-only default, trading opt-in and no fund movement", async () => {
    h = await harness({});
    const instructions = h.client.getInstructions() ?? "";
    expect(instructions).toBe(INSTRUCTIONS);
    expect(instructions).toMatch(/read-only by default/);
    expect(instructions).toMatch(/CEXY_MCP_ENABLE_TRADING=true/);
    expect(instructions).toMatch(/never moves funds/);
  });

  it("toolsFor matches the registered list", () => {
    expect(toolsFor(loadConfig({})).map((t) => t.name)).toEqual(PUBLIC);
    expect(toolsFor(loadConfig(TRADE_ENV)).map((t) => t.name)).toEqual([...PUBLIC, ...READ, ...TRADE]);
  });

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
