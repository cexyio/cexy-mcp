import { describe, expect, it } from "vitest";
import { McpConfigError, loadConfig, publicConfigView, stripTrailingSlashes } from "../src/config.js";
import { TEST_KEY, TEST_SECRET } from "./helpers.js";

describe("loadConfig", () => {
  it("defaults: public only, api.cexy.io, trading off", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      apiKey: null,
      apiSecret: null,
      baseUrl: "https://api.cexy.io",
      tradingEnabled: false,
      maxOrderNotional: null,
      allowedMarkets: null,
    });
  });

  it("rejects a key without a secret and a secret without a key, without echoing them", () => {
    for (const env of [{ CEXY_API_KEY: TEST_KEY }, { CEXY_API_SECRET: TEST_SECRET }]) {
      let err: unknown;
      try {
        loadConfig(env);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(McpConfigError);
      expect(String(err)).not.toContain(TEST_KEY);
      expect(String(err)).not.toContain(TEST_SECRET);
    }
  });

  it("parses trading flags and guardrails", () => {
    const c = loadConfig({
      CEXY_API_KEY: TEST_KEY,
      CEXY_API_SECRET: TEST_SECRET,
      CEXY_MCP_ENABLE_TRADING: "true",
      CEXY_MCP_MAX_ORDER_NOTIONAL: "250.50",
      CEXY_MCP_ALLOWED_MARKETS: "btc/usdt, ETH/USDT,BTC/USDT",
      CEXY_BASE_URL: "https://api.cexy.io/",
    });
    expect(c.tradingEnabled).toBe(true);
    expect(c.maxOrderNotional).toBe("250.5");
    expect(c.allowedMarkets).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(c.baseUrl).toBe("https://api.cexy.io");
  });

  it.each(["1", "yes", "YES", "on", "TRUE", "True", " true", "false", "0", "no", "off", ""])(
    "CEXY_MCP_ENABLE_TRADING=%j does not enable trading (only the exact string \"true\" does)",
    (v) => {
      const c = loadConfig({ CEXY_API_KEY: TEST_KEY, CEXY_API_SECRET: TEST_SECRET, CEXY_MCP_ENABLE_TRADING: v });
      expect(c.tradingEnabled).toBe(false);
      expect(c.tradingRequested).toBe(false);
    },
  );

  it("flags truthy-looking values that were ignored", () => {
    expect(loadConfig({ CEXY_MCP_ENABLE_TRADING: "yes" }).tradingFlagIgnored).toBe("yes");
    expect(loadConfig({ CEXY_MCP_ENABLE_TRADING: "false" }).tradingFlagIgnored).toBeNull();
  });

  it("requires https for CEXY_BASE_URL", () => {
    expect(loadConfig({ CEXY_BASE_URL: "https://api.cexy.io" }).baseUrl).toBe("https://api.cexy.io");
    expect(() => loadConfig({ CEXY_BASE_URL: "http://api.cexy.io" })).toThrow(/https/);
    expect(() => loadConfig({ CEXY_BASE_URL: "http://localhost" })).toThrow(/CEXY_ALLOW_INSECURE/);
    expect(() => loadConfig({ CEXY_BASE_URL: "ws://api.cexy.io" })).toThrow(/https/);
  });

  it("allows http only for loopback hosts with CEXY_ALLOW_INSECURE=true", () => {
    for (const url of ["http://localhost", "http://127.0.0.1", "http://[::1]"]) {
      expect(loadConfig({ CEXY_BASE_URL: url, CEXY_ALLOW_INSECURE: "true" }).baseUrl).toBe(url);
    }
    expect(() => loadConfig({ CEXY_BASE_URL: "http://api.cexy.io", CEXY_ALLOW_INSECURE: "true" })).toThrow(/loopback|localhost/);
    expect(() => loadConfig({ CEXY_BASE_URL: "http://localhost.evil.example", CEXY_ALLOW_INSECURE: "true" })).toThrow();
    expect(() => loadConfig({ CEXY_BASE_URL: "http://localhost", CEXY_ALLOW_INSECURE: "1" })).toThrow(/CEXY_ALLOW_INSECURE/);
  });

  it("does not enable trading without a key", () => {
    const c = loadConfig({ CEXY_MCP_ENABLE_TRADING: "true" });
    expect(c.tradingRequested).toBe(true);
    expect(c.tradingEnabled).toBe(false);
  });

  it.each([
    [{ CEXY_MCP_ENABLE_TRADING: "maybe" }, /ENABLE_TRADING/],
    [{ CEXY_MCP_ENABLE_TRADING: "tru" }, /ENABLE_TRADING/],
    [{ CEXY_MCP_MAX_ORDER_NOTIONAL: "-5" }, /MAX_ORDER_NOTIONAL/],
    [{ CEXY_MCP_MAX_ORDER_NOTIONAL: "0" }, /MAX_ORDER_NOTIONAL/],
    [{ CEXY_MCP_MAX_ORDER_NOTIONAL: "1e3" }, /MAX_ORDER_NOTIONAL/],
    [{ CEXY_MCP_ALLOWED_MARKETS: "BTCUSDT" }, /ALLOWED_MARKETS/],
    [{ CEXY_MCP_ALLOWED_MARKETS: " , " }, /ALLOWED_MARKETS/],
    [{ CEXY_BASE_URL: "not a url" }, /BASE_URL/],
    [{ CEXY_BASE_URL: "ftp://api.cexy.io" }, /BASE_URL/],
    [{ CEXY_BASE_URL: "https://user:pw@api.cexy.io" }, /BASE_URL/],
  ])("rejects invalid settings %#", (env, pattern) => {
    expect(() => loadConfig(env)).toThrow(pattern);
  });

  it("publicConfigView never contains credentials", () => {
    const view = JSON.stringify(publicConfigView(loadConfig({ CEXY_API_KEY: TEST_KEY, CEXY_API_SECRET: TEST_SECRET })));
    expect(view).not.toContain(TEST_KEY);
    expect(view).not.toContain(TEST_SECRET);
    expect(view).toContain('"authenticated":true');
  });

  it("strips trailing slashes from CEXY_BASE_URL in linear time (no regex backtracking)", () => {
    expect(loadConfig({ CEXY_BASE_URL: "https://api.cexy.io///" }).baseUrl).toBe("https://api.cexy.io");
    const t0 = performance.now();
    expect(() => loadConfig({ CEXY_BASE_URL: "https://api.cexy.io" + "/".repeat(100_000) + "x" })).not.toThrow(/timeout/);
    expect(stripTrailingSlashes("https://api.cexy.io" + "/".repeat(100_000))).toBe("https://api.cexy.io");
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
