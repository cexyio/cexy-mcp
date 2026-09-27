# Changelog

All notable changes to `@cexyio/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver (0.x: the
tool surface may still change).

## [Unreleased]

## [0.1.0-dev.2]

### Security
- Depends on `@cexyio/cexy` `0.1.0-dev.3` (exact pin), which **never follows HTTP redirects**.
  With earlier SDK versions, a redirect answer re-sent the API key and secret to the redirect
  target (also over plain `http://`), and a 307/308 could re-post an order. A redirect is now
  reported as an error with code `UNEXPECTED_REDIRECT`. Upgrade from 0.1.0-dev.1.

### Changed
- **Breaking: requires Node.js 22 or newer** (`engines` `>=22`). Node 20 reached end-of-life in April 2026.
  CI tests Node 22, 24 and 26.
- Build target `node22` (was `node20`).

## [0.1.0-dev.1]

First release published by CI through npm trusted publishing, with provenance.

### Changed
- Depends on `@cexyio/cexy` `0.1.0-dev.2` (exact pin), which adds `JurisdictionBlockedError`
  (HTTP 451 errors are reported with code `JURISDICTION_BLOCKED`).
- Publish workflow: one shared publish command; the build job dry-runs it from the same directory
  before the environment approval.

## [0.1.0-dev.0] (2026-09-27)

First published pre-release (manual bootstrap upload of the CI-built tarball; no provenance).

- Requires Node.js 20 or newer (Node 18 is end-of-life and lacks the global `crypto.randomUUID`).

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

### Changed
- Depends on the published SDK `@cexyio/cexy` `0.1.0-dev.0` (exact pin) instead of a sibling
  checkout; CI no longer checks out and builds `cexy-typescript`.
