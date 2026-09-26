# Changelog

All notable changes to `@cexyio/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver (0.x: the
tool surface may still change).

## [Unreleased]

### Added
- MCP server over stdio (`npx -y @cexyio/mcp`), built on `@cexyio/cexy` and the official
  `@modelcontextprotocol/sdk`.
- Public tools: `get_server_status`, `list_markets`, `get_market`, `get_ticker`, `get_orderbook`,
  `get_recent_trades`, `get_candles`, `list_assets`, `get_fees`.
- Read-key tools (registered only with `CEXY_API_KEY` + `CEXY_API_SECRET`): `get_balances`,
  `list_open_orders`, `get_order`, `get_order_history`, `get_my_trades`, `list_deposits`,
  `list_withdrawals`, `get_ledger`.
- Opt-in trading tools (`CEXY_MCP_ENABLE_TRADING=true` and a key): `place_order`, `cancel_order`,
  `cancel_all_orders` (symbol required).
- Guardrails: `CEXY_MCP_ALLOWED_MARKETS` and `CEXY_MCP_MAX_ORDER_NOTIONAL`.
- Compact results (decimal strings, ISO timestamps, cursor passthrough), a ~20 KB result cap,
  structured tool errors, and redaction of credentials in output and stderr logs.

### Security
- `CEXY_BASE_URL` must be `https://`; `http://` is accepted only for loopback hosts with
  `CEXY_ALLOW_INSECURE=true`.
- Trading is enabled only by the exact value `CEXY_MCP_ENABLE_TRADING=true`.
- An ambiguous `place_order` failure (network error, timeout, 5xx) is reported as not retryable,
  with the `client_order_id` and an instruction to check `get_order` before placing again.

### Notes
- The prerelease depends on the SDK via `file:../cexy-typescript`. The first published release
  pins the published `@cexyio/cexy` version instead.

## [0.1.0-dev.0]

- Local prototype. Not published.
