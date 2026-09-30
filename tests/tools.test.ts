import { afterEach, describe, expect, it } from "vitest";
import { KEY_ENV, TRADE_ENV, data, harness, market, order, structured, text, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const MARKETS = [market("BTC/USDT"), market("ETH/USDT"), market("ETH/BTC"), market("OLD/USDT", { status: "delisted" })];

describe("input validation", () => {
  it.each([0, 51, 2.5, -1])("get_orderbook rejects depth %s", async (depth) => {
    h = await harness({});
    const r = await h.call("get_orderbook", { symbol: "BTC/USDT", depth });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/depth/);
    expect(h.calls).toHaveLength(0);
  });

  it("get_orderbook defaults to depth 10 and accepts 50", async () => {
    h = await harness({}, { "GET /markets/BTC/USDT/orderbook": data({ symbol: "BTC/USDT", bids: [], asks: [], sequence: 1, timestamp: "2026-09-26T10:00:00Z" }) });
    expect((await h.call("get_orderbook", { symbol: "BTC/USDT" })).isError).toBeFalsy();
    expect(h.calls[0]!.query.get("depth")).toBe("10");
    expect((await h.call("get_orderbook", { symbol: "BTC/USDT", depth: 50 })).isError).toBeFalsy();
    expect(h.calls[1]!.query.get("depth")).toBe("50");
  });

  it.each(["BTCUSDT", "BTC-USDT", "BTC/USDT/X", "", "../admin", "BTC/US DT"])("rejects symbol %j", async (symbol) => {
    h = await harness({});
    const r = await h.call("get_ticker", { symbol });
    expect(r.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("upper-cases a lower-case symbol", async () => {
    h = await harness({}, { "GET /markets/BTC/USDT": data(market("BTC/USDT")) });
    const r = await h.call("get_ticker", { symbol: "btc/usdt" });
    expect(r.isError).toBeFalsy();
    expect(h.calls[0]!.path).toBe("/markets/BTC/USDT");
  });

  it("cancel_all_orders requires a symbol (no account-wide cancel)", async () => {
    h = await harness(TRADE_ENV);
    for (const args of [{}, { symbol: null }, { symbol: "" }]) {
      const r = await h.call("cancel_all_orders", args);
      expect(r.isError).toBe(true);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("get_order needs exactly one of order_id / client_order_id", async () => {
    h = await harness(KEY_ENV);
    for (const args of [{}, { order_id: "a", client_order_id: "b" }]) {
      const r = await h.call("get_order", args);
      expect(r.isError).toBe(true);
      expect(structured(r).error.code).toBe("INVALID_INPUT");
    }
    expect(h.calls).toHaveLength(0);
  });

  it("limits are bounded", async () => {
    h = await harness({});
    expect((await h.call("list_markets", { limit: 51 })).isError).toBe(true);
    expect((await h.call("get_candles", { symbol: "BTC/USDT", interval: "1h", limit: 201 })).isError).toBe(true);
    expect((await h.call("get_candles", { symbol: "BTC/USDT", interval: "2h" })).isError).toBe(true);
    expect((await h.call("get_candles", { symbol: "BTC/USDT", interval: "1h", from: "yesterday" })).isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe("public tools", () => {
  it("get_server_status combines time and config and shows no credentials", async () => {
    h = await harness(KEY_ENV, {
      "GET /time": data({ epoch_ms: Date.now(), iso: "2026-09-26T10:00:00.000+00:00" }),
      "GET /config": data({
        name: "CEXY",
        maintenance_mode: false,
        candle_intervals: ["1m", "1h"],
        default_page_size: 50,
        max_page_size: 200,
        features: {},
        password_rules: {},
      }),
    });
    const r = await h.call("get_server_status");
    const s = structured(r);
    expect(s.maintenance_mode).toBe(false);
    expect(s.mcp_server).toMatchObject({ authenticated: true, trading_enabled: false, base_url: "https://api.cexy.io" });
    expect(text(r)).toMatch(/operational/);
    expect(JSON.stringify(r)).not.toContain("password_rules");
  });

  it("list_markets filters, pages and stays compact", async () => {
    h = await harness({}, { "GET /markets": data(MARKETS) });
    let s = structured(await h.call("list_markets", { quote: "usdt", status: "active" }));
    expect(s.markets.map((m: { symbol: string }) => m.symbol)).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(Object.keys(s.markets[0])).not.toContain("tick_size");
    s = structured(await h.call("list_markets", { search: "eth", limit: 1 }));
    expect(s).toMatchObject({ total: 2, count: 1, next_offset: 1 });
    s = structured(await h.call("list_markets", { search: "eth", limit: 1, offset: 1 }));
    expect(s.markets[0].symbol).toBe("ETH/BTC");
    expect(s.next_offset).toBeUndefined();
  });

  it("get_recent_trades passes next_cursor through", async () => {
    h = await harness({}, {
      "GET /markets/BTC/USDT/trades": {
        items: [{ id: "t1", price: "100", quantity: "0.1", side: "buy", sequence: 1, timestamp: "2026-09-26T10:00:00Z" }],
        has_more: true,
        next_cursor: "cur_2",
      },
    });
    const s = structured(await h.call("get_recent_trades", { symbol: "BTC/USDT", limit: 1, cursor: "cur_1" }));
    expect(s).toMatchObject({ count: 1, has_more: true, next_cursor: "cur_2" });
    expect(h.calls[0]!.query.get("cursor")).toBe("cur_1");
    expect(h.calls[0]!.query.get("limit")).toBe("1");
    expect(s.items[0].sequence).toBeUndefined();
  });

  it("get_candles returns rows with decimal strings and maps from/to", async () => {
    h = await harness({}, {
      "GET /markets/BTC/USDT/candles": data([
        { open_time: "2026-09-26T09:00:00Z", open: "1", high: "2", low: "0.5", close: "1.5", volume: "10", quote_volume: "15", trade_count: 3 },
      ]),
    });
    const s = structured(
      await h.call("get_candles", { symbol: "BTC/USDT", interval: "1h", from: "2026-09-26T00:00:00Z", to: "2026-09-26T12:00:00Z" }),
    );
    expect(s.rows).toEqual([["2026-09-26T09:00:00Z", "1", "2", "0.5", "1.5", "10"]]);
    expect(h.calls[0]!.query.get("start_time")).toBe("2026-09-26T00:00:00Z");
    expect(h.calls[0]!.query.get("interval")).toBe("1h");
  });

  it("list_assets joins network deposit/withdraw status", async () => {
    h = await harness({}, {
      "GET /assets": data([
        {
          symbol: "USDT",
          name: "Tether",
          trading_enabled: true,
          networks: [
            {
              network: "tron-mainnet",
              network_name: "Tron",
              deposit_enabled: true,
              withdrawal_enabled: false,
              maintenance: { reason: "withdrawals_disabled" },
              min_deposit: "1",
              min_withdrawal: "10",
              withdrawal_fee: "1",
              withdrawal_fee_asset: "USDT",
              deposit_confirmations: 20,
              memo_required: false,
            },
          ],
        },
      ]),
      "GET /networks": data([{ code: "tron-mainnet", name: "Tron", is_active: true, deposits_operational: false, reachable: true, average_block_seconds: 3 }]),
    });
    const s = structured(await h.call("list_assets"));
    expect(s.assets[0].networks[0]).toMatchObject({
      network: "tron-mainnet",
      deposit_enabled: true,
      withdrawal_enabled: false,
      deposits_operational: false,
      maintenance: "withdrawals_disabled",
      withdrawal_fee: "1 USDT",
    });
  });
});

describe("read-key tools", () => {
  it("get_balances hides zero balances by default and sends the key", async () => {
    h = await harness(KEY_ENV, {
      "GET /account/balances": data([
        { asset: "BTC", available: "0.5", locked: "0", pending: "0", total: "0.5" },
        { asset: "ETH", available: "0", locked: "0", pending: "0", total: "0.000" },
      ]),
    });
    let s = structured(await h.call("get_balances"));
    expect(s.balances.map((b: { asset: string }) => b.asset)).toEqual(["BTC"]);
    s = structured(await h.call("get_balances", { include_zero: true }));
    expect(s.count).toBe(2);
    expect(h.calls[0]!.headers.get("x-api-key")).toBe(KEY_ENV.CEXY_API_KEY);
  });

  it("get_balances lists held incoming transfers and defaults them to []", async () => {
    h = await harness(KEY_ENV, {
      "GET /account/balances": data([
        {
          asset: "USDT", available: "10", locked: "5", pending: "0", total: "15",
          held_incoming: [{ transfer_id: "tr_1", amount: "5", available_at: "2026-09-30T00:00:00Z" }],
        },
        { asset: "BTC", available: "0.5", locked: "0", pending: "0", total: "0.5" },
      ]),
    });
    const r = await h.call("get_balances");
    const s = structured(r);
    expect(s.balances[0].held_incoming).toEqual([{ transfer_id: "tr_1", amount: "5", available_at: "2026-09-30T00:00:00Z" }]);
    expect(s.balances[0].locked).toBe("5");
    expect(s.balances[1].held_incoming).toEqual([]);
    expect(JSON.stringify(r.content)).toContain("already included in locked");
  });

  it("get_sub_account_balances reads one sub-account with a GET and the same rows as get_balances", async () => {
    h = await harness(KEY_ENV, {
      "GET /account/sub-accounts/sa_1/balances": data([
        {
          asset: "USDT", available: "1", locked: "2", pending: "0", total: "3",
          held_incoming: [{ transfer_id: "tr_9", amount: "2", available_at: "2026-10-01T00:00:00Z" }],
        },
        { asset: "ETH", available: "0", locked: "0", pending: "0", total: "0" },
      ]),
    });
    const r = await h.call("get_sub_account_balances", { id: "sa_1" });
    const s = structured(r);
    expect(s.sub_account_id).toBe("sa_1");
    expect(s.balances).toEqual([
      {
        asset: "USDT", available: "1", locked: "2", pending: "0", total: "3", sequence: 0,
        held_incoming: [{ transfer_id: "tr_9", amount: "2", available_at: "2026-10-01T00:00:00Z" }],
      },
    ]);
    expect(JSON.stringify(r.content)).toContain("already included in locked");
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /account/sub-accounts/sa_1/balances"]);
    expect(h.calls[0]!.body).toBeUndefined();
  });

  it("get_balances rows carry sequence (0 when the server omits it)", async () => {
    h = await harness(KEY_ENV, {
      "GET /account/balances": data([
        { asset: "USDT", available: "1", locked: "0", pending: "0", total: "1", held_incoming: [], sequence: 42 },
        { asset: "BTC", available: "1", locked: "0", pending: "0", total: "1", held_incoming: [] },
      ]),
    });
    const s = structured(await h.call("get_balances"));
    expect(s.balances.map((b: { asset: string; sequence: number }) => [b.asset, b.sequence])).toEqual([["USDT", 42], ["BTC", 0]]);
  });

  it("get_sub_account_balances passes a 404 through as NOT_FOUND", async () => {
    h = await harness(KEY_ENV, {
      "GET /account/sub-accounts/sa_other/balances": () => ({
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "sub-account not found", request_id: "req_404" } },
      }),
    });
    const r = await h.call("get_sub_account_balances", { id: "sa_other" });
    expect(r.isError).toBe(true);
    expect(structured(r).error).toMatchObject({ code: "NOT_FOUND", status: 404, retryable: false });
  });

  it("get_sub_account_balances refuses path-escaping ids without any request", async () => {
    h = await harness(KEY_ENV, {});
    for (const id of [".", ".."]) {
      const r = await h.call("get_sub_account_balances", { id });
      expect(r.isError, id).toBe(true);
    }
    expect((await h.call("get_sub_account_balances", { id: "" })).isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("get_order_history pages with cursor and direction", async () => {
    h = await harness(KEY_ENV, {
      "GET /trading/orders/history": { items: [order()], has_more: false },
    });
    const s = structured(await h.call("get_order_history", { symbol: "BTC/USDT", cursor: "c1", direction: "asc", limit: 5 }));
    expect(s.items[0].id).toBe("ord_1");
    expect(s.items[0].client_order_id).toBeUndefined();
    expect(h.calls[0]!.query.get("direction")).toBe("asc");
    expect(h.calls[0]!.query.get("cursor")).toBe("c1");
  });

  it("get_order by client_order_id uses the by-client-id endpoint", async () => {
    h = await harness(KEY_ENV, { "GET /trading/orders/by-client-id/abc": data(order({ client_order_id: "abc" })) });
    const r = await h.call("get_order", { client_order_id: "abc" });
    expect(structured(r).order.client_order_id).toBe("abc");
  });
});
