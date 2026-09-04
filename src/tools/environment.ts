import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { IosError } from "#/client/errors";
import type { SimulatorClient } from "#/client/simulator";
import { bundleIdArg, deviceArg, wrap } from "#/tools/util";

/** simctl's own list, verbatim — a value it does not accept is not worth guessing at. */
const PRIVACY_SERVICES = [
  "all",
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
] as const;

/** APNs refuses anything larger, and it is worth saying so before the round trip. */
const MAX_PUSH_BYTES = 4096;

export const registerEnvironmentTools = (server: McpServer, client: SimulatorClient): void => {
  server.registerTool(
    "ios_simulator_set_environment",
    {
      title: "iOS Simulator: Set Environment",
      description:
        "Stage the simulator before a screenshot or a test: dark mode, Dynamic Type size, " +
        "increased contrast, a frozen status bar, a simulated location, and app permissions. " +
        "None of this is possible on a physical device, and it is most of the reason to prefer a " +
        "simulator for UI work. Every field is optional; those given are applied in order and the " +
        "result reports the state afterwards. A status bar override survives a reboot, so clear " +
        "it when you are done or it quietly pollutes later screenshots.",
      inputSchema: z.object({
        device: deviceArg,
        appearance: z.enum(["light", "dark"]).optional().describe("Interface style."),
        content_size: z
          .enum([
            "extra-small",
            "small",
            "medium",
            "large",
            "extra-large",
            "extra-extra-large",
            "extra-extra-extra-large",
            "accessibility-medium",
            "accessibility-large",
            "accessibility-extra-large",
            "accessibility-extra-extra-large",
            "accessibility-extra-extra-extra-large",
          ])
          .optional()
          .describe("Dynamic Type size. The accessibility- sizes are where layouts break."),
        increase_contrast: z.boolean().optional().describe("Increase Contrast accessibility mode."),
        status_bar: z
          .object({
            time: z
              .string()
              .optional()
              .describe('Fixed clock, e.g. "9:41" — what App Store screenshots use.'),
            wifi_bars: z.number().int().min(0).max(3).optional(),
            cellular_bars: z.number().int().min(0).max(4).optional(),
            operator_name: z.string().optional().describe('Carrier name; "" hides it.'),
            battery_level: z.number().int().min(0).max(100).optional(),
            battery_state: z.enum(["charging", "charged", "discharging"]).optional(),
          })
          .optional()
          .describe("Freeze the status bar. Overrides persist until cleared."),
        clear_status_bar: z
          .boolean()
          .default(false)
          .describe("Drop every status bar override, restoring the real one."),
        location: z
          .object({ latitude: z.number(), longitude: z.number() })
          .optional()
          .describe("Teleport the device, for location-gated screens."),
        clear_location: z.boolean().default(false).describe("Stop simulating a location."),
        permission: z
          .object({
            action: z
              .enum(["grant", "revoke", "reset"])
              .describe(
                "`grant` and `revoke` answer the prompt without showing it; `reset` makes it " +
                  "appear again on next use.",
              ),
            service: z.enum(PRIVACY_SERVICES),
            bundle_id: bundleIdArg
              .optional()
              .describe("Required for grant and revoke; optional for reset."),
          })
          .optional()
          .describe(
            "Set an app permission directly. This is how you reach the denied branch of a " +
              "permission check, which is otherwise a prompt nobody can tap.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({
      device,
      appearance,
      content_size,
      increase_contrast,
      status_bar,
      clear_status_bar,
      location,
      clear_location,
      permission,
    }) =>
      wrap(async () => {
        const target = client.requireBooted(await client.resolveTarget(device));
        const applied: string[] = [];

        if (appearance) {
          await client.simctl.uiSet(target.id, "appearance", appearance);
          applied.push(`appearance=${appearance}`);
        }
        if (content_size) {
          await client.simctl.uiSet(target.id, "content_size", content_size);
          applied.push(`content_size=${content_size}`);
        }
        if (increase_contrast !== undefined) {
          await client.simctl.uiSet(
            target.id,
            "increase_contrast",
            increase_contrast ? "enabled" : "disabled",
          );
          applied.push(`increase_contrast=${increase_contrast}`);
        }
        if (clear_status_bar) {
          await client.simctl.statusBarClear(target.id);
          applied.push("status_bar cleared");
        }
        if (status_bar) {
          const flags = [
            ...(status_bar.time ? ["--time", status_bar.time] : []),
            ...(status_bar.wifi_bars !== undefined
              ? ["--wifiMode", "active", "--wifiBars", String(status_bar.wifi_bars)]
              : []),
            ...(status_bar.cellular_bars !== undefined
              ? ["--cellularMode", "active", "--cellularBars", String(status_bar.cellular_bars)]
              : []),
            ...(status_bar.operator_name !== undefined
              ? ["--operatorName", status_bar.operator_name]
              : []),
            ...(status_bar.battery_level !== undefined
              ? ["--batteryLevel", String(status_bar.battery_level)]
              : []),
            ...(status_bar.battery_state ? ["--batteryState", status_bar.battery_state] : []),
          ];
          if (flags.length === 0) {
            throw new IosError("`status_bar` was given with no fields to override.", {
              remedy: "Set at least one field, or use `clear_status_bar` to drop the overrides.",
            });
          }
          await client.simctl.statusBarOverride(target.id, flags);
          applied.push("status_bar overridden");
        }
        if (clear_location) {
          await client.simctl.locationClear(target.id);
          applied.push("location cleared");
        }
        if (location) {
          await client.simctl.locationSet(target.id, location.latitude, location.longitude);
          applied.push(`location=${location.latitude},${location.longitude}`);
        }
        if (permission) {
          if (permission.action !== "reset" && !permission.bundle_id) {
            throw new IosError(`\`${permission.action}\` needs a bundle_id.`, {
              remedy: "Pass the app's bundle id, or use `reset`, which does not need one.",
            });
          }
          await client.simctl.privacy(
            target.id,
            permission.action,
            permission.service,
            permission.bundle_id,
          );
          applied.push(`permission ${permission.action} ${permission.service}`);
        }

        if (applied.length === 0) {
          throw new IosError("Nothing to do — no field was given.", {
            remedy:
              "Set at least one of appearance, content_size, status_bar, location, permission.",
          });
        }

        // Read back rather than echo the request: `simctl ui` answers `unknown`
        // or `unsupported` on a runtime too old for a setting, and reporting the
        // value we asked for would hide that.
        return {
          applied,
          state: {
            appearance: await client.simctl.uiGet(target.id, "appearance"),
            contentSize: await client.simctl.uiGet(target.id, "content_size"),
            statusBar: await client.simctl.statusBarList(target.id),
          },
        };
      }),
  );

  server.registerTool(
    "ios_simulator_push",
    {
      title: "iOS Simulator: Push",
      description:
        "Deliver a push notification, with no APNs certificate and no server. The payload is a " +
        "normal remote-notification body and must contain an `aps` key. Only remote pushes are " +
        "simulated — not VoIP, complications or file-provider. The app must be installed; it does " +
        "not have to be running.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: bundleIdArg,
        payload: z
          .record(z.string(), z.unknown())
          .describe(
            'The APNs payload, e.g. {"aps":{"alert":{"title":"Watering due","body":"Monstera"},' +
              '"sound":"default","badge":1}}. Max 4096 bytes.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ device, bundle_id, payload }) =>
      wrap(async () => {
        if (!("aps" in payload)) {
          throw new IosError("A push payload must have a top-level `aps` key.", {
            remedy: 'Wrap the notification, e.g. {"aps":{"alert":"Hello"}}.',
          });
        }
        const bytes = Buffer.byteLength(JSON.stringify(payload));
        if (bytes > MAX_PUSH_BYTES) {
          throw new IosError(`The payload is ${bytes} bytes; APNs allows ${MAX_PUSH_BYTES}.`, {
            remedy: "Shorten it — this is refused here rather than by simctl, but the cap is real.",
          });
        }
        const target = client.requireBooted(await client.resolveTarget(device));
        await client.simctl.push(target.id, bundle_id, payload);
        return { pushed: bundle_id, bytes };
      }),
  );
};
