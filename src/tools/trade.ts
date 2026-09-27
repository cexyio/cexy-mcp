import { randomUUID } from "node:crypto";
import type { CexyClient, PlaceOrderRequest } from "@cexyio/cexy";
import { z } from "zod";
import type { McpConfig } from "../config.js";
import { compare, isPositiveDecimal, max, mul, add, min, sub } from "../decimal.js";
import { GuardrailError, InputError, OrderAttemptError } from "../result.js";
import { fillView, orderView } from "./account.js";
import {
  TRADE_ANNOTATIONS,
  decimalSchema,
  defineTool,
  orderIdSchema,
  plural,
  symbolSchema,
  upper,
  uuidSchema,
  type ToolDef,
} from "./common.js";

export interface OrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market" | "stop_limit" | "stop_market";
  quantity?: string | undefined;
  quote_quantity?: string | undefined;
  price?: string | undefined;
  stop_price?: string | undefined;
}

export interface NotionalBound {
  /** Upper bound of the order's value in quote currency, or null if it cannot be bounded. */
  notional: string | null;
  method: string;
}

/** Levels deep enough to price a market order against the book. */
const BOOK_DEPTH_FOR_BOUND = 50;

/**
 * An upper bound for the value (in quote currency) an order can exchange, used by the
 * CEXY_MCP_MAX_ORDER_NOTIONAL guardrail. Conservative: when several bounds apply, the
 * largest is used; when none can be established, `notional` is null and the order is refused.
 */
export async function boundNotional(order: OrderInput, client: CexyClient): Promise<NotionalBound> {
  const bounds: { value: string; method: string }[] = [];
  if (order.quote_quantity) bounds.push({ value: order.quote_quantity, method: "quote_quantity" });

  if (order.quantity) {
    const qty = order.quantity;
    const needsBook =
      order.type === "market" || (order.side === "sell" && (order.type === "limit" || order.type === "stop_limit"));
    const book = needsBook ? await client.markets.orderbook(order.symbol, { depth: BOOK_DEPTH_FOR_BOUND }) : null;
    const bestBid = book?.bids[0]?.[0];

    if (order.type === "limit" || order.type === "stop_limit") {
      if (!order.price) return { notional: null, method: "limit order without price" };
      if (order.side === "buy") {
        // A buy never pays more than its limit price.
        bounds.push({ value: mul(order.price, qty), method: "price x quantity" });
      } else if (order.type === "limit") {
        // A sell can fill above its limit, at up to the best bid it crosses.
        const ref = bestBid ? max(order.price, bestBid) : order.price;
        bounds.push({ value: mul(ref, qty), method: "max(price, best bid) x quantity" });
      } else {
        return { notional: null, method: "stop-limit sell: fill price depends on the book when it triggers" };
      }
    } else if (order.type === "market") {
      if (order.side === "sell") {
        if (!bestBid) return { notional: null, method: "market sell: no bids to price it" };
        bounds.push({ value: mul(bestBid, qty), method: "best bid x quantity" });
      } else {
        // Walk the asks: the cost of buying `qty` now.
        let remaining = qty;
        let cost = "0";
        for (const [price, size] of book?.asks ?? []) {
          if (!price || !size || compare(remaining, "0") <= 0) break;
          const take = min(remaining, size);
          cost = add(cost, mul(take, price));
          remaining = sub(remaining, take);
        }
        if (compare(remaining, "0") > 0) {
          return { notional: null, method: `market buy: the top ${BOOK_DEPTH_FOR_BOUND} ask levels do not cover the quantity` };
        }
        bounds.push({ value: cost, method: "cost of walking the asks" });
      }
    } else {
      return { notional: null, method: "stop-market with quantity: fill price depends on the book when it triggers" };
    }
  }

  if (bounds.length === 0) return { notional: null, method: "no quantity or quote_quantity" };
  const top = bounds.reduce((a, b) => (compare(a.value, b.value) >= 0 ? a : b));
  return { notional: top.value, method: top.method };
}

function checkAllowedMarket(symbol: string, config: McpConfig): void {
  if (config.allowedMarkets && !config.allowedMarkets.includes(symbol)) {
    throw new GuardrailError(`${symbol} is not in CEXY_MCP_ALLOWED_MARKETS; this server only trades ${config.allowedMarkets.join(", ")}.`, {
      symbol,
      allowed_markets: config.allowedMarkets,
    });
  }
}

