#!/usr/bin/env node
// Installs the packed @cexyio/mcp tarball into an empty project, exactly as a user gets it (no dev
// dependencies, no repository files), then starts the installed CLI over stdio twice and checks
// initialize and tools/list:
//   1. with an empty environment (the read-only default): exactly the public tools;
//   2. with a dummy API key and secret: the public and read-key tools, still no trading tool.
// No tool is called. A preload in the CLI process makes any network attempt (fetch, net, tls) fail
// the check, so both runs prove that listing tools needs no network, and the dummy key is never sent.
// Every listed name is also checked against the package's own forbidden-name guard.
//
//   node ci/consumer/check.mjs <path/to/cexyio-mcp-X.tgz>
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PUBLIC_TOOLS = [
  "get_candles", "get_fees", "get_market", "get_orderbook", "get_recent_trades", "get_server_status",
  "get_ticker", "list_assets", "list_markets",
];
const READ_KEY_TOOLS = [
  "get_balances", "get_ledger", "get_my_trades", "get_order", "get_order_history", "get_sub_account_balances",
  "list_deposits", "list_open_orders", "list_withdrawals",
];
const TRADING_TOOLS = ["place_order", "cancel_order", "cancel_all_orders"];
const DUMMY_KEY = { CEXY_API_KEY: "ak_consumer_check_dummy", CEXY_API_SECRET: "consumer_check_dummy_secret_0123456789" };

// Loaded with --import into the CLI: any network attempt prints a marker and exits the process.
const NO_NETWORK = `
import net from "node:net";
import tls from "node:tls";
const trap = (what) => () => { process.stderr.write("NETWORK_ATTEMPT " + what + "\\n"); process.exit(97); };
globalThis.fetch = trap("fetch");
net.Socket.prototype.connect = trap("net.connect");
tls.connect = trap("tls.connect");
`;

function fail(msg) {
  console.error(`consumer check FAILED: ${msg}`);
  process.exit(1);
}

const tgz = process.argv[2] ? resolve(process.argv[2]) : fail("usage: check.mjs <tarball>");
const expectedVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const dir = mkdtempSync(join(tmpdir(), "cexy-mcp-consumer-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }));
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", tgz], { cwd: dir, stdio: "inherit" });

writeFileSync(join(dir, "no-network.mjs"), NO_NETWORK);
const cli = join(dir, "node_modules", "@cexyio", "mcp", "dist", "cli.js");
const { isForbiddenToolName } = await import(pathToFileURL(join(dir, "node_modules", "@cexyio", "mcp", "dist", "index.js")).href);

/** Starts the installed CLI with `env`, and resolves with the sorted tool names from tools/list. */
function listTools(label, env) {
  return new Promise((resolveNames) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(dir, "no-network.mjs")).href, cli], {
      cwd: dir, env, stdio: ["pipe", "pipe", "inherit"],
    });
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    const timer = setTimeout(() => { child.kill(); fail(`${label}: no answer within 20 s`); }, 20_000);
    let done = false;
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.error) fail(`${label}: server error: ${JSON.stringify(msg.error)}`);
        if (msg.id === 1) {
          const got = msg.result?.serverInfo?.version;
          if (got !== expectedVersion) fail(`${label}: serverInfo.version ${got} != package.json ${expectedVersion}`);
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          done = true;
          clearTimeout(timer);
          child.kill();
          resolveNames((msg.result?.tools ?? []).map((t) => t.name).sort());
        }
      }
    });
    child.on("exit", (code) => {
      if (code === 97) fail(`${label}: the CLI tried to use the network`);
      if (!done && code !== null && code !== 0) fail(`${label}: CLI exited with ${code}`);
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "consumer-check", version: "1" } } });
  });
}

function expectTools(label, names, expected) {
  const trading = names.filter((n) => TRADING_TOOLS.includes(n));
  if (trading.length) fail(`${label}: trading tools exposed: ${trading.join(", ")}`);
  const forbidden = names.filter((n) => isForbiddenToolName(n));
  if (forbidden.length) fail(`${label}: forbidden tools exposed: ${forbidden.join(", ")}`);
  const want = [...expected].sort();
  if (JSON.stringify(names) !== JSON.stringify(want)) fail(`${label}: tools ${names.join(", ")} != expected ${want.join(", ")}`);
}

const keyless = await listTools("no key", {});
expectTools("no key", keyless, PUBLIC_TOOLS);
const keyed = await listTools("dummy key", DUMMY_KEY);
expectTools("dummy key", keyed, [...PUBLIC_TOOLS, ...READ_KEY_TOOLS]);
console.log(
  `consumer check ok: @cexyio/mcp ${expectedVersion} installed from the tarball; ${keyless.length} tools without a key, ` +
  `${keyed.length} with a read key (no trading tools, no forbidden tools, no network use)`,
);
process.exit(0);
