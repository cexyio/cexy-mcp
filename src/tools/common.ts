import type { CexyClient } from "@cexyio/cexy";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SYMBOL_PATTERN, type McpConfig } from "../config.js";
import type { Logger, Redactor } from "../redact.js";

export type Tier = "public" | "read" | "trade";

export interface ToolContext {
  client: CexyClient;
  config: McpConfig;
  redactor: Redactor;
  logger: Logger;
}

export interface ToolOutput {
  summary: string;
  data: Record<string, unknown>;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  tier: Tier;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  handler: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput>;
}

/** Type-checks a tool definition and erases its input type for the registry. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: true,
  destructiveHint: false,
};

export const TRADE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

// ---- shared input schemas --------------------------------------------------------------

export const symbolSchema = z
  .string()
  .regex(SYMBOL_PATTERN, "symbol must be BASE/QUOTE, e.g. BTC/USDT")
  .describe("Market symbol as BASE/QUOTE, e.g. BTC/USDT");

export const assetSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,20}$/, "asset must be a ticker such as BTC")
  .describe("Asset ticker, e.g. BTC");

export const decimalSchema = z.string().regex(/^\d+(\.\d+)?$/, "amounts are decimal strings such as \"0.015\" (no exponent, no sign)");

export const cursorSchema = z.string().min(1).max(1024).describe("next_cursor from a previous page").optional();

export const directionSchema = z.enum(["asc", "desc"]).describe("Sort order (default: newest first)").optional();

export function limitSchema(def: number, max: number) {
  return z.number().int().min(1).max(max).default(def).describe(`Items to return (1-${max}, default ${def})`);
}

export const orderStatusSchema = z.enum([
  "pending",
  "open",
  "partially_filled",
  "filled",
  "cancelled",
  "rejected",
  "pending_trigger",
  "expired",
]);

export const uuidSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a UUID");

export const orderIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "invalid order id");

// ---- compact views -------------------------------------------------------------------------

export function upper(s: string): string {
  return s.toUpperCase();
}

/** Keeps only non-null fields. */
export function pick<T extends object>(obj: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined) out[k as string] = v;
  }
  return out;
}

export function pageData<T>(
  items: T[],
  view: (t: T) => Record<string, unknown>,
  page: { has_more?: boolean; next_cursor?: string | undefined },
): Record<string, unknown> {
  const data: Record<string, unknown> = { count: items.length, items: items.map(view), has_more: page.has_more ?? false };
  if (page.next_cursor) data.next_cursor = page.next_cursor;
  return data;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
