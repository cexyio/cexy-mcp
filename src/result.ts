import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CancelAllInterruptedError,
  CexyApiError,
  CexyConfigError,
  CexyConnectionError,
  CexyTimeoutError,
  InvalidAmountError,
  OrderStateUnknownError,
  RateLimitError,
} from "@cexyio/cexy";
import type { Redactor } from "./redact.js";

/** Maximum serialized size of a tool result's JSON payload, in bytes. */
export const MAX_RESULT_BYTES = 20_000;

/** Rejected by a server-side guardrail (market allowlist, notional cap, ...). Not retryable. */
export class GuardrailError extends Error {
  override name = "GuardrailError";
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

/** Wraps a place_order failure so the error carries the client_order_id that was sent. */
export class OrderAttemptError extends Error {
  override name = "OrderAttemptError";
  readonly clientOrderId: string;
  constructor(clientOrderId: string, cause: unknown) {
    super("order attempt failed", { cause });
    this.clientOrderId = clientOrderId;
  }
}

/** Network error, timeout, 5xx, or an unconfirmed outcome: the order may or may not exist. */
export function isAmbiguousOrderFailure(err: unknown): boolean {
  return (
    err instanceof CexyConnectionError ||
    err instanceof OrderStateUnknownError ||
    (err instanceof CexyApiError && err.status >= 500)
  );
}

/** Bad tool input that the schema could not express (e.g. "exactly one of"). */
export class InputError extends Error {
  override name = "InputError";
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Drops `null`/`undefined` properties (one level) to keep results compact. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/**
 * Caps the JSON size of `data` at `maxBytes` by trimming its largest top-level arrays.
 * Adds `truncated: true` and a note when anything was dropped.
 */
export function capSize(data: Record<string, unknown>, maxBytes = MAX_RESULT_BYTES): Record<string, unknown> {
  if (byteLength(JSON.stringify(data)) <= maxBytes) return data;
  const out: Record<string, unknown> = { ...data, truncated: true };
  const dropped: Record<string, number> = {};
  // Budget for the note we add at the end.
  const budget = maxBytes - 200;
  for (let guard = 0; guard < 64 && byteLength(JSON.stringify(out)) > budget; guard++) {
    let bestKey: string | null = null;
    let bestSize = 0;
    for (const [k, v] of Object.entries(out)) {
      if (Array.isArray(v) && v.length > 0) {
        const size = byteLength(JSON.stringify(v));
        if (size > bestSize) {
          bestSize = size;
          bestKey = k;
        }
      }
    }
    if (bestKey === null) break;
    const arr = out[bestKey] as unknown[];
    const excess = byteLength(JSON.stringify(out)) - budget;
    // Keep the head of the list (most relevant first); drop proportionally, at least one item.
    const perItem = bestSize / arr.length;
    const drop = Math.min(arr.length, Math.max(1, Math.ceil(excess / Math.max(perItem, 1))));
    out[bestKey] = arr.slice(0, arr.length - drop);
    dropped[bestKey] = (dropped[bestKey] ?? 0) + drop;
  }
  if (byteLength(JSON.stringify(out)) > budget) {
    return {
      truncated: true,
      note: "The result was too large to return. Narrow the request (filters, a smaller limit or depth).",
    };
  }
  const parts = Object.entries(dropped).map(([k, n]) => `${n} ${k}`);
  out.truncated_note = `Result capped at about ${Math.round(maxBytes / 1000)} KB: dropped the last ${parts.join(", ")}. Use a smaller limit, filters or the cursor.`;
  return out;
}

/** A successful tool result: a short summary line, and the compact JSON as structured content and text. */
export function ok(summary: string, data: Record<string, unknown>, redactor: Redactor): CallToolResult {
  const capped = redactor.redactValue(capSize(data));
  const json = JSON.stringify(capped);
  return {
    content: [{ type: "text", text: `${redactor.redact(summary)}${capped.truncated ? " (truncated)" : ""}\n${json}` }],
    structuredContent: capped,
  };
}

export interface ToolErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  request_id: string | null;
  status?: number;
  fields?: Record<string, string>;
  retry_after_ms?: number | null;
  client_order_id?: string;
  details?: Record<string, unknown>;
  /** cancel_all_orders(until_done): what was already done before the error stopped the loop. */
  partial?: Record<string, unknown>;
}

/** Maps anything thrown by a tool handler to a safe error body. Never includes secrets or headers. */
export function errorBody(err: unknown): ToolErrorBody {
  if (err instanceof CancelAllInterruptedError) {
    // cancel_all_orders(until_done): report what was already done alongside the error that stopped it.
    const inner = errorBody(err.error);
    const p = err.partial;
    return {
      ...inner,
      message: `${inner.message} Stopped after ${p.rounds} round(s); already cancelled ${p.cancelled.length}.`,
      partial: {
        cancelled: p.cancelled, already_closed: p.already_closed, failed: p.failed,
        failures: p.failures.map((f) => ({ order_id: f.order_id, code: f.code, message: f.message })),
        rounds: p.rounds,
      },
    };
  }
  if (err instanceof OrderAttemptError) {
    const inner = errorBody(err.cause);
    if (isAmbiguousOrderFailure(err.cause)) {
      // F10: the order may exist. Never invite a blind retry.
      return {
        code: inner.code,
        message: `The order may or may not have been placed. Call get_order with client_order_id=${err.clientOrderId} before trying again; do not place a new order.`,
        retryable: false,
        request_id: inner.request_id,
        ...(inner.status !== undefined ? { status: inner.status } : {}),
        client_order_id: err.clientOrderId,
      };
    }
    return { ...inner, client_order_id: err.clientOrderId };
  }
  if (err instanceof CexyApiError) {
    const body: ToolErrorBody = {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      request_id: err.requestId,
      status: err.status,
    };
    if (Object.keys(err.fields).length > 0) body.fields = err.fields;
    if (err instanceof RateLimitError) body.retry_after_ms = err.retryAfterMs;
    return body;
  }
  if (err instanceof OrderStateUnknownError) {
    return {
      code: "ORDER_STATE_UNKNOWN",
      message:
        "The order request failed ambiguously and its state could not be confirmed. Do NOT place it again: " +
        "call get_order with this client_order_id first.",
      retryable: false,
      request_id: null,
      client_order_id: err.clientOrderId,
    };
  }
  if (err instanceof CexyTimeoutError) {
    return { code: "TIMEOUT", message: "The request to the exchange timed out.", retryable: true, request_id: null };
  }
  if (err instanceof CexyConnectionError) {
    return { code: "CONNECTION_ERROR", message: "Could not reach the exchange API.", retryable: true, request_id: null };
  }
  if (err instanceof GuardrailError) {
    return { code: "GUARDRAIL_REJECTED", message: err.message, retryable: false, request_id: null, details: err.details };
  }
  if (err instanceof InputError || err instanceof InvalidAmountError || err instanceof CexyConfigError) {
    return { code: "INVALID_INPUT", message: err.message, retryable: false, request_id: null };
  }
  return { code: "INTERNAL_ERROR", message: "Unexpected error in the CEXY MCP server.", retryable: false, request_id: null };
}

export function fail(err: unknown, redactor: Redactor): CallToolResult {
  const body = redactor.redactValue(errorBody(err));
  const rid = body.request_id ? ` (request_id ${body.request_id})` : "";
  return {
    isError: true,
    content: [{ type: "text", text: `Error ${body.code}: ${body.message}${rid}\n${JSON.stringify({ error: body })}` }],
    structuredContent: { error: body },
  };
}
