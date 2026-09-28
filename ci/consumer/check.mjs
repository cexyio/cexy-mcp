#!/usr/bin/env node
// Installs the packed @cexyio/mcp tarball into an empty project, exactly as a user gets it (no dev
// dependencies, no repository files), then starts the installed CLI over stdio with an empty
// environment (the read-only default) and checks initialize and tools/list. No tool is called, so
// no network is needed beyond the npm install itself.
//
//   node ci/consumer/check.mjs <path/to/cexyio-mcp-X.tgz>
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const READ_ONLY_TOOLS = [
  "get_candles", "get_fees", "get_market", "get_orderbook", "get_recent_trades", "get_server_status",
  "get_ticker", "list_assets", "list_markets",
];
const TRADING_TOOLS = ["place_order", "cancel_order", "cancel_all_orders"];

function fail(msg) {
  console.error(`consumer check FAILED: ${msg}`);
  process.exit(1);
}

const tgz = process.argv[2] ? resolve(process.argv[2]) : fail("usage: check.mjs <tarball>");
const expectedVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const dir = mkdtempSync(join(tmpdir(), "cexy-mcp-consumer-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }));
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", tgz], { cwd: dir, stdio: "inherit" });

const cli = join(dir, "node_modules", "@cexyio", "mcp", "dist", "cli.js");
const child = spawn(process.execPath, [cli], { cwd: dir, env: {}, stdio: ["pipe", "pipe", "inherit"] });
const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const timer = setTimeout(() => { child.kill(); fail("no answer within 20 s"); }, 20_000);

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.error) fail(`server error: ${JSON.stringify(msg.error)}`);
    if (msg.id === 1) {
      const got = msg.result?.serverInfo?.version;
      if (got !== expectedVersion) fail(`serverInfo.version ${got} != package.json ${expectedVersion}`);
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list" });
    } else if (msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name).sort();
      const trading = names.filter((n) => TRADING_TOOLS.includes(n));
      if (trading.length) fail(`trading tools exposed by default: ${trading.join(", ")}`);
      if (JSON.stringify(names) !== JSON.stringify(READ_ONLY_TOOLS)) {
        fail(`tools ${names.join(", ")} != expected ${READ_ONLY_TOOLS.join(", ")}`);
      }
      clearTimeout(timer);
      child.kill();
      console.log(`consumer check ok: @cexyio/mcp ${expectedVersion} installed from the tarball; ${names.length} read-only tools, no trading tools`);
      process.exit(0);
    }
  }
});
child.on("exit", (code) => { if (code !== null && code !== 0) fail(`CLI exited with ${code}`); });
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "consumer-check", version: "1" } } });
