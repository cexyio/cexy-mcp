import type { Balance, Deposit, Fill, LedgerEntry, Order, Withdrawal } from "@cexyio/cexy";
import { z } from "zod";
import { isZero } from "../decimal.js";
import { InputError } from "../result.js";
import {
  READ_ANNOTATIONS,
  assetSchema,
  cursorSchema,
  defineTool,
  directionSchema,
  limitSchema,
  orderIdSchema,
  orderStatusSchema,
  pageData,
  pick,
  plural,
  symbolSchema,
  upper,
  type ToolDef,
} from "./common.js";

const ORDER_KEYS = [
  "id",
  "client_order_id",
  "symbol",
  "side",
  "type",
  "status",
  "status_reason",
  "price",
  "stop_price",
  "quantity",
  "quote_quantity",
  "filled_quantity",
  "filled_quote_quantity",
  "remaining_quantity",
  "average_price",
  "fee_paid",
  "fee_asset",
  "time_in_force",
  "created_at",
  "updated_at",
  "closed_at",
] as const satisfies readonly (keyof Order)[];

export function orderView(o: Order): Record<string, unknown> {
  return pick(o, ORDER_KEYS);
}

const FILL_KEYS = [
  "trade_id",
  "order_id",
  "symbol",
  "side",
  "role",
  "price",
  "quantity",
  "quote_quantity",
  "fee",
  "fee_asset",
  "timestamp",
] as const satisfies readonly (keyof Fill)[];

export function fillView(f: Fill): Record<string, unknown> {
  return pick(f, FILL_KEYS);
}

const DEPOSIT_KEYS = [
  "id",
  "asset",
  "network",
  "amount",
  "status",
  "confirmations",
  "required_confirmations",
  "txid",
  "first_seen_at",
  "credited_at",
  "explorer_url",
] as const satisfies readonly (keyof Deposit)[];

const WITHDRAWAL_KEYS = [
  "id",
  "asset",
  "network",
  "amount",
  "fee",
  "fee_asset",
  "status",
  "address",
  "memo",
  "txid",
  "confirmations",
  "created_at",
  "broadcast_at",
  "completed_at",
  "explorer_url",
] as const satisfies readonly (keyof Withdrawal)[];

const LEDGER_KEYS = [
  "id",
  "sequence",
  "created_at",
  "asset",
  "kind",
  "available_delta",
  "locked_delta",
  "pending_delta",
  "available_after",
  "reference",
] as const satisfies readonly (keyof LedgerEntry)[];

const pagedInput = {
  limit: limitSchema(20, 50),
  cursor: cursorSchema,
  direction: directionSchema,
};

