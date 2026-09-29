# Changelog

All notable changes to `@cexyio/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver (0.x: the
tool surface may still change).

## [Unreleased]

## [0.1.0-dev.6] (2026-09-29)

### Changed
- Depends on `@cexyio/cexy` `0.1.0-dev.7` (exact pin): path ids `.` and `..` are rejected before any
  request, and 408 is no longer retried by default.
- `get_balances` rows now include `held_incoming` (incoming internal transfers still held: `transfer_id`,
  `amount`, `available_at`; `[]` when none). Their sum is already part of `locked`; the description and the
  summary say so, so a client does not count it twice.

## [0.1.0-dev.5] (2026-09-28)

### Changed
- Depends on `@cexyio/cexy` `0.1.0-dev.6` (exact pin): API release H-1 types (`PRICE_UNAVAILABLE`,
  withdrawal status `reverted`, typed ledger references), and the SDK's `until_done` loop now counts a
  rate-limiter wait against its 2-minute budget.
- `cancel_all_orders` description: it also cancels stop orders that have not triggered yet
  (`pending_trigger`), as the exchange does since H-1.

### Changed (CI)
- New CI job `consumer`, with the same check in the publish build job, run on the exact tarball that
  gets published. It installs the packed tarball into an empty project without dev dependencies,
  starts the installed CLI over stdio with an empty environment, and checks that `initialize`
  reports the package version and that `tools/list` returns the 9 read-only tools and no trading
  tools. The script is `ci/consumer/check.mjs`; it is not part of the package.

## [0.1.0-dev.4]

### Fixed
- Depends on `@cexyio/cexy` `0.1.0-dev.5` (exact pin): server-controlled waits are bounded (a Retry-After
  above 120 s fails fast instead of waiting), and the `until_done` loop sends one request per round and
  never waits past its 2-minute budget.

### Changed
- `cancel_all_orders` description: with `until_done` one call can take up to about 2 minutes.
- `cancel_all_orders(until_done)`: `last_error_code` when the loop stopped early; when a non-retryable error
  stops it, the error result carries `partial` (what was already cancelled).
- Orders no longer carry an `Idempotency-Key` (SDK policy: pool join/exit only; the server ignored it on
  orders, whose safety rests on `client_order_id`).

## [0.1.0-dev.3]

### Changed
- Depends on `@cexyio/cexy` `0.1.0-dev.4` (exact pin), which supports cancel-all v2.
- `cancel_all_orders` (trading tools only) reports `already_closed` (orders that closed on their own: not an
  error), `failures` (order id, code, message) and `has_more`. When more orders remain, the summary says so.

### Added
- `cancel_all_orders` accepts `until_done: true`, which repeats the call while orders remain or are still being
  placed (up to 20 rounds or 2 minutes) and returns the merged result with `rounds` and `stopped`. The default
  stays a single call, and `symbol` stays required: the server never cancels across all markets.

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
