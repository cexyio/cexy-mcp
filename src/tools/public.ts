import type { Market } from "@cexyio/cexy";
import { z } from "zod";
import { publicConfigView } from "../config.js";
import { VERSION } from "../version.js";
import {
  READ_ANNOTATIONS,
  assetSchema,
  cursorSchema,
  defineTool,
  directionSchema,
  limitSchema,
  pick,
  pageData,
  plural,
  symbolSchema,
  upper,
  type ToolDef,
} from "./common.js";

const MARKET_SUMMARY_KEYS = [
  "symbol",
  "status",
  "last_price",
  "change_24h_percent",
  "quote_volume_24h",
  "best_bid",
  "best_ask",
] as const satisfies readonly (keyof Market)[];

const TICKER_KEYS = [
  "symbol",
  "status",
  "last_price",
  "best_bid",
  "best_ask",
  "change_24h_percent",
  "high_24h",
  "low_24h",
  "volume_24h",
  "quote_volume_24h",
  "last_trade_at",
] as const satisfies readonly (keyof Market)[];

export const publicTools: ToolDef[] = [
  defineTool({
    name: "get_server_status",
    tier: "public",
    title: "Exchange status",
    description:
      "CEXY.io server time, maintenance state, API limits (page sizes, candle intervals) and this MCP server's own configuration " +
      "(authenticated or not, trading enabled or not, guardrails). Call this first when unsure what is available.",
    input: {},
    annotations: READ_ANNOTATIONS,
    handler: async (_args, { client, config }) => {
      const before = Date.now();
      const [time, cfg] = await Promise.all([client.time(), client.config()]);
      const after = Date.now();
      const data = {
        server_time: time.iso,
        clock_skew_ms: time.epoch_ms - Math.round((before + after) / 2),
        exchange: cfg.name,
        maintenance_mode: cfg.maintenance_mode,
        maintenance_message: cfg.maintenance_message ?? null,
        candle_intervals: cfg.candle_intervals,
        default_page_size: cfg.default_page_size,
        max_page_size: cfg.max_page_size,
        mcp_server: { version: VERSION, ...publicConfigView(config) },
      };
      const state = cfg.maintenance_mode ? "IN MAINTENANCE" : "operational";
      return { summary: `${cfg.name} is ${state}; server time ${time.iso}.`, data };
    },
  }),

  defineTool({
    name: "list_markets",
    tier: "public",
    title: "List markets",
    description:
      "Lists CEXY.io spot markets with a compact ticker (last price, 24h change, 24h quote volume, best bid/ask). " +
      "Filter by quote asset, status or search text; page with offset.",
    input: {
      quote: assetSchema.describe("Only markets quoted in this asset, e.g. USDT").optional(),
      status: z.enum(["active", "paused", "sell_only", "pre_trading", "delisted"]).optional(),
      search: z.string().min(1).max(40).describe("Case-insensitive text matched against the symbol").optional(),
      limit: limitSchema(20, 50),
      offset: z.number().int().min(0).max(10_000).default(0).describe("Markets to skip (for paging)"),
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ quote, status, search, limit, offset }, { client }) => {
      const all = await client.markets.list();
      const q = quote?.toUpperCase();
      const s = search?.toUpperCase();
      const matched = all.filter(
        (m) =>
          (!q || m.quote_asset.toUpperCase() === q) &&
          (!status || m.status === status) &&
          (!s || m.symbol.toUpperCase().includes(s)),
      );
      const page = matched.slice(offset, offset + limit);
      const data: Record<string, unknown> = {
        total: matched.length,
        offset,
        count: page.length,
        markets: page.map((m) => pick(m, MARKET_SUMMARY_KEYS)),
      };
      if (offset + page.length < matched.length) data.next_offset = offset + page.length;
      return { summary: `${plural(page.length, "market")} of ${matched.length} matching.`, data };
    },
  }),

  defineTool({
    name: "get_market",
    tier: "public",
    title: "Market details",
    description:
      "Full details of one market: trading rules (tick size, lot size, min/max quantity, min notional, decimals, " +
      "supported order types and time-in-force) and its 24h ticker.",
    input: { symbol: symbolSchema },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol }, { client }) => {
      const m = await client.markets.get(upper(symbol));
      return { summary: `${m.symbol} (${m.status}), last ${m.last_price}.`, data: pick(m, Object.keys(m) as (keyof Market)[]) };
    },
  }),

  defineTool({
    name: "get_ticker",
    tier: "public",
    title: "Ticker",
    description: "Compact 24h ticker for one market: last price, best bid/ask, 24h change, high, low and volume.",
    input: { symbol: symbolSchema },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol }, { client }) => {
      const m = await client.markets.get(upper(symbol));
      return {
        summary: `${m.symbol}: last ${m.last_price}, bid ${m.best_bid}, ask ${m.best_ask}, 24h ${m.change_24h_percent}%.`,
        data: pick(m, TICKER_KEYS),
      };
    },
  }),

  defineTool({
    name: "get_orderbook",
    tier: "public",
    title: "Order book",
    description:
      "Order-book snapshot for one market, aggregated by price: bids and asks as [price, quantity] pairs, best first.",
    input: {
      symbol: symbolSchema,
      depth: z.number().int().min(1).max(50).default(10).describe("Price levels per side (1-50, default 10)"),
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol, depth }, { client }) => {
      const book = await client.markets.orderbook(upper(symbol), { depth });
      const bids = book.bids.slice(0, depth);
      const asks = book.asks.slice(0, depth);
      return {
        summary: `${book.symbol}: best bid ${bids[0]?.[0] ?? "none"}, best ask ${asks[0]?.[0] ?? "none"} (${bids.length}/${asks.length} levels).`,
        data: { symbol: book.symbol, timestamp: book.timestamp, sequence: book.sequence, bids, asks },
      };
    },
  }),

  defineTool({
    name: "get_recent_trades",
    tier: "public",
    title: "Recent trades",
    description: "Recent public trades in one market (price, quantity, taker side, time), newest first by default.",
    input: {
      symbol: symbolSchema,
      limit: limitSchema(20, 50),
      cursor: cursorSchema,
      direction: directionSchema,
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol, limit, cursor, direction }, { client }) => {
      const page = await client.markets.trades(upper(symbol), { limit, cursor, direction });
      const items = page.items.slice(0, limit);
      return {
        summary: `${plural(items.length, "trade")} in ${upper(symbol)}.`,
        data: {
          symbol: upper(symbol),
          ...pageData(items, (t) => pick(t, ["id", "price", "quantity", "side", "timestamp"]), page),
        },
      };
    },
  }),

  defineTool({
    name: "get_candles",
    tier: "public",
    title: "Candles (OHLCV)",
    description:
      "OHLCV candles for one market, returned as rows of [open_time, open, high, low, close, volume]. " +
      "Use from/to (ISO 8601) to pick a window; the count is capped at 200.",
    input: {
      symbol: symbolSchema,
      interval: z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]).describe("Candle interval"),
      from: z.iso.datetime({ offset: true }).describe("Window start, ISO 8601").optional(),
      to: z.iso.datetime({ offset: true }).describe("Window end, ISO 8601").optional(),
      limit: limitSchema(50, 200),
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol, interval, from, to, limit }, { client }) => {
      const candles = await client.markets.candles(upper(symbol), {
        interval,
        limit,
        start_time: from ?? null,
        end_time: to ?? null,
      });
      const rows = candles.slice(-limit).map((c) => [c.open_time, c.open, c.high, c.low, c.close, c.volume]);
      return {
        summary: `${plural(rows.length, "candle")} (${interval}) for ${upper(symbol)}.`,
        data: {
          symbol: upper(symbol),
          interval,
          columns: ["open_time", "open", "high", "low", "close", "volume"],
          count: rows.length,
          rows,
        },
      };
    },
  }),

  defineTool({
    name: "list_assets",
    tier: "public",
    title: "Assets and networks",
    description:
      "Assets listed on CEXY.io with, for each network, whether deposits and withdrawals are enabled, whether deposit " +
      "detection is operational, any maintenance, minimums and the withdrawal fee.",
    input: {
      asset: assetSchema.describe("Only this asset, e.g. USDT").optional(),
      limit: limitSchema(30, 50),
      offset: z.number().int().min(0).max(10_000).default(0).describe("Assets to skip (for paging)"),
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ asset, limit, offset }, { client }) => {
      const [assets, networks] = await Promise.all([client.assets.list(), client.networks.list()]);
      const byCode = new Map(networks.map((n) => [n.code, n]));
      const a = asset?.toUpperCase();
      const matched = assets.filter((x) => !a || x.symbol.toUpperCase() === a);
      const page = matched.slice(offset, offset + limit);
      const view = page.map((x) => ({
        symbol: x.symbol,
        name: x.name,
        trading_enabled: x.trading_enabled,
        ...(x.notice ? { notice: x.notice } : {}),
        networks: x.networks.map((n) => {
          const net = byCode.get(n.network);
          return {
            network: n.network,
            deposit_enabled: n.deposit_enabled,
            withdrawal_enabled: n.withdrawal_enabled,
            ...(net ? { deposits_operational: net.deposits_operational, network_active: net.is_active } : {}),
            ...(n.maintenance ? { maintenance: n.maintenance.reason } : {}),
            min_deposit: n.min_deposit,
            min_withdrawal: n.min_withdrawal,
            withdrawal_fee: `${n.withdrawal_fee} ${n.withdrawal_fee_asset}`,
            confirmations: n.deposit_confirmations,
            ...(n.memo_required ? { memo_required: true } : {}),
            ...(n.notice ? { notice: n.notice } : {}),
          };
        }),
      }));
      const data: Record<string, unknown> = { total: matched.length, offset, count: view.length, assets: view };
      if (offset + view.length < matched.length) data.next_offset = offset + view.length;
      return { summary: `${plural(view.length, "asset")} of ${matched.length}.`, data };
    },
  }),

  defineTool({
    name: "get_fees",
    tier: "public",
    title: "Trading fees",
    description: "The trading fee schedule: maker and taker rates (percent) by 30-day USD volume tier.",
    input: {},
    annotations: READ_ANNOTATIONS,
    handler: async (_args, { client }) => {
      const tiers = await client.fees.get();
      const view = tiers.map((t) => pick(t, ["tier", "label", "maker_fee_percent", "taker_fee_percent", "min_30d_volume_usd"]));
      const base = tiers[0];
      return {
        summary: base
          ? `${plural(tiers.length, "fee tier")}; base maker ${base.maker_fee_percent}%, taker ${base.taker_fee_percent}%.`
          : "No fee tiers returned.",
        data: { tiers: view },
      };
    },
  }),
];