export const tradeTools: ToolDef[] = [
  defineTool({
    name: "place_order",
    tier: "trade",
    title: "Place order (REAL)",
    description:
      "Places a REAL order on CEXY.io with real funds. Once filled it is irreversible. Confirm the market, side, " +
      "type, quantity and price with the user before calling. Amounts are decimal strings. A client_order_id (UUID) is " +
      "always set (generated if you omit it) and returned; the request is never blindly retried: if the outcome is " +
      "unknown, call get_order with that client_order_id before trying again. Market allowlist and per-order notional " +
      "cap guardrails apply when configured. Needs an API key with the trade scope.",
    input: {
      symbol: symbolSchema,
      side: z.enum(["buy", "sell"]),
      type: z.enum(["limit", "market", "stop_limit", "stop_market"]),
      quantity: decimalSchema.describe("Base-asset quantity, e.g. \"0.01\"").optional(),
      quote_quantity: decimalSchema.describe("Quote-asset amount to spend/receive (market orders), e.g. \"100\"").optional(),
      price: decimalSchema.describe("Limit price (limit and stop_limit)").optional(),
      stop_price: decimalSchema.describe("Trigger price (stop_limit and stop_market)").optional(),
      time_in_force: z.enum(["gtc", "ioc", "fok", "post_only"]).optional(),
      trigger_direction: z.enum(["above", "below"]).describe("Stop orders: trigger when the price moves above or below stop_price").optional(),
      client_order_id: uuidSchema.describe("Optional UUID; generated when omitted").optional(),
    },
    annotations: { ...TRADE_ANNOTATIONS, title: "Place order (REAL)" },
    handler: async (args, { client, config, logger }) => {
      const symbol = upper(args.symbol);
      if (!args.quantity && !args.quote_quantity) throw new InputError("give quantity or quote_quantity");
      for (const f of ["quantity", "quote_quantity", "price", "stop_price"] as const) {
        const v = args[f];
        if (v !== undefined && !isPositiveDecimal(v)) throw new InputError(`${f} must be greater than zero`);
      }
      if ((args.type === "limit" || args.type === "stop_limit") && !args.price) throw new InputError(`${args.type} orders need a price`);
      if ((args.type === "stop_limit" || args.type === "stop_market") && !args.stop_price) {
        throw new InputError(`${args.type} orders need a stop_price`);
      }
      if (args.type === "market" && args.price) throw new InputError("market orders take no price");

      checkAllowedMarket(symbol, config);

      const order: OrderInput = { ...args, symbol };
      let notionalCheck: Record<string, unknown> | null = null;
      if (config.maxOrderNotional !== null) {
        const bound = await boundNotional(order, client);
        if (bound.notional === null) {
          throw new GuardrailError(
            `CEXY_MCP_MAX_ORDER_NOTIONAL is set and this order's value cannot be bounded (${bound.method}). ` +
              "Use a limit order, or quote_quantity for a market buy.",
            { max_order_notional: config.maxOrderNotional },
          );
        }
        if (compare(bound.notional, config.maxOrderNotional) > 0) {
          throw new GuardrailError(
            `Order value up to ${bound.notional} exceeds CEXY_MCP_MAX_ORDER_NOTIONAL (${config.maxOrderNotional}).`,
            { estimated_notional: bound.notional, method: bound.method, max_order_notional: config.maxOrderNotional },
          );
        }
        notionalCheck = { estimated_notional: bound.notional, method: bound.method, max_order_notional: config.maxOrderNotional };
      }

      const clientOrderId = args.client_order_id ?? randomUUID();
      const body: PlaceOrderRequest = {
        symbol,
        side: args.side,
        type: args.type,
        quantity: args.quantity ?? null,
        quote_quantity: args.quote_quantity ?? null,
        price: args.price ?? null,
        stop_price: args.stop_price ?? null,
        time_in_force: args.time_in_force ?? null,
        trigger_direction: args.trigger_direction ?? null,
        client_order_id: clientOrderId,
      };
      logger.info("placing order", { symbol, side: args.side, type: args.type, client_order_id: clientOrderId });
      // maxRetries 0: never re-send. After an ambiguous failure the SDK only looks the order up by client_order_id.
      let res;
      try {
        res = await client.trading.placeOrder(body, { maxRetries: 0 });
      } catch (err) {
        throw new OrderAttemptError(clientOrderId, err);
      }
      const o = res.order;
      const data: Record<string, unknown> = {
        client_order_id: res.client_order_id,
        recovered: res.recovered,
        order: orderView(o),
        fills: res.fills.map(fillView),
      };
      if (notionalCheck) data.notional_check = notionalCheck;
      return {
        summary: `Order ${o.id} ${o.status}: ${o.side} ${o.quantity} ${o.symbol} ${o.type}, filled ${o.filled_quantity}, ${plural(res.fills.length, "fill")}.`,
        data,
      };
    },
  }),

  defineTool({
    name: "cancel_order",
    tier: "trade",
    title: "Cancel order",
    description:
      "Cancels one of your open orders, by order_id or client_order_id (exactly one). Returns the order's resulting state. " +
      "Needs the trade scope.",
    input: {
      order_id: orderIdSchema.optional(),
      client_order_id: z.string().min(1).max(128).optional(),
    },
    annotations: { ...TRADE_ANNOTATIONS, idempotentHint: true, title: "Cancel order" },
    handler: async ({ order_id, client_order_id }, { client }) => {
      if (!!order_id === !!client_order_id) throw new InputError("give exactly one of order_id or client_order_id");
      const id = order_id ?? (await client.trading.orderByClientId(client_order_id as string)).id;
      const o = await client.trading.cancelOrder(id);
      return { summary: `Order ${o.id} is ${o.status} (filled ${o.filled_quantity}).`, data: { order: orderView(o) } };
    },
  }),

  defineTool({
    name: "cancel_all_orders",
    tier: "trade",
    title: "Cancel all orders in a market",
    description:
      "Cancels every open order you have in ONE market. symbol is required: this server never cancels across all " +
      "markets. One call handles up to 500 orders; already_closed lists orders that closed on their own (not an " +
      "error), and failures says why an order could not be cancelled. With until_done=true it repeats the call " +
      "(up to 20 rounds or 2 minutes) while more orders remain or some are still being placed. The exchange allows " +
      "30 cancel-all calls a minute. Needs the trade scope.",
    input: {
      symbol: symbolSchema,
      until_done: z.boolean().optional().describe("Repeat until every order is handled (default false: one call)."),
    },
    annotations: { ...TRADE_ANNOTATIONS, idempotentHint: true, title: "Cancel all orders in a market" },
    handler: async ({ symbol, until_done }, { client }) => {
      const s = upper(symbol);
      if (!s) throw new InputError("symbol is required");
      const failuresView = (fs: { order_id: string; code: string; message: string }[]) =>
        fs.map((f) => ({ order_id: f.order_id, code: f.code, message: f.message }));
      if (until_done === true) {
        const res = await client.trading.cancelAll({ symbol: s, untilDone: true });
        const tail = res.stopped === "done" ? "" : ` Stopped early (${res.stopped}); call again to continue.`;
        return {
          summary:
            `${plural(res.cancelled.length, "order")} cancelled in ${s}, ${res.already_closed.length} already closed` +
            `${res.failed.length ? `, ${res.failed.length} failed` : ""} (${plural(res.rounds, "round")}).${tail}`,
          data: {
            symbol: s, cancelled: res.cancelled, already_closed: res.already_closed, failed: res.failed,
            failures: failuresView(res.failures), has_more: res.has_more, rounds: res.rounds, stopped: res.stopped,
          },
        };
      }
      const res = await client.trading.cancelAll({ symbol: s });
      const more = res.has_more ? " More orders remain: call again, or use until_done=true." : "";
      return {
        summary:
          `${plural(res.cancelled.length, "order")} cancelled in ${s}` +
          (res.already_closed.length ? `, ${res.already_closed.length} already closed` : "") +
          `${res.failed.length ? `, ${res.failed.length} failed` : ""}.${more}`,
        data: {
          symbol: s, cancelled: res.cancelled, already_closed: res.already_closed, failed: res.failed,
          failures: failuresView(res.failures), has_more: res.has_more,
        },
      };
    },
  }),
];
