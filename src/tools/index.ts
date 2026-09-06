import { registerInputTools, registerScreenTools } from "@mgcrea/mcp-ios-core";
import type { McpServer } from "@modelcontextprotocol/server";

import { EMPTY_SCREENSHOT_REMEDY } from "#/client/errors";
import type { SimulatorClient } from "#/client/simulator";
import type { Config } from "#/config";
import { registerAppTools, registerListAppsTool } from "#/tools/apps";
import { registerDiagnosticsTools } from "#/tools/diagnostics";
import { registerEnvironmentTools } from "#/tools/environment";
import { registerLifecycleTools, registerListTool } from "#/tools/lifecycle";
import { registerRunnerTools, type SpawnRunner } from "#/tools/runner";
import { SIMULATOR_NAMING } from "#/tools/util";

export type ToolContext = {
  config: Config;
  /** On by default here — see IOS_SIMULATOR_ALLOW_WRITES. */
  allowWrites: boolean;
};

/**
 * All capability decisions in one place, so "why can't I call that" is answered
 * by one file.
 *
 * The split is observe versus drive, exactly as in the device server. What
 * differs is the **default**: writes are on. The convention that keeps the rest
 * of the fleet read-only exists because a mutating tool acts on someone's real
 * account or someone's real phone, and a simulator is neither — it holds no
 * person's data and `ios_simulator_erase` puts it back to factory in seconds.
 * Turning writes off with IOS_SIMULATOR_ALLOW_WRITES=0 restores the device
 * server's posture, and then the driving tools are *absent* rather than
 * refused, because a refusal still lets a model try, retry and reason about a
 * way around it.
 *
 * The observe half is unusually capable here: `screenshot` goes through simctl,
 * so seeing the screen needs no WebDriverAgent and no setup of any kind. Only
 * `ui_tree` does, and that is a runtime fact reported by
 * ios_simulator_diagnostics rather than a registration decision — the runner
 * can start and stop while this server is connected.
 */
export const registerTools = (
  server: McpServer,
  client: SimulatorClient,
  ctx: ToolContext,
  spawnRunner?: SpawnRunner,
): void => {
  const shared = {
    host: client,
    naming: SIMULATOR_NAMING,
    maxTreeBytes: ctx.config.maxTreeBytes,
    capHint: "raise IOS_SIMULATOR_MAX_TREE_BYTES",
    // `home` is the gesture and works; a simulator has no volume rocker worth
    // pressing, and offering one that does nothing is worse than offering none.
    buttons: ["home"] as [string, ...string[]],
    emptyScreenshotRemedy: EMPTY_SCREENSHOT_REMEDY,
    // An alert is usually a permission prompt, and a simulator is the one place
    // a permission prompt never had to appear. The moment one is on screen is
    // the moment that is worth saying so.
    alertHint:
      "If this is a permission prompt, it can be answered before it ever appears: " +
      'ios_simulator_set_environment {"permission":{"action":"grant","service":"photos",' +
      '"bundle_id":"…"}}. `reset` puts the prompt back for testing the other branch.',
    // Geometry here is a local plist read reported on every screenshot, not a
    // slow round trip worth its own tool as it is on a device.
    includeDisplayInfo: false,
  };

  registerDiagnosticsTools(server, client, ctx);
  registerListTool(server, client);
  registerListAppsTool(server, client);
  registerScreenTools(server, shared);

  if (!ctx.allowWrites) return;

  registerInputTools(server, shared);
  registerLifecycleTools(server, client);
  registerAppTools(server, client, ctx.config.launchArgs, ctx.config.outputDir);
  registerEnvironmentTools(server, client);
  registerRunnerTools(server, client, ctx.config.outputDir, spawnRunner);
};
