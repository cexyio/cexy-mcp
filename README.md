# @cexyio/mcp

The official [Model Context Protocol](https://modelcontextprotocol.io) server for the
[CEXY.io](https://cexy.io) exchange. It lets an AI assistant (Claude Code, Claude Desktop, or any
MCP client) read market data and, with your API key, your balances, orders and history.

- **Read-only by default.** Trading tools do not exist unless you turn them on.
- **It never moves funds.** There are no withdrawal, transfer or deposit-address tools, and CEXY
  API keys cannot withdraw anyway.
- Runs locally over **stdio**. It opens no network port.
- Built on the official TypeScript SDK, [`@cexyio/cexy`](https://github.com/cexyio/cexy-typescript).

> **Status: 0.x prerelease.** Tool names and outputs may still change.
> Pre-release: `npx -y @cexyio/mcp@next`; `latest` currently points at a pre-release until 1.0.

## Install

It needs Node.js 22 or newer. Nothing to install globally: MCP clients start it with `npx`.

### Claude Code

Public market data only (no key):

```bash
claude mcp add cexy -- npx -y @cexyio/mcp
```

With your account (read-only key):

```bash
claude mcp add cexy \
  -e CEXY_API_KEY=ak_your_key_here \
  -e CEXY_API_SECRET=your_secret_here \
  -- npx -y @cexyio/mcp
```

With trading enabled and guardrails (see [Safety](#safety) first):

```bash
claude mcp add cexy \
  -e CEXY_API_KEY=ak_your_key_here \
  -e CEXY_API_SECRET=your_secret_here \
  -e CEXY_MCP_ENABLE_TRADING=true \
  -e CEXY_MCP_MAX_ORDER_NOTIONAL=100 \
  -e CEXY_MCP_ALLOWED_MARKETS=BTC/USDT,ETH/USDT \
  -- npx -y @cexyio/mcp
```

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "cexy": {
      "command": "npx",
      "args": ["-y", "@cexyio/mcp"],
      "env": {
        "CEXY_API_KEY": "ak_your_key_here",
        "CEXY_API_SECRET": "your_secret_here"
      }
    }
  }
}
```

Leave out the `env` block for public data only. Add `"CEXY_MCP_ENABLE_TRADING": "true"` (and the
guardrails) only if you want the assistant to place orders.

### Other MCP clients

Run `npx -y @cexyio/mcp` as a stdio server and pass the configuration as environment variables.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CEXY_API_KEY` | unset | API key id (`ak_...`). Optional; must be set together with the secret. |
| `CEXY_API_SECRET` | unset | API key secret. Optional; must be set together with the key. |
| `CEXY_BASE_URL` | `https://api.cexy.io` | API base URL. Must be `https://`. |
| `CEXY_ALLOW_INSECURE` | unset | `true` allows an `http://` base URL, and only for `localhost`, `127.0.0.1` or `::1` (local development). |
| `CEXY_MCP_ENABLE_TRADING` | `false` | Exactly `true` registers the trading tools (needs a key with the `trade` scope). Any other value, including `1`, `yes` and `TRUE`, leaves trading off. |
| `CEXY_MCP_MAX_ORDER_NOTIONAL` | unset | Per-order cap, in the market's quote currency (e.g. `100` = 100 USDT on BTC/USDT). |
| `CEXY_MCP_ALLOWED_MARKETS` | unset (all) | Comma-separated markets `place_order` may trade, e.g. `BTC/USDT,ETH/USDT`. |
| `CEXY_MCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr only. |

The server refuses to start when only one of the key and the secret is set, when the base URL
is not `https://` (outside the loopback exception above), or when `CEXY_MCP_ENABLE_TRADING` has an
unrecognised value such as `tru`. It never echoes
either of them in tool output, errors or logs.

## Tools

Every read tool is annotated `readOnlyHint: true` and `openWorldHint: true`. The trading tools
are annotated `destructiveHint: true`.

**Public** (always available, no key):

| Tool | What it returns |
|---|---|
| `get_server_status` | Server time and clock skew, maintenance state, page sizes, candle intervals, and this server's own settings |
| `list_markets` | Markets with a compact ticker; filters `quote`, `status`, `search`; `limit` (default 20, max 50), `offset` |
| `get_market` | One market's trading rules (tick/lot size, minimums, order types) and 24h ticker |
| `get_ticker` | Compact 24h ticker for one market |
| `get_orderbook` | Order-book snapshot, `depth` 1-50 (default 10) |
| `get_recent_trades` | Recent public trades; `limit`, `cursor`, `direction` |
| `get_candles` | OHLCV rows; `interval`, `from`/`to` (ISO 8601), `limit` (default 50, max 200) |
| `list_assets` | Assets and, per network, deposit/withdrawal status, maintenance, minimums and fees |
| `get_fees` | Maker/taker fee tiers |

**Read key** (registered only when `CEXY_API_KEY` and `CEXY_API_SECRET` are set; the key needs the `read` scope):

| Tool | What it returns |
|---|---|
| `get_balances` | Balances per asset (with `held_incoming`, already part of `locked`); zero balances hidden unless `include_zero: true` |
| `get_sub_account_balances` | Balances of one of your sub-accounts, by `id` (parent account only; `NOT_FOUND` for any other id) |
| `list_open_orders` | Your open orders; optional `symbol`, `status` |
| `get_order` | One order, by `order_id` or `client_order_id` |
| `get_order_history` | Your orders, paged with `cursor`, `limit`, `direction` |
| `get_my_trades` | Your fills, paged |
| `list_deposits` | Your deposit history, paged (read only) |
| `list_withdrawals` | Your withdrawal history, paged (read only) |
| `get_ledger` | Every balance change, paged |

**Trade** (registered only when `CEXY_MCP_ENABLE_TRADING=true` and a key is set; the key needs the `trade` scope):

| Tool | What it does |
|---|---|
| `place_order` | Places a **real** order. Always sends a `client_order_id` (a UUID, generated if not given) and returns the resulting order state and fills. Never re-sends. If the outcome is ambiguous (network error, timeout, 5xx), the error is `retryable: false`, carries the `client_order_id`, and tells the assistant to call `get_order` with it before doing anything else. |
| `cancel_order` | Cancels one order, by `order_id` or `client_order_id` |
| `cancel_all_orders` | Cancels your open orders in **one** market. `symbol` is required; there is no account-wide cancel. |

**Never available:** withdrawals, transfers (including sub-account transfers), any other sub-account action
(reading a sub-account's balances is the only one), liquidity-pool
join/exit, deposit-address lookup (the API creates an address on first use), API-key management,
login/2FA, exports and any admin function. A test asserts that none of these ever appear.

### Output

Results are compact JSON (`structuredContent`), plus a text block with a one-line summary followed
by the same JSON, for clients that read only text. Amounts are decimal strings (never floats) and
timestamps are ISO 8601. Lists default to 10-50 items; paged tools return `next_cursor` (or
`next_offset`) to fetch more. No result is larger than about 20 KB: longer lists are trimmed and
marked `truncated: true` with a note.

Errors come back as MCP tool errors with a structured body:

```json
{ "error": { "code": "FORBIDDEN", "message": "...", "retryable": false, "request_id": "..." } }
```

`code` is the API error code (e.g. `INSUFFICIENT_FUNDS`, `RATE_LIMITED`), or one of this server's:
`GUARDRAIL_REJECTED`, `INVALID_INPUT`, `TIMEOUT`, `CONNECTION_ERROR`, `ORDER_STATE_UNKNOWN`,
`INTERNAL_ERROR`. Quote the `request_id` when you contact support.

## Safety

- **Read-only by default.** Without `CEXY_MCP_ENABLE_TRADING=true` the trading tools are not
  registered at all, so the assistant cannot see or call them.
- **Use a read-only key** unless you want trading. Create the key with only the `read` scope and
  restrict it to your IP address with `allowed_ips`.
- **Trading is opt-in, with caps.** If you enable it, also set `CEXY_MCP_MAX_ORDER_NOTIONAL` and
  `CEXY_MCP_ALLOWED_MARKETS`. With a notional cap set, `place_order` refuses any order whose value
  it cannot bound: limit buys use price x quantity, limit sells use the higher of the price and the
  best bid, market buys are priced by walking the current asks (or use `quote_quantity`), market
  sells use the best bid, and stop orders whose fill price depends on a future book are refused.
  The check is made against the book at the time of the call; fast markets can move.
- **Orders are real** and irreversible once filled. Ask your assistant to confirm each order with
  you; most MCP clients also ask for approval before calling a tool marked destructive.
- **No withdrawal tools exist**, and CEXY API keys cannot withdraw or transfer funds anyway.
- The server runs locally over stdio, opens no port and sends no telemetry.

## Rate limits

The exchange allows about 120 requests per minute per IP without a key, and about 600 per minute
per API key. The SDK underneath throttles itself below that (100/min without a key, 300/min with
one) and adapts to the server's `X-RateLimit-*` headers. Most tools make one request;
`get_server_status` and `list_assets` make two, and `place_order` with a notional cap may read the
order book first. A `RATE_LIMITED` error includes `retry_after_ms`.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test
npm run build            # dist/cli.js (the bin) and dist/index.js
npm run test:live        # opt-in: a few unauthenticated GETs to api.cexy.io
```

The server depends on the published SDK, pinned to an exact version (`@cexyio/cexy` `0.1.0-dev.8`).

## Security

See [SECURITY.md](SECURITY.md). Never paste real API keys or secrets into issues.

## License

MIT, see [LICENSE](LICENSE).
