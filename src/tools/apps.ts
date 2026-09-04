import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { IosError } from "#/client/errors";
import { summarizeApps } from "#/client/shape";
import type { SimulatorClient } from "#/client/simulator";
import { bundleIdArg, deviceArg, wrap } from "#/tools/util";

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
        "so an app that dies on launch leaves something readable behind.",
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
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, bundle_id, arguments: args, terminate_first }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        const effective = args ?? launchArgs;
        const stdout = `${outputDir}/${bundle_id}.out.log`;
        const stderr = `${outputDir}/${bundle_id}.err.log`;
        const output = await client.simctl.launch(target.id, bundle_id, {
          args: effective,
          terminateExisting: terminate_first,
          stdout,
          stderr,
        });
        const pid = /:\s*(\d+)\s*$/.exec(output.trim())?.[1];
        return {
          launched: bundle_id,
          ...(pid ? { pid: Number(pid) } : {}),
          ...(effective.length > 0 ? { arguments: effective } : {}),
          ...(args === undefined && launchArgs.length > 0
            ? { argumentsFrom: "IOS_SIMULATOR_LAUNCH_ARGS" }
            : {}),
          logs: { stdout, stderr },
        };
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
