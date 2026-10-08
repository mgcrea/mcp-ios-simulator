import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { IosError } from "#/client/errors";
import { summarizeApps, type SimulatorSummary } from "#/client/shape";
import type { SimulatorClient } from "#/client/simulator";
import { bundleIdArg, deviceArg, wrap } from "#/tools/util";

/** `io.mgcrea.Canopy: 12345` is the whole of what `simctl launch` prints. */
const parsePid = (output: string): number | undefined => {
  const pid = /:\s*(\d+)\s*$/.exec(output.trim())?.[1];
  return pid ? Number(pid) : undefined;
};

const NOT_FOUND_WARNING =
  "The log file is neither where it was asked for nor under the simulator's data directory. " +
  "Set IOS_SIMULATOR_OUTPUT_DIR to a directory under your home folder, which the simulator " +
  "writes to as-is.";

/**
 * Find the redirect, giving the simulator a moment to create it. `simctl
 * launch` returns once the app is spawned, and the file is opened as part of
 * that spawn, so the first look nearly always finds it; the retries only cover
 * a slow spawn rather than a known race.
 */
const locate = async (
  client: SimulatorClient,
  target: SimulatorSummary,
  path: string,
): Promise<{ path: string; found: boolean }> => {
  for (let attempt = 0; ; attempt += 1) {
    const found = await client.locateRedirect(target, path);
    if (found.found || attempt >= 4) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

export const registerListAppsTool = (server: McpServer, client: SimulatorClient): void => {
  server.registerTool(
    "ios_simulator_list_apps",
    {
      title: "iOS Simulator: List Apps",
      description:
        "List the apps installed on a simulator, with the bundle id every other tool takes. " +
        "Defaults to your own apps: a stock simulator carries about thirty, and twenty-five of " +
        "them are Apple's. Each entry also carries `dataContainer` — an ordinary path on this " +
        "Mac, so an app's database or logs can be read directly with no copy step.",
      inputSchema: z.object({
        device: deviceArg,
        include_all: z
          .boolean()
          .default(false)
          .describe("Include Apple's built-in apps as well. Off by default; the list is long."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, include_all }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        const apps = await client.simctl.listApps(target.id);
        return { apps: summarizeApps(apps, { includeAll: include_all }) };
      }),
  );
};

export const registerAppTools = (
  server: McpServer,
  client: SimulatorClient,
  launchArgs: string[],
  outputDir: string,
): void => {
  server.registerTool(
    "ios_simulator_install",
    {
      title: "iOS Simulator: Install",
      description:
        "Install a build. The path must be a `.app` **bundle directory** built for the simulator " +
        '— not an `.ipa`, and not a device build, both of which fail with a bare "No such file or ' +
        'directory" that reads like a typo. Installing over an existing copy replaces it and ' +
        "keeps its data.",
      inputSchema: z.object({
        device: deviceArg,
        path: z
          .string()
          .describe(
            "Absolute path to the .app bundle, e.g. " +
              "~/Library/Developer/Xcode/DerivedData/…/Build/Products/Debug-iphonesimulator/Foo.app",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device, path }) =>
      wrap(async () => {
        if (!path.startsWith("/")) {
          throw new IosError(`path must be absolute, got "${path}".`, {
            remedy: "Pass the full path to the .app bundle.",
          });
        }
        const target = client.requireBooted(await client.resolveTarget(device));
        await client.simctl.install(target.id, path);
        return { installed: path, udid: target.id };
      }),
  );

  server.registerTool(
    "ios_simulator_launch",
    {
      title: "iOS Simulator: Launch",
      description:
        "Launch an installed app. Pass `arguments` to put it into a fixture or demo mode — that " +
        "is what IOS_SIMULATOR_LAUNCH_ARGS sets as the default for every launch that does not " +
        "override it. Standard output and error are captured to files under the output directory, " +
        "so an app that dies on launch leaves something readable behind. Pass `capture_logs: " +
        "true` to also get its Logger/os_log output, in one file read with " +
        "ios_simulator_read_logs.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: bundleIdArg,
        arguments: z
          .array(z.string())
          .optional()
          .describe(
            'Launch arguments, e.g. ["-DemoMode", "YES"]. Overrides IOS_SIMULATOR_LAUNCH_ARGS ' +
              "rather than adding to it.",
          ),
        terminate_first: z
          .boolean()
          .default(true)
          .describe(
            "Replace a running copy rather than attaching to it. On by default so a launch means " +
              "a fresh process and a predictable first screen.",
          ),
        capture_logs: z
          .boolean()
          .default(false)
          .describe(
            "Write stdout, stderr and every Logger/os_log message to one fresh file, for " +
              "ios_simulator_read_logs. Sets OS_ACTIVITY_DT_MODE=YES in the app's environment, " +
              "which is what Xcode sets to mirror unified logging onto stderr; without it an " +
              "app's Logger output reaches no file at all.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, bundle_id, arguments: args, terminate_first, capture_logs }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        const effective = args ?? launchArgs;
        const said = {
          ...(effective.length > 0 ? { arguments: effective } : {}),
          ...(args === undefined && launchArgs.length > 0
            ? { argumentsFrom: "IOS_SIMULATOR_LAUNCH_ARGS" }
            : {}),
        };

        if (capture_logs) {
          // One file for both streams, fresh per launch: the redirect appends,
          // so reusing a path would hand the reader the previous run's lines
          // first. Interleaving in one file is what lets one cursor follow
          // print(), stderr and Logger in the order they happened.
          const stamp = new Date().toISOString().replaceAll(":", "-");
          const requested = join(outputDir, "logs", `${bundle_id}-${stamp}.log`);
          const output = await client.simctl.launch(target.id, bundle_id, {
            args: effective,
            terminateExisting: terminate_first,
            stdout: requested,
            stderr: requested,
            env: { OS_ACTIVITY_DT_MODE: "YES" },
          });
          const pid = parsePid(output);
          const log = await locate(client, target, requested);
          client.captures.record({
            udid: target.id,
            simulatorName: target.name,
            bundleId: bundle_id,
            path: log.path,
            pid,
            startedAt: new Date().toISOString(),
          });
          return {
            launched: bundle_id,
            ...(pid !== undefined ? { pid } : {}),
            ...said,
            capturingLogs: true,
            log: log.path,
            ...(log.found ? {} : { warning: NOT_FOUND_WARNING }),
          };
        }

        const stdout = join(outputDir, `${bundle_id}.out.log`);
        const stderr = join(outputDir, `${bundle_id}.err.log`);
        const output = await client.simctl.launch(target.id, bundle_id, {
          args: effective,
          terminateExisting: terminate_first,
          stdout,
          stderr,
        });
        const pid = parsePid(output);
        const [out, err] = await Promise.all([
          locate(client, target, stdout),
          locate(client, target, stderr),
        ]);
        return {
          launched: bundle_id,
          ...(pid !== undefined ? { pid } : {}),
          ...said,
          // Appended to across launches, unlike a `capture_logs` file.
          logs: { stdout: out.path, stderr: err.path },
          ...(out.found && err.found ? {} : { warning: NOT_FOUND_WARNING }),
        };
      }),
  );

  server.registerTool(
    "ios_simulator_uninstall",
    {
      title: "iOS Simulator: Uninstall",
      description:
        "Remove an app from the simulator, **with its data container** — documents, databases " +
        "and preferences all go, and nothing brings them back. To get back to a cold start while " +
        "keeping the data, use ios_simulator_terminate. To test a genuine first launch of one " +
        "app, this is narrower than ios_simulator_erase, which wipes every app on the simulator. " +
        "Uninstalling an app that is not installed also succeeds, so success does not prove it " +
        "was there.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: bundleIdArg,
        confirm: z
          .literal(true)
          .describe("Must be true. Explicit acknowledgement that the app's data is deleted."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ device, bundle_id }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        await client.simctl.uninstall(target.id, bundle_id);
        return { uninstalled: bundle_id, udid: target.id };
      }),
  );

  server.registerTool(
    "ios_simulator_terminate",
    {
      title: "iOS Simulator: Terminate",
      description:
        "Kill a running app. The app is not uninstalled and its data is untouched — this is how " +
        "you get back to a cold start without erasing anything.",
      inputSchema: z.object({ device: deviceArg, bundle_id: bundleIdArg }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device, bundle_id }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        await client.simctl.terminate(target.id, bundle_id);
        return { terminated: bundle_id };
      }),
  );

  server.registerTool(
    "ios_simulator_open_url",
    {
      title: "iOS Simulator: Open URL",
      description:
        "Open a URL on the simulator, which is how you exercise a deep link or a universal link " +
        "without finding a way to tap one. An `https://` link opens in Safari unless the app " +
        "claims it; a custom scheme goes straight to whichever app registered it.",
      inputSchema: z.object({
        device: deviceArg,
        url: z.url().describe('e.g. "myapp://garden/42" or "https://example.com/garden/42".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, url }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        await client.simctl.openUrl(target.id, url);
        return { opened: url };
      }),
  );
};
