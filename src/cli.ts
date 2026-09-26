import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpConfigError, loadConfig } from "./config.js";
import { Redactor, createLogger, parseLogLevel } from "./redact.js";
import { createServer } from "./server.js";

/** Entry point for `npx -y @cexyio/mcp`: stdio transport only, no network listener. */
async function main(): Promise<void> {
  const env = process.env;
  const earlyRedactor = new Redactor([env.CEXY_API_KEY, env.CEXY_API_SECRET]);
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    const msg = err instanceof McpConfigError ? err.message : "invalid configuration";
    process.stderr.write(earlyRedactor.redact(`[cexy-mcp] configuration error: ${msg}`) + "\n");
    process.exit(1);
  }
  const redactor = new Redactor([config.apiKey, config.apiSecret]);
  const logger = createLogger(redactor, { level: parseLogLevel(env.CEXY_MCP_LOG_LEVEL) });
  const { server } = createServer({ config, logger });

  const transport = new StdioServerTransport();
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const r = new Redactor([process.env.CEXY_API_KEY, process.env.CEXY_API_SECRET]);
  process.stderr.write(r.redact(`[cexy-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`) + "\n");
  process.exit(1);
});
