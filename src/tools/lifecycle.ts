import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { toListRow } from "#/client/shape";
import type { SimulatorClient } from "#/client/simulator";
import { confirmArg, deviceArg, wrap } from "#/tools/util";

/** Booting is slow and visible; this is how long `power` waits to see it land. */
const BOOT_POLL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const registerListTool = (server: McpServer, client: SimulatorClient): void => {
  server.registerTool(
    "ios_simulator_list",
    {
      title: "iOS Simulator: List",
      description:
        "List the simulators on this machine, with the UDID every other tool takes. Shows the " +
        "usable ones: a typical machine carries thirty-odd simulators and a good fraction of them " +
        "are orphans whose runtime is no longer installed, which cannot be booted, driven or " +
        "screenshotted at all. The result still says how many were left out and how to delete " +
        "them, and `include_unavailable` brings them back with `available: false` and the reason, " +
        'so "why can\'t I use that one" is still answerable here.',
      inputSchema: z.object({
        booted_only: z
          .boolean()
          .default(false)
          .describe("Only simulators that are currently running."),
        include_unavailable: z
          .boolean()
          .default(false)
          .describe(
            "Also list simulators whose runtime is not installed. Off by default because they " +
              "are not usable for anything; turn it on to see why a specific one is missing.",
          ),
        name_contains: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter on the name, e.g. "iPhone 17".'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ booted_only, include_unavailable, name_contains }) =>
      wrap(async () => {
        const all = await client.listSimulators({ fresh: true });
        const needle = name_contains?.toLowerCase();
        const matched = all.filter(
          (sim) =>
            (include_unavailable || sim.available) &&
            (!booted_only || sim.state === "Booted") &&
            (needle === undefined || sim.name.toLowerCase().includes(needle)),
        );
        const unavailable = all.filter((sim) => !sim.available).length;
        return {
          simulators: matched.map(toListRow),
          booted: all.filter((sim) => sim.state === "Booted").length,
          total: all.length,
          ...(unavailable > 0
            ? {
                unavailable,
                note:
                  `${unavailable} simulators have no installed runtime and cannot be used` +
                  (include_unavailable ? "" : ", and are not listed above") +
                  ". `xcrun simctl delete unavailable` clears them, or pass " +
                  "`include_unavailable: true` to see them here.",
              }
            : {}),
        };
      }),
  );
};

export const registerLifecycleTools = (server: McpServer, client: SimulatorClient): void => {
  server.registerTool(
    "ios_simulator_power",
    {
      title: "iOS Simulator: Power",
      description:
        "Boot or shut down a simulator. Booting is the one thing this server will not do for you " +
        "implicitly — a cold boot takes tens of seconds and puts a window on the user's screen, " +
        "and it changes which simulator an unqualified call resolves to afterwards. Both " +
        "directions are idempotent: booting a booted simulator succeeds.",
      inputSchema: z.object({
        device: deviceArg,
        state: z
          .enum(["booted", "shutdown"])
          .describe("The state to put it in. `booted` also waits for it to actually get there."),
        open_window: z
          .boolean()
          .default(true)
          .describe(
            "Bring up the Simulator app so the screen is visible. A `boot` on its own is headless, " +
              "which is fine for an agent and confusing for a person watching.",
          ),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .default(60_000)
          .describe("How long to wait for a boot to complete before reporting what it saw."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device, state, open_window, wait_ms }) =>
      wrap(async () => {
        const target = await client.resolveTarget(device);
        if (state === "shutdown") {
          if (target.state !== "Booted") {
            return { udid: target.id, name: target.name, state: "Shutdown", alreadyThere: true };
          }
          await client.simctl.shutdown(target.id);
          return { udid: target.id, name: target.name, state: "Shutdown" };
        }

        const already = target.state === "Booted";
        if (!already) await client.simctl.boot(target.id);
        if (open_window) await client.simctl.openApp(client.openPath);

        // Poll rather than trust the exit code: `simctl boot` returns as soon as
        // CoreSimulator has accepted the request, well before the device is
        // usable, and every tool after this one would fail on a half-booted one.
        const deadline = Date.now() + wait_ms;
        let observed = target.state;
        while (Date.now() < deadline) {
          const now = (await client.listSimulators({ fresh: true })).find(
            (sim) => sim.id === target.id,
          );
          observed = now?.state ?? observed;
          if (observed === "Booted") break;
          await sleep(BOOT_POLL_MS);
        }
        return {
          udid: target.id,
          name: target.name,
          state: observed,
          ...(already ? { alreadyThere: true } : {}),
          ...(observed === "Booted"
            ? {}
            : { warning: `Still ${observed} after ${wait_ms}ms. Raise wait_ms, or check Xcode.` }),
        };
      }),
  );

  server.registerTool(
    "ios_simulator_erase",
    {
      title: "iOS Simulator: Erase",
      description:
        "Wipe a simulator back to a factory state: installed apps, their data, the keychain and " +
        "every granted permission. The only irreversible tool here, and the reason it is the only " +
        "one behind `confirm`. Use it to test a genuine first launch. A booted simulator is shut " +
        "down first and booted again afterwards, because simctl refuses to erase a running one.",
      inputSchema: z.object({
        device: deviceArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ device }) =>
      wrap(async () => {
        const target = await client.resolveTarget(device);
        const wasBooted = target.state === "Booted";
        if (wasBooted) await client.simctl.shutdown(target.id);
        await client.simctl.erase(target.id);
        if (wasBooted) await client.simctl.boot(target.id);
        return {
          udid: target.id,
          name: target.name,
          erased: true,
          rebooted: wasBooted,
        };
      }),
  );
};
