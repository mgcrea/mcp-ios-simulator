import type { ExecImpl, Logger } from "@mgcrea/mcp-ios-core";
import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { SimulatorClient } from "#/client/simulator";
import type { Config } from "#/config";
import { registerTools } from "#/tools/index";
import type { SpawnRunner } from "#/tools/runner";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

export type CreateServerOptions = {
  config: Config;
  /** Override the process boundary (tests): `xcrun`, `plutil` and `sips` never run. */
  exec?: ExecImpl;
  /** Override HTTP to WebDriverAgent (tests). */
  fetch?: typeof fetch;
  /** Override starting the runner (tests): no process is spawned. */
  spawnRunner?: SpawnRunner;
  logger?: Logger;
};

export type CreatedServer = {
  server: McpServer;
  client: SimulatorClient;
};

/**
 * A pure factory. The injectable seams — `exec`, `fetch` and `spawnRunner` —
 * are the whole reason the test suite can drive real tools through the real SDK
 * with no simulator, no Xcode, no WebDriverAgent and no process left running.
 * Nothing below `config.ts` reads `process.env`.
 */
export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const client = new SimulatorClient({
    xcrunPath: config.xcrunPath,
    sipsPath: config.sipsPath,
    plutilPath: config.plutilPath,
    openPath: config.openPath,
    execTimeoutMs: config.execTimeoutMs,
    wdaTimeoutMs: config.wdaTimeoutMs,
    wdaPort: config.wdaPort,
    allowWrites: config.allowWrites,
    ...(config.wdaUrl ? { wdaUrl: config.wdaUrl } : {}),
    ...(config.simulatorId ? { defaultSimulatorId: config.simulatorId } : {}),
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, client, { config, allowWrites: config.allowWrites }, opts.spawnRunner);

  return { server, client };
};
