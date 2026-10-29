import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { IosError, START_RUNNER_SCRIPT_REMEDY } from "#/client/errors";
import type { SimulatorClient } from "#/client/simulator";
import { deviceArg, wrap } from "#/tools/util";

/** Injected in tests so no xcodebuild is ever started by the suite. */
export type SpawnRunner = (
  command: string,
  args: string[],
  opts: { env: Record<string, string>; logPath: string },
) => Promise<number | undefined>;

const defaultSpawnRunner: SpawnRunner = async (command, args, { env, logPath }) => {
  await mkdir(dirname(logPath), { recursive: true });
  const log = await open(logPath, "a");
  const child = spawn(command, args, {
    // Detached, because the XCTest session *is* the HTTP server: it has to
    // outlive this MCP server, or the runner dies with the conversation.
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, ...env },
  });
  child.unref();
  await log.close();
  return child.pid;
};

const scriptPath = (): string => {
  // Beside the built module in dist/, or beside src/ in a checkout.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "scripts", "wda.sh"),
    join(here, "..", "..", "scripts", "wda.sh"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new IosError("Could not find `scripts/wda.sh` beside this module.");
};

/**
 * Whether `wda.sh run` has anything to run: the same directory and glob it
 * looks in. Without a build it exits with "no build found" into a log nobody
 * reads, while a detached spawn has already been reported as started.
 */
const runnerBuilt = async (): Promise<{ built: boolean; products: string }> => {
  const wdaDir =
    process.env["WDA_DIR"] || join(homedir(), ".cache", "mcp-ios-simulator", "WebDriverAgent");
  const products = join(wdaDir, ".build", "Build", "Products");
  const entries = await readdir(products).catch(() => [] as string[]);
  const built = entries.some(
    (name) =>
      name.startsWith("WebDriverAgentRunner_iphonesimulator") && name.endsWith(".xctestrun"),
  );
  return { built, products };
};

export const registerRunnerTools = (
  server: McpServer,
  client: SimulatorClient,
  outputDir: string,
  spawnRunner: SpawnRunner = defaultSpawnRunner,
): void => {
  server.registerTool(
    "ios_simulator_restart_wda",
    {
      title: "iOS Simulator: Restart WebDriverAgent",
      description:
        "Start the WebDriverAgent runner, or restart it after it has died. Only the UI tree and " +
        "the input tools need it — screenshots and everything simctl does keep working without " +
        "it. The runner is started detached so it outlives this conversation, and its output goes " +
        "to a log file rather than to you. It does not wait: give it fifteen seconds or so, then " +
        "check ios_simulator_diagnostics.",
      inputSchema: z.object({
        device: deviceArg,
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe(
            "Port to bind, passed to the runner as USE_PORT. Defaults to IOS_SIMULATOR_WDA_PORT. " +
              "Two simulators need two ports: they share this Mac's loopback, and a runner with " +
              "no USE_PORT scans 8100-8199 and silently takes the next free one.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, port }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        const usePort = port ?? client.wdaPort;
        const { built, products } = await runnerBuilt();
        if (!built) {
          throw new IosError(
            `No WebDriverAgent build in ${products}, so there is nothing to start.`,
            {
              remedy:
                "Build it once with `scripts/wda.sh setup` (or `npx -p @mgcrea/mcp-ios-simulator " +
                "ios-simulator-wda setup` from an npm install), then call ios_simulator_restart_wda again.",
            },
          );
        }
        const logPath = join(outputDir, "wda.log");
        const pid = await spawnRunner("/bin/bash", [scriptPath(), "run"], {
          // `node` cannot be assumed on PATH: a host that embeds its own
          // runtime (Bastion runs this server off its bundled node) leaves
          // nothing called `node` to find, and `wda.sh run` dies resolving the
          // simulator while this tool reports a pid. Same fix as the device
          // server's runner.
          env: {
            IOS_SIMULATOR_ID: target.id,
            IOS_SIMULATOR_WDA_PORT: String(usePort),
            USE_PORT: String(usePort),
            NODE: process.execPath,
            PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
          },
          logPath,
        });
        if (pid === undefined) {
          throw new IosError("Could not start the runner — the process had no pid.", {
            remedy: START_RUNNER_SCRIPT_REMEDY,
          });
        }
        return {
          started: true,
          pid,
          port: usePort,
          udid: target.id,
          logPath,
          note: "Give it ~15s, then check ios_simulator_diagnostics for `wda.reachable`.",
        };
      }),
  );
};