export const accountTools: ToolDef[] = [
  defineTool({
    name: "get_balances",
    tier: "read",
    title: "Balances",
    description:
      "Your CEXY.io balances per asset (available, locked, pending, total). held_incoming lists incoming internal " +
      "transfers still held (amount, available_at); their sum is ALREADY part of locked, so never add it again. Zero " +
      "balances are hidden unless include_zero is true. Needs an API key with the read scope.",
    input: {
      asset: assetSchema.describe("Only this asset").optional(),
      include_zero: z.boolean().default(false).describe("Include assets with a zero total"),
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ asset, include_zero }, { client }) => {
      const all = await client.account.balances();
      const a = asset?.toUpperCase();
      const rows = all
        .filter((b) => !a || b.asset.toUpperCase() === a)
        .filter((b) => include_zero || !isZero(b.total))
        .map(balanceView);
      const hidden = all.length - rows.length;
      const held = rows.reduce((n, b) => n + b.held_incoming.length, 0);
      return {
        summary:
          `${plural(rows.length, "balance")}${!include_zero && !a && hidden > 0 ? ` (${hidden} zero balances hidden)` : ""}` +
          `${held ? `; ${plural(held, "incoming transfer")} still held (already included in locked)` : ""}.`,
        data: { count: rows.length, balances: rows },
      };
    },
  }),

  defineTool({
    name: "list_open_orders",
    tier: "read",
    title: "Open orders",
    description: "Your open orders (optionally in one market or with one status). Needs the read scope.",
    input: {
      symbol: symbolSchema.optional(),
      status: orderStatusSchema.optional(),
      limit: limitSchema(50, 50),
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol, status, limit }, { client }) => {
      const orders = await client.trading.openOrders({ symbol: symbol ? upper(symbol) : null, status: status ?? null });
      const page = orders.slice(0, limit);
      const data: Record<string, unknown> = { total: orders.length, count: page.length, orders: page.map(orderView) };
      if (orders.length > page.length) {
        data.truncated = true;
        data.truncated_note = `Showing ${page.length} of ${orders.length}; filter by symbol to see the rest.`;
      }
      return { summary: `${plural(orders.length, "open order")}.`, data };
    },
  }),

  defineTool({
    name: "get_order",
    tier: "read",
    title: "Get order",
    description: "One of your orders, by order_id or by client_order_id (give exactly one). Needs the read scope.",
    input: {
      order_id: orderIdSchema.optional(),
      client_order_id: z.string().min(1).max(128).optional(),
    },
    annotations: READ_ANNOTATIONS,
    handler: async ({ order_id, client_order_id }, { client }) => {
      if (!!order_id === !!client_order_id) throw new InputError("give exactly one of order_id or client_order_id");
      const o = order_id ? await client.trading.order(order_id) : await client.trading.orderByClientId(client_order_id as string);
      return {
        summary: `Order ${o.id}: ${o.side} ${o.quantity} ${o.symbol} ${o.type}, ${o.status}, filled ${o.filled_quantity}.`,
        data: { order: orderView(o) },
      };
    },
  }),

  defineTool({
    name: "get_order_history",
    tier: "read",
    title: "Order history",
    description: "Your past and present orders, newest first by default, paged with next_cursor. Needs the read scope.",
    input: { symbol: symbolSchema.optional(), status: orderStatusSchema.optional(), ...pagedInput },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol, status, limit, cursor, direction }, { client }) => {
      const page = await client.trading.orderHistory({
        symbol: symbol ? upper(symbol) : null,
        status: status ?? null,
        limit,
        cursor,
        direction,
      });
      const items = page.items.slice(0, limit);
      return { summary: `${plural(items.length, "order")}${page.has_more ? " (more available)" : ""}.`, data: pageData(items, orderView, page) };
    },
  }),

  defineTool({
    name: "get_my_trades",
    tier: "read",
    title: "My trades",
    description: "Your executions (fills) with price, quantity, fee and maker/taker role, paged with next_cursor. Needs the read scope.",
    input: { symbol: symbolSchema.optional(), ...pagedInput },
    annotations: READ_ANNOTATIONS,
    handler: async ({ symbol, limit, cursor, direction }, { client }) => {
      const page = await client.trading.trades({ symbol: symbol ? upper(symbol) : null, limit, cursor, direction });
      const items = page.items.slice(0, limit);
      return { summary: `${plural(items.length, "fill")}${page.has_more ? " (more available)" : ""}.`, data: pageData(items, fillView, page) };
    },
  }),

  defineTool({
    name: "list_deposits",
    tier: "read",
    title: "Deposits",
    description: "Your deposit history (read only), paged with next_cursor. Needs the read scope.",
    input: { asset: assetSchema.optional(), ...pagedInput },
    annotations: READ_ANNOTATIONS,
    handler: async ({ asset, limit, cursor, direction }, { client }) => {
      const page = await client.wallet.deposits({ asset: asset ? upper(asset) : null, limit, cursor, direction });
      const items = page.items.slice(0, limit);
      return {
        summary: `${plural(items.length, "deposit")}${page.has_more ? " (more available)" : ""}.`,
        data: pageData(items, (d) => pick(d, DEPOSIT_KEYS), page),
      };
    },
  }),

  defineTool({
    name: "list_withdrawals",
    tier: "read",
    title: "Withdrawals",
    description:
      "Your withdrawal history (read only; this server cannot create withdrawals), paged with next_cursor. Needs the read scope.",
    input: { asset: assetSchema.optional(), ...pagedInput },
    annotations: READ_ANNOTATIONS,
    handler: async ({ asset, limit, cursor, direction }, { client }) => {
      const page = await client.wallet.withdrawals({ asset: asset ? upper(asset) : null, limit, cursor, direction });
      const items = page.items.slice(0, limit);
      return {
        summary: `${plural(items.length, "withdrawal")}${page.has_more ? " (more available)" : ""}.`,
        data: pageData(items, (w) => pick(w, WITHDRAWAL_KEYS), page),
      };
    },
  }),

  defineTool({
    name: "get_ledger",
    tier: "read",
    title: "Ledger",
    description:
      "Your account ledger: every balance change (trades, fees, deposits, withdrawals, ...) with deltas and the resulting " +
      "available balance, paged with next_cursor. Needs the read scope.",
    input: { asset: assetSchema.optional(), ...pagedInput },
    annotations: READ_ANNOTATIONS,
    handler: async ({ asset, limit, cursor, direction }, { client }) => {
      const page = await client.account.ledger({ asset: asset ? upper(asset) : null, limit, cursor, direction });
      const items = page.items.slice(0, limit);
      return {
        summary: `${plural(items.length, "ledger entry")}${page.has_more ? " (more available)" : ""}.`.replace("entrys", "entries"),
        data: pageData(items, (e) => pick(e, LEDGER_KEYS), page),
      };
    },
  }),
];

/** A balance row for tool output; held_incoming defaults to [] (older servers omit it). */
function balanceView(b: Balance) {
  return {
    ...pick(b, ["asset", "available", "locked", "pending", "total"]),
    held_incoming: (b.held_incoming ?? []).map((h) => ({
      transfer_id: h.transfer_id,
      amount: h.amount,
      available_at: h.available_at,
    })),
  };
}
