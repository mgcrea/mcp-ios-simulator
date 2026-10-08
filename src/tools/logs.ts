import { readFile } from "node:fs/promises";

import { DEFAULT_CRASH_KINDS, readLogFile, summarizeCrashReport } from "@mgcrea/mcp-ios-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  crashReportPath,
  isSimulatorReport,
  listSimulatorCrashReports,
  reportUdid,
} from "#/client/crash";
import { IosError } from "#/client/errors";
import type { SimulatorClient } from "#/client/simulator";
import type { ToolContext } from "#/tools/index";
import { deviceArg, wrap } from "#/tools/util";

/** UDID → name, for labelling reports. Best effort: a Mac with no Xcode still has reports. */
const simulatorNames = async (client: SimulatorClient): Promise<Map<string, string>> => {
  try {
    return new Map((await client.listSimulators()).map((sim) => [sim.id.toUpperCase(), sim.name]));
  } catch {
    return new Map();
  }
};

/**
 * Crash reports: the half of "logs" that needs nothing launched. Observing, so
 * registered whatever the write gate says — reading a report changes nothing
 * on the simulator, the same way a screenshot does not.
 */
export const registerCrashLogTools = (
  server: McpServer,
  client: SimulatorClient,
  ctx: ToolContext,
): void => {
  const dir = ctx.config.crashReportsDir;

  server.registerTool(
    "ios_simulator_list_crash_logs",
    {
      title: "iOS Simulator: List Crash Logs",
      description:
        "List crash reports from simulator processes, newest first. A simulator app's crash is " +
        "written by this Mac into ~/Library/Logs/DiagnosticReports alongside the Mac's own " +
        "crashes; this keeps only the simulators' and says which simulator each came from. Most " +
        "of them are the simulators' own system daemons, so pass `process` to find your app's. " +
        "Read one with ios_simulator_get_crash_log. Nothing needs to be booted.",
      inputSchema: z.object({
        device: deviceArg.describe(
          "Only reports from this simulator, by UDID or name as shown by ios_simulator_list. " +
            "Omit for every simulator's — unlike the other tools, this does not default to the " +
            "booted one, since a crash often outlives the boot it happened in.",
        ),
        process: z
          .string()
          .optional()
          .describe(
            'Case-insensitive substring of the process name or bundle id, e.g. "Canopy" or ' +
              '"io.mgcrea". The process name is the app\'s executable name, usually but not ' +
              "always its display name.",
          ),
        kinds: z
          .array(z.string())
          .optional()
          .describe(
            'Report kinds to include, e.g. ["crash"]. Defaults to ["crash", "jetsam", ' +
              '"user_fault"]; kinds without a name come back as "bug_type_<n>". Pass ["all"] ' +
              "for everything.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Maximum reports to return, newest first (1-200). Defaults to 20."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, process, kinds, limit }) =>
      wrap(async () => {
        const target = device ? await client.resolveTarget(device) : undefined;
        const wanted = kinds ?? DEFAULT_CRASH_KINDS;
        const needle = process?.toLowerCase();
        const all = await listSimulatorCrashReports(dir);
        const matching = all.filter(
          (report) =>
            (!target || report.udid === target.id.toUpperCase()) &&
            (wanted.includes("all") || wanted.includes(report.kind)) &&
            (!needle ||
              report.process.toLowerCase().includes(needle) ||
              (report.bundleId?.toLowerCase().includes(needle) ?? false)),
        );
        const names = target ? undefined : await simulatorNames(client);
        return {
          ...(target ? { simulator: target.name, udid: target.id } : {}),
          reports: matching.slice(0, limit).map(({ udid, bundleId, ...row }) => ({
            ...row,
            ...(bundleId ? { bundleId } : {}),
            // Per row only when the list spans simulators; otherwise it is the
            // same value on every row and already said once above.
            ...(names && udid
              ? { udid, ...(names.get(udid) ? { simulator: names.get(udid) } : {}) }
              : {}),
          })),
          total: matching.length,
        };
      }),
  );

  server.registerTool(
    "ios_simulator_get_crash_log",
    {
      title: "iOS Simulator: Get Crash Log",
      description:
        "Read one simulator crash report and return what matters in it: the exception, why the " +
        "process was terminated, any application-specific message, and the faulting thread's " +
        "top frames with library names resolved. The full report's path is returned too; it is " +
        "often tens of kilobytes, so read it only when the summary is not enough. A Swift fatalError's " +
        "message may not be in the report at all — on a simulator it goes to the app's stderr.",
      inputSchema: z.object({
        name: z
          .string()
          .regex(
            /^[^/][^\0]*\.ips$/,
            "Pass a `name` exactly as ios_simulator_list_crash_logs returned it.",
          )
          .refine((value) => !value.split("/").includes(".."), "`name` cannot contain `..`.")
          .describe(
            "The report's `name` from ios_simulator_list_crash_logs, e.g. \"Canopy-2026-10-08-" +
              '101500.ips" or "Retired/Canopy-2026-10-02-213409.ips". Older reports move under ' +
              "Retired/, so a name that worked yesterday may need listing again.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ name }) =>
      wrap(async () => {
        const path = crashReportPath(dir, name);
        let text: string;
        try {
          text = await readFile(path, "utf8");
        } catch {
          throw new IosError(`No crash report named ${name}.`, {
            remedy:
              "Run ios_simulator_list_crash_logs again: reports move to Retired/ as they age, " +
              "and the system deletes old ones.",
          });
        }
        if (!isSimulatorReport(text)) {
          throw new IosError(`${name} is a crash report from this Mac, not from a simulator.`, {
            remedy:
              "Pick a report from ios_simulator_list_crash_logs, which lists only simulators'.",
          });
        }
        const summary = summarizeCrashReport(text);
        const udid = reportUdid(text);
        const simulator = udid ? (await simulatorNames(client)).get(udid) : undefined;
        const asi = summary.crash?.["applicationSpecificInfo"];
        return {
          name,
          path,
          ...(udid ? { udid } : {}),
          ...(simulator ? { simulator } : {}),
          ...summary,
          ...(summary.crash
            ? asi
              ? {}
              : {
                  note:
                    "The report carries no application-specific message. A Swift fatalError's " +
                    "text goes to the app's stderr on a simulator" +
                    (ctx.allowWrites
                      ? ", so relaunch with ios_simulator_launch `capture_logs: true` and read " +
                        "it with ios_simulator_read_logs."
                      : "."),
                }
            : { note: "Not a crash report with a faulting thread; read the file at `path`." }),
        };
      }),
  );
};

/**
 * Reading an app's captured log. Registered with the launch tool it depends on,
 * behind the write gate: without `ios_simulator_launch` there is never anything
 * to read.
 */
export const registerLogReadTools = (server: McpServer, client: SimulatorClient): void => {
  server.registerTool(
    "ios_simulator_read_logs",
    {
      title: "iOS Simulator: Read Logs",
      description:
        "Read an app's log output: stdout, stderr and every Logger/os_log message the process " +
        "emits, interleaved in one file. Only available for an app started with " +
        "ios_simulator_launch `capture_logs: true`. Returns the newest `limit` lines plus a " +
        "`next` cursor; pass it back to get only what arrived since, which is how to see what " +
        "one tap logged. `capturing` turns false once the app's process has exited, and what it " +
        "wrote stays readable. A crash's backtrace is not in here — see " +
        "ios_simulator_list_crash_logs — but its fatalError message is.",
      inputSchema: z.object({
        device: deviceArg,
        bundle_id: z
          .string()
          .optional()
          .describe(
            'Which app\'s capture, e.g. "io.mgcrea.Canopy". Defaults to the most recent capture.',
          ),
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "The `next` value from the previous read, to get only newer lines. Omit to read " +
              "from the start of the capture.",
          ),
        filter: z
          .string()
          .optional()
          .describe(
            'Case-insensitive regular expression a line must match, e.g. "error|fail" or ' +
              '"\\[Sync\\]". Applied before `limit`, so it finds matches across the whole range.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(200)
          .describe(
            "Most lines to return; the newest are kept and the rest counted in `omitted`. " +
              "Defaults to 200 — filter rather than raising this.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ device, bundle_id, cursor, filter, limit }) =>
      wrap(async () => {
        // Resolved only when named: the file is on this Mac and outlives the
        // boot, so reading it should not fail because the simulator shut down.
        const target = device ? await client.resolveTarget(device) : undefined;
        const capture = client.captures.find(target?.id, bundle_id);
        if (!capture) {
          throw new IosError(
            bundle_id ? `No log capture for ${bundle_id}.` : "No log capture has been started.",
            {
              remedy:
                'Launch the app with ios_simulator_launch {"bundle_id":"…","capture_logs":true}. ' +
                "A capture belongs to this server process, so one started before it restarted " +
                "is not known here, though its file is still under the output directory.",
            },
          );
        }
        const running = client.captures.running(capture);
        let result: Awaited<ReturnType<typeof readLogFile>>;
        try {
          result = await readLogFile(capture.path, { cursor, filter, limit, complete: !running });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          throw new IosError(`The log file for ${capture.bundleId} is gone: ${capture.path}`, {
            remedy:
              "Erasing the simulator deletes it when it was written under the simulator's data " +
              "directory. Launch again with `capture_logs: true`.",
          });
        }
        return {
          bundleId: capture.bundleId,
          simulator: capture.simulatorName,
          capturing: running,
          ...(capture.pid !== undefined ? { pid: capture.pid } : {}),
          ...result,
          path: capture.path,
          ...(result.skippedBytes > 0
            ? {
                note:
                  `${result.skippedBytes} bytes before this window were not read. Pass the ` +
                  "returned `next` sooner, or read the file at `path`.",
              }
            : {}),
        };
      }),
  );
};
