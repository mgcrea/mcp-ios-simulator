#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { defaultConfigPath, loadConfig } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.IOS_SIMULATOR_DEBUG) console.error("[ios-simulator-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[ios-simulator-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[ios-simulator-mcp]", ...args),
};

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const configPath = defaultConfigPath();
  const config = loadConfig(process.env, configPath);
  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The banner is not decoration. It prints before anything can fail, and it is
  // the only place the resolved capability state is visible. Here the *unusual*
  // state is writes being off — they default on, because a simulator is
  // disposable — so `writes=DISABLED` is the one worth shouting: it is what
  // explains a tool being missing from tools/list.
  stderrLogger.warn(
    `ios-simulator-mcp connected (simulator=${config.simulatorId ?? "auto"}, ` +
      `wda=${config.wdaUrl ?? `127.0.0.1:${config.wdaPort}`}, ` +
      `writes=${config.allowWrites ? "enabled" : "DISABLED"})`,
  );
  if (config.allowWrites && config.launchArgs.length > 0) {
    stderrLogger.warn(`default launch arguments: ${config.launchArgs.join(" ")}`);
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[ios-simulator-mcp] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
