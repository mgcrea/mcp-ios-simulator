import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExecImpl } from "@mgcrea/mcp-ios-core";
import { describe, expect, it } from "vitest";

import { pngDimensions, readScreenProfile, toDisplayInfo } from "#/client/display";
import { parseSimctlError } from "#/client/simctl";
import { loadConfig } from "#/config";
import {
  ABSENT_CONFIG,
  BOOTED_UDID,
  connect,
  DEVICES_JSON,
  execMock,
  scratchDir,
  spawnMock,
  TINY_PNG,
  type ExecCall,
} from "#test/helpers";

/** A WebDriverAgent that is simply not running. */
const refusing = async (): Promise<Response> => {
  throw new TypeError("fetch failed");
};

/** A machine with no Xcode at all. */
const exploding: ExecImpl = () => {
  throw new Error("no xcrun here");
};

const READ_TOOLS = [
  "ios_simulator_diagnostics",
  // Files this Mac already wrote; reading one changes nothing on a simulator.
  "ios_simulator_get_crash_log",
  "ios_simulator_list",
  "ios_simulator_list_apps",
  "ios_simulator_list_crash_logs",
  "ios_simulator_screenshot",
  "ios_simulator_ui_tree",
  // Observing, so it survives the write gate: waiting for a screen to finish
  // loading is something a read-only session needs at least as much.
  "ios_simulator_wait_for_element",
];

const ALL_TOOLS = [
  "ios_simulator_add_media",
  "ios_simulator_diagnostics",
  "ios_simulator_erase",
  "ios_simulator_get_crash_log",
  "ios_simulator_install",
  "ios_simulator_launch",
  "ios_simulator_list",
  "ios_simulator_list_apps",
  "ios_simulator_list_crash_logs",
  "ios_simulator_open_url",
  "ios_simulator_power",
  "ios_simulator_press_button",
  "ios_simulator_push",
  // Read-only, but it reads only what launch started, so it goes where launch goes.
  "ios_simulator_read_logs",
  "ios_simulator_restart_wda",
  "ios_simulator_screenshot",
  "ios_simulator_set_environment",
  "ios_simulator_swipe",
  "ios_simulator_tap",
  "ios_simulator_tap_element",
  "ios_simulator_terminate",
  "ios_simulator_type",
  "ios_simulator_ui_tree",
  "ios_simulator_uninstall",
  "ios_simulator_wait_for_element",
];

describe("the write gate", () => {
  // Inverted relative to every other server in the fleet, so the assertions are
  // inverted too: the permissive state is the default, and the thing worth
  // failing CI over is a tool silently *joining* it.
  it("registers everything by default, because a simulator is disposable", async () => {
    expect(await (await connect()).toolNames()).toEqual(ALL_TOOLS);
  });

  it("turning writes off removes the driving tools rather than refusing them", async () => {
    const names = await (await connect({ IOS_SIMULATOR_ALLOW_WRITES: "0" })).toolNames();
    expect(names).toEqual(READ_TOOLS);
  });

  it("leaves the read tools untouched either way, so the gate cannot go vacuous", async () => {
    const off = await (await connect({ IOS_SIMULATOR_ALLOW_WRITES: "0" })).toolNames();
    const on = await (await connect()).toolNames();
    expect(off.every((name) => on.includes(name))).toBe(true);
  });

  it("registers the shared tools under this server's own namespace", async () => {
    for (const tool of await (await connect()).tools()) {
      expect(JSON.stringify(tool)).not.toContain("ios_device");
    }
  });
});

describe("every tool", () => {
  // Three properties invisible in review and at runtime — the model just guesses.
  it("has a service-prefixed title, annotations, and a description on every field", async () => {
    for (const tool of await (await connect()).tools()) {
      expect(tool.title, tool.name).toMatch(/^iOS Simulator: /);
      expect(tool.annotations, tool.name).toBeDefined();
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });
});

describe("resolving which simulator", () => {
  it("uses the only booted one when nothing is named", async () => {
    const result = await (await connect()).call("ios_simulator_diagnostics");
    expect(result.target).toMatchObject({ udid: BOOTED_UDID, state: "Booted" });
  });

  it("refuses `all`, which simctl reads as every simulator", async () => {
    // `simctl erase all` wipes the machine. A hint is a string from a model, so
    // this is refused in the resolver and again in the adapter.
    const log: ExecCall[] = [];
    const harness = await connect({}, { exec: execMock({ log }) });
    const result = await harness.call("ios_simulator_erase", { device: "all", confirm: true });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("*every* simulator");
    expect(log.some((call) => call.args.includes("erase"))).toBe(false);
  });

  it("refuses `unavailable` for the same reason", async () => {
    const result = await (
      await connect()
    ).call("ios_simulator_list_apps", {
      device: "unavailable",
    });
    expect(result.isToolError).toBe(true);
  });

  it("refuses a simulator whose runtime is missing, rather than letting simctl abort", async () => {
    // `simctl io` against one of these does not fail — it raises an uncaught
    // NSInternalInconsistencyException and dies with a thirty-line stack trace.
    const result = await (
      await connect()
    ).call("ios_simulator_screenshot", {
      device: "D5B862C3-17FC-4564-B1A9-CB314309519E",
    });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("unavailable");
    expect(String(result.remedy)).toContain("delete unavailable");
  });

  it("names the simulator and the exact call to fix it when it is shut down", async () => {
    const result = await (
      await connect()
    ).call("ios_simulator_list_apps", {
      device: "appshot-iphone",
    });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("shut down");
    expect(String(result.remedy)).toContain("ios_simulator_power");
  });

  it("says what exists when the name matches nothing", async () => {
    const result = await (await connect()).call("ios_simulator_screenshot", { device: "Pixel 9" });
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("ios_simulator_list");
  });
});

describe("the screen", () => {
  it("screenshots through simctl, with no WebDriverAgent involved at all", async () => {
    // The claim this server is built on. A refusing WDA must not stop it.
    const harness = await connect({}, { fetch: refusing });
    const result = await harness.call("ios_simulator_screenshot");
    expect(result.isToolError).toBe(false);
    expect(result.hasImage).toBe(true);
    expect(result.coordinateSpace).toBe("points");
  });

  it("passes a real path to simctl, never the documented `-`", async () => {
    // `simctl io … screenshot -` writes a file called `-` into the working
    // directory and leaves stdout empty. Measured on Xcode 26.6.
    const log: ExecCall[] = [];
    await (await connect({}, { exec: execMock({ log }) })).call("ios_simulator_screenshot");
    const io = log.find((call) => call.args.includes("screenshot"));
    expect(io).toBeDefined();
    expect(io?.args.at(-1)).toMatch(/\.png$/);
    expect(io?.args).not.toContain("-");
  });

  it("reads the tree through WebDriverAgent and flattens it", async () => {
    const result = await (await connect()).call("ios_simulator_ui_tree");
    expect(result.isToolError).toBe(false);
    expect(result.coordinateSpace).toBe("points");
  });

  it("says the runner is not up, and that screenshots still work, when WDA is down", async () => {
    const result = await (await connect({}, { fetch: refusing })).call("ios_simulator_ui_tree");
    expect(result.isToolError).toBe(true);
    // The fix for the reported failure: a remedy that names this server's own
    // tool, not a shell command. The runner tool spawns detached, so it is
    // strictly better than the npx form a caller was previously sent to.
    expect(String(result.remedy)).toContain("ios_simulator_restart_wda");
    expect(String(result.remedy)).not.toContain("npx");
    expect(String(result.remedy)).toContain("screenshots go through simctl");
  });

  it("falls back to the shell recipe when the runner tool is not registered", async () => {
    // With writes off `ios_simulator_restart_wda` does not exist, and naming it
    // would be the same mistake pointed the other way.
    const result = await (
      await connect({ IOS_SIMULATOR_ALLOW_WRITES: "0" }, { fetch: refusing })
    ).call("ios_simulator_ui_tree");
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("wda.sh");
    expect(String(result.remedy)).not.toContain("ios_simulator_restart_wda");
  });
});

describe("geometry", () => {
  it("reads pixels from the capture and the scale from the device profile", () => {
    const display = toDisplayInfo(
      { mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 },
      { width: 1206, height: 2622 },
    );
    expect(display).toMatchObject({
      pixelWidth: 1206,
      pointWidth: 402,
      pointHeight: 874,
      pointScale: 3,
      orientation: "portrait",
    });
  });

  it("lets the capture win over the profile, since a booted screen can be resized", () => {
    // `simctl io … screenConfig geometry` changes a running simulator's screen.
    // Trusting the profile there would put every tap in the wrong space.
    const display = toDisplayInfo(
      { mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 },
      { width: 2622, height: 1206 },
    );
    expect(display.pixelWidth).toBe(2622);
    expect(display.orientation).toBe("landscape");
  });

  it("reports orientation as unknown rather than guessing when nothing was captured", () => {
    const display = toDisplayInfo({
      mainScreenWidth: 1206,
      mainScreenHeight: 2622,
      mainScreenScale: 3,
    });
    expect(display.orientation).toBe("unknown");
  });

  it("falls back to capabilities.plist, where Xcode 27 moved the geometry", async () => {
    // Xcode 27's profile.plist has no mainScreen* key for any device type, and
    // trusting the silence would default the scale to 1 and label pixels as points.
    const reads: string[] = [];
    const exec: ExecImpl = async (_path, args) => {
      const file = args.at(-1) as string;
      reads.push(file);
      if (file.endsWith("profile.plist"))
        return { stdout: '{"modelIdentifier":"iPhone19,2"}', stderr: "" };
      return {
        stdout: JSON.stringify({
          capabilities: {
            ScreenDimensionsCapability: {
              "main-screen-width": 1206,
              "main-screen-height": 2622,
              "main-screen-scale": 3,
            },
          },
        }),
        stderr: "",
      };
    };
    const profile = await readScreenProfile(
      {
        identifier: "x",
        name: "iPhone 18 Pro",
        bundlePath: "/DeviceTypes/iPhone 18 Pro.simdevicetype",
      },
      { plutilPath: "/usr/bin/plutil", exec, timeoutMs: 1000 },
    );
    expect(profile).toEqual({ mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 });
    expect(reads.at(-1)).toMatch(/capabilities\.plist$/);
  });

  it("does not read capabilities.plist when the profile already has the scale", async () => {
    const reads: string[] = [];
    const exec: ExecImpl = async (_path, args) => {
      reads.push(args.at(-1) as string);
      return {
        stdout: '{"mainScreenWidth":1206,"mainScreenHeight":2622,"mainScreenScale":3}',
        stderr: "",
      };
    };
    await readScreenProfile(
      {
        identifier: "x",
        name: "iPhone 17 Pro",
        bundlePath: "/DeviceTypes/iPhone 17 Pro.simdevicetype",
      },
      { plutilPath: "/usr/bin/plutil", exec, timeoutMs: 1000 },
    );
    expect(reads).toHaveLength(1);
  });

  it("reads a PNG's dimensions out of its header", () => {
    expect(pngDimensions(Buffer.from(TINY_PNG, "base64"))).toEqual({ width: 1, height: 1 });
    expect(pngDimensions(Buffer.from("not a png"))).toBeUndefined();
  });
});

describe("apps", () => {
  it("converts the NeXTSTEP plist listapps returns, and keeps only your apps", async () => {
    const log: ExecCall[] = [];
    const result = await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_list_apps");
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]).toMatchObject({ bundleId: "io.mgcrea.Canopy", version: "1.4.0" });
    // The hop that makes it work: simctl's plist is written out and handed to
    // plutil by path, because ExecImpl has no stdin.
    expect(log.some((call) => call.path.endsWith("plutil"))).toBe(true);
  });

  it("reports the data container as an ordinary path, since there is nothing to copy", async () => {
    const result = await (await connect()).call("ios_simulator_list_apps");
    expect(String(result.apps[0].dataContainer)).toMatch(/^\/Users\//);
  });

  it("includes Apple's own apps only when asked", async () => {
    const result = await (await connect()).call("ios_simulator_list_apps", { include_all: true });
    expect(result.apps).toHaveLength(2);
  });

  it("refuses a relative install path before shelling out", async () => {
    const result = await (await connect()).call("ios_simulator_install", { path: "Foo.app" });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("absolute");
  });

  it("applies IOS_SIMULATOR_LAUNCH_ARGS when the call passes none", async () => {
    const harness = await connect({ IOS_SIMULATOR_LAUNCH_ARGS: "-DemoMode -NoCloud" });
    const result = await harness.call("ios_simulator_launch", { bundle_id: "io.mgcrea.Canopy" });
    expect(result.arguments).toEqual(["-DemoMode", "-NoCloud"]);
    expect(result.argumentsFrom).toBe("IOS_SIMULATOR_LAUNCH_ARGS");
  });

  it("replaces a running copy by default, via the real simctl flag", async () => {
    const log: ExecCall[] = [];
    await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_launch", {
      bundle_id: "io.mgcrea.Canopy",
    });
    const launch = log.find((call) => call.args.includes("launch"));
    expect(launch?.args).toContain("--terminate-running-process");
  });
});

describe("log capture", () => {
  const BOOTED_DATA =
    "/Users/example/Library/Developer/CoreSimulator/Devices/C4AB4BE0-C0BC-436C-8C03-8F87330DFFA5/data";

  it("sets OS_ACTIVITY_DT_MODE through simctl's SIMCTL_CHILD_ prefix, with no shell", async () => {
    const log: ExecCall[] = [];
    const harness = await connect({}, { exec: execMock({ log }) });
    const result = await harness.call("ios_simulator_launch", {
      bundle_id: "io.mgcrea.Canopy",
      capture_logs: true,
    });
    expect(result.isToolError).toBe(false);
    const launch = log.find((call) => call.args.includes("launch"));
    // `env` puts the variable in simctl's own environment, which is the only
    // place simctl reads a child's environment from.
    expect(launch?.path).toBe("/usr/bin/env");
    expect(launch?.args.slice(0, 4)).toEqual([
      "SIMCTL_CHILD_OS_ACTIVITY_DT_MODE=YES",
      "/usr/bin/xcrun",
      "simctl",
      "launch",
    ]);
    // One file for both streams, so one cursor follows print, stderr and Logger.
    const out = launch?.args.find((arg) => arg.startsWith("--stdout="))?.slice(9);
    const err = launch?.args.find((arg) => arg.startsWith("--stderr="))?.slice(9);
    expect(out).toBe(err);
    expect(result).toMatchObject({ pid: 4242, capturingLogs: true, log: out });
  });

  it("leaves a plain launch on xcrun with separate files, as before", async () => {
    const log: ExecCall[] = [];
    const result = await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_launch", { bundle_id: "io.mgcrea.Canopy" });
    const launch = log.find((call) => call.args.includes("launch"));
    expect(launch?.path).toBe("/usr/bin/xcrun");
    expect(launch?.args.join(" ")).not.toContain("SIMCTL_CHILD_");
    expect(result.logs.stdout).toMatch(/io\.mgcrea\.Canopy\.out\.log$/);
    expect(result.warning).toBeUndefined();
  });

  it("reports where the simulator really wrote a /tmp log: inside its own data root", async () => {
    // Measured on an iOS 27.0 runtime: --stdout=/tmp/x landed at
    // <dataPath>/tmp/x, and the path as given never existed.
    const root = scratchDir();
    const devices = DEVICES_JSON.replace(BOOTED_DATA, root);
    const harness = await connect(
      { IOS_SIMULATOR_OUTPUT_DIR: "/private/tmp/mcp-sim-remap" },
      { exec: execMock({ simulatorRoot: root, overrides: { "list devices": devices } }) },
    );
    const result = await harness.call("ios_simulator_launch", {
      bundle_id: "io.mgcrea.Canopy",
      capture_logs: true,
    });
    expect(String(result.log).startsWith(`${root}/tmp/mcp-sim-remap/logs/`)).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("says so, rather than returning a path that does not exist, when the file is nowhere", async () => {
    // Written under a root that is not the simulator's dataPath, so neither
    // place the server looks has it.
    const harness = await connect({}, { exec: execMock({ simulatorRoot: scratchDir() }) });
    const result = await harness.call("ios_simulator_launch", {
      bundle_id: "io.mgcrea.Canopy",
      capture_logs: true,
    });
    expect(String(result.warning)).toContain("IOS_SIMULATOR_OUTPUT_DIR");
  }, 10_000);

  it("refuses to read with no capture, and names the flag that starts one", async () => {
    const result = await (await connect()).call("ios_simulator_read_logs");
    expect(result.isToolError).toBe(true);
    expect(String(result.remedy)).toContain("capture_logs");
  });

  it("reads, follows with a cursor, and finishes the last line once the app exits", async () => {
    let alive = true;
    const harness = await connect({}, { processAlive: () => alive });
    const launched = await harness.call("ios_simulator_launch", {
      bundle_id: "io.mgcrea.Canopy",
      capture_logs: true,
    });
    const path = String(launched.log);
    await appendFile(
      path,
      "stdout line 1\n" +
        "2026-10-08 23:27:10.165920+0200 Canopy[92138:106729888] [probe] oslog line 1\n" +
        "half a li",
    );

    const first = await harness.call("ios_simulator_read_logs");
    expect(first).toMatchObject({ capturing: true, pid: 4242, matched: 2, omitted: 0, path });
    // The unified-log prefix is cut to the time, and the unfinished line waits.
    expect(first.lines).toEqual(["stdout line 1", "23:27:10.165 [probe] oslog line 1"]);

    await appendFile(path, "ne\nFatal error: boom\n");
    const second = await harness.call("ios_simulator_read_logs", { cursor: first.next });
    expect(second.lines).toEqual(["half a line", "Fatal error: boom"]);

    await appendFile(path, "no newline at exit");
    alive = false;
    const last = await harness.call("ios_simulator_read_logs", {
      bundle_id: "io.mgcrea.Canopy",
      cursor: second.next,
    });
    expect(last).toMatchObject({ capturing: false, lines: ["no newline at exit"] });
  });

  it("filters before limiting, and counts what it left out", async () => {
    const harness = await connect();
    const launched = await harness.call("ios_simulator_launch", {
      bundle_id: "io.mgcrea.Canopy",
      capture_logs: true,
    });
    await writeFile(
      String(launched.log),
      Array.from({ length: 50 }, (_, i) => `${i % 5 === 0 ? "error" : "info"} ${i}`).join("\n") +
        "\n",
    );
    const result = await harness.call("ios_simulator_read_logs", { filter: "^error", limit: 3 });
    expect(result).toMatchObject({
      matched: 10,
      omitted: 7,
      lines: ["error 35", "error 40", "error 45"],
    });
    const bad = await harness.call("ios_simulator_read_logs", { filter: "([" });
    expect(bad.isToolError).toBe(true);
  });

  it("is not registered when writes are off, since nothing could start a capture", async () => {
    const names = await (await connect({ IOS_SIMULATOR_ALLOW_WRITES: "0" })).toolNames();
    expect(names).not.toContain("ios_simulator_read_logs");
  });
});

/** A `.ips` in the shape this Mac's ReportCrash writes: a header line, then the report. */
const ips = (opts: {
  app: string;
  platform: number;
  udid?: string;
  timestamp: string;
  bugType?: string;
  isSimulated?: boolean;
}): string =>
  JSON.stringify({
    ...(opts.isSimulated ? { is_simulated: 1 } : {}),
    app_name: opts.app,
    timestamp: opts.timestamp,
    app_version: "1.0",
    build_version: "1",
    platform: opts.platform,
    bundleID: `io.example.${opts.app}`,
    bug_type: opts.bugType ?? "309",
    os_version: "macOS 27.0.1 (26A434)",
    name: opts.app,
    incident_id: "1570CBB6-C4EC-4F25-81A5-3AD897FBA2E8",
  }) +
  "\n" +
  JSON.stringify(
    {
      procName: opts.app,
      pid: 7298,
      // Anonymised exactly like the real thing, which is why it is no use.
      procPath: `/Users/USER/*/${opts.app}.app/${opts.app}`,
      parentProc: opts.udid ? "launchd_sim" : "launchd",
      coalitionName: opts.udid
        ? `com.apple.CoreSimulator.SimDevice.${opts.udid}`
        : `io.example.${opts.app}`,
      exception: { type: "EXC_BREAKPOINT", signal: "SIGTRAP" },
      termination: { namespace: "SIGNAL", code: 5, indicator: "Trace/BPT trap: 5" },
      faultingThread: 0,
      threads: [
        {
          queue: "com.apple.main-thread",
          frames: [
            {
              imageIndex: 0,
              symbol: "_assertionFailure(_:_:file:line:flags:)",
              symbolLocation: 208,
            },
            { imageIndex: 1, symbol: "main", symbolLocation: 3144 },
          ],
        },
      ],
      usedImages: [{ name: "libswiftCore.dylib" }, { name: opts.app }],
    },
    null,
    2,
  );

const OTHER_UDID = "18764510-38C0-4D96-B0BA-7F8A969EF2AD";

const reportsDir = async (): Promise<string> => {
  const dir = scratchDir();
  await mkdir(join(dir, "Retired"));
  const put = (name: string, text: string) => writeFile(join(dir, name), text);
  await put(
    "Canopy-2026-10-08-232826.ips",
    ips({
      app: "Canopy",
      platform: 7,
      udid: BOOTED_UDID,
      timestamp: "2026-10-08 23:28:26.00 +0200",
    }),
  );
  await put(
    "intelligencetasksd-2026-10-08-150617.ips",
    ips({
      app: "intelligencetasksd",
      platform: 7,
      udid: OTHER_UDID,
      timestamp: "2026-10-08 15:06:17.00 +0200",
    }),
  );
  // A Mac app's crash with `is_simulated` set: measured, and not a simulator's.
  await put(
    "ExcUserFault_Safari-2026-10-08-221045.ips",
    ips({
      app: "Safari",
      platform: 1,
      isSimulated: true,
      timestamp: "2026-10-08 22:10:45.00 +0200",
    }),
  );
  await put(
    "Drakar-2026-10-08-174624.ips",
    ips({ app: "Drakar", platform: 1, timestamp: "2026-10-08 17:46:24.00 +0200" }),
  );
  await writeFile(
    join(dir, "Retired", "Canopy-2026-10-02-213409.ips"),
    ips({
      app: "Canopy",
      platform: 7,
      udid: BOOTED_UDID,
      timestamp: "2026-10-02 21:34:09.00 +0200",
    }),
  );
  await put("something.diag", "not a crash report");
  return dir;
};

describe("crash logs", () => {
  it("lists only simulator reports, newest first, Retired/ included", async () => {
    const dir = await reportsDir();
    const harness = await connect({ IOS_SIMULATOR_CRASH_REPORTS_DIR: dir });
    const result = await harness.call("ios_simulator_list_crash_logs");
    expect(result.reports.map((r: { name: string }) => r.name)).toEqual([
      "Canopy-2026-10-08-232826.ips",
      "intelligencetasksd-2026-10-08-150617.ips",
      "Retired/Canopy-2026-10-02-213409.ips",
    ]);
    expect(result.reports[0]).toMatchObject({
      process: "Canopy",
      kind: "crash",
      udid: BOOTED_UDID,
      simulator: "iPhone 17 Pro",
    });
  });

  it("narrows to one simulator and one process", async () => {
    const dir = await reportsDir();
    const harness = await connect({ IOS_SIMULATOR_CRASH_REPORTS_DIR: dir });
    const mine = await harness.call("ios_simulator_list_crash_logs", { device: BOOTED_UDID });
    expect(mine.total).toBe(2);
    expect(mine.udid).toBe(BOOTED_UDID);
    const daemons = await harness.call("ios_simulator_list_crash_logs", {
      process: "intelligence",
    });
    expect(daemons.total).toBe(1);
    const none = await harness.call("ios_simulator_list_crash_logs", { kinds: ["jetsam"] });
    expect(none.total).toBe(0);
  });

  it("is empty, not an error, when the reports directory does not exist", async () => {
    const result = await (await connect()).call("ios_simulator_list_crash_logs");
    expect(result).toMatchObject({ isToolError: false, total: 0 });
  });

  it("summarises one report with the frames' images resolved", async () => {
    const dir = await reportsDir();
    const harness = await connect({ IOS_SIMULATOR_CRASH_REPORTS_DIR: dir });
    const result = await harness.call("ios_simulator_get_crash_log", {
      name: "Retired/Canopy-2026-10-02-213409.ips",
    });
    expect(result.isToolError).toBe(false);
    expect(result.path).toBe(join(dir, "Retired", "Canopy-2026-10-02-213409.ips"));
    expect(result.udid).toBe(BOOTED_UDID);
    expect(result.crash.faultingThread.frames[0]).toBe(
      "0 libswiftCore.dylib _assertionFailure(_:_:file:line:flags:) + 208",
    );
    // No application-specific message, so it says where a fatalError's went.
    expect(String(result.note)).toContain("capture_logs");
  });

  it("refuses names that leave the reports directory", async () => {
    const dir = await reportsDir();
    const harness = await connect({ IOS_SIMULATOR_CRASH_REPORTS_DIR: dir });
    for (const name of ["../secret.ips", "Retired/../../x.ips", "/etc/x.ips", "notes.txt"]) {
      const result = await harness.call("ios_simulator_get_crash_log", { name });
      expect(result.isToolError, name).toBe(true);
    }
  });

  it("will not read the Mac's own crash reports through a simulator tool", async () => {
    const dir = await reportsDir();
    const harness = await connect({ IOS_SIMULATOR_CRASH_REPORTS_DIR: dir });
    const result = await harness.call("ios_simulator_get_crash_log", {
      name: "Drakar-2026-10-08-174624.ips",
    });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("not from a simulator");
  });
});

describe("uninstall", () => {
  it("will not run without an explicit confirm", async () => {
    const log: ExecCall[] = [];
    const harness = await connect({}, { exec: execMock({ log }) });
    const result = await harness.call("ios_simulator_uninstall", { bundle_id: "io.mgcrea.Canopy" });
    expect(result.isToolError).toBe(true);
    expect(log.some((call) => call.args.includes("uninstall"))).toBe(false);
  });

  it("calls simctl uninstall with one concrete UDID", async () => {
    const log: ExecCall[] = [];
    const harness = await connect({}, { exec: execMock({ log }) });
    const result = await harness.call("ios_simulator_uninstall", {
      bundle_id: "io.mgcrea.Canopy",
      confirm: true,
    });
    expect(result).toMatchObject({ isToolError: false, uninstalled: "io.mgcrea.Canopy" });
    const call = log.find((c) => c.args.includes("uninstall"));
    expect(call?.args).toEqual(["simctl", "uninstall", BOOTED_UDID, "io.mgcrea.Canopy"]);
  });

  it("is marked destructive, so a host asks before it runs", async () => {
    const tool = (await (await connect()).tools()).find(
      (t) => t.name === "ios_simulator_uninstall",
    );
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });
});

describe("staging the environment", () => {
  it("maps each knob onto the right simctl call and reads the state back", async () => {
    const log: ExecCall[] = [];
    const result = await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_set_environment", {
      appearance: "dark",
      status_bar: { time: "9:41", battery_level: 100 },
    });
    const argv = log.map((call) => call.args.join(" "));
    expect(argv.some((a) => a.includes("ui") && a.includes("appearance dark"))).toBe(true);
    expect(argv.some((a) => a.includes("status_bar") && a.includes("--time 9:41"))).toBe(true);
    // Read back rather than echoed: `simctl ui` answers `unsupported` on a
    // runtime too old for a setting, and echoing the request would hide it.
    expect(result.state).toMatchObject({ appearance: "light" });
  });

  it("seeds the photo library, which is the way around the missing camera", async () => {
    const log: ExecCall[] = [];
    const result = await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_add_media", {
      paths: ["/fixtures/monstera.jpg", "/fixtures/clip.mov"],
    });
    expect(result.isToolError).toBe(false);
    // `addmedia` is variadic and takes plain argv, so unlike `push` there is no
    // temp file in the middle.
    const argv = log.map((call) => call.args.join(" "));
    expect(
      argv.some(
        (a) =>
          a.includes("addmedia") &&
          a.includes("/fixtures/monstera.jpg") &&
          a.includes("/fixtures/clip.mov"),
      ),
    ).toBe(true);
  });

  it("refuses a relative media path, which simctl answers unhelpfully", async () => {
    // simctl says "No such file or directory", which reads like a typo in the
    // filename rather than a statement about the working directory.
    const result = await (
      await connect()
    ).call("ios_simulator_add_media", {
      paths: ["./monstera.jpg"],
    });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("absolute");
  });

  it("refuses a status_bar with no fields rather than calling simctl with none", async () => {
    const result = await (
      await connect()
    ).call("ios_simulator_set_environment", {
      status_bar: {},
    });
    expect(result.isToolError).toBe(true);
  });

  it("wants a bundle id for grant, but not for reset", async () => {
    const harness = await connect();
    const denied = await harness.call("ios_simulator_set_environment", {
      permission: { action: "grant", service: "photos" },
    });
    expect(denied.isToolError).toBe(true);
    const reset = await harness.call("ios_simulator_set_environment", {
      permission: { action: "reset", service: "all" },
    });
    expect(reset.isToolError).toBe(false);
  });

  it("refuses a push with no aps key, and one over the APNs cap", async () => {
    const harness = await connect();
    const noAps = await harness.call("ios_simulator_push", {
      bundle_id: "io.mgcrea.Canopy",
      payload: { title: "hi" },
    });
    expect(String(noAps.error)).toContain("aps");

    const huge = await harness.call("ios_simulator_push", {
      bundle_id: "io.mgcrea.Canopy",
      payload: { aps: { alert: "x".repeat(5000) } },
    });
    expect(String(huge.error)).toContain("4096");
  });
});

describe("listing simulators", () => {
  it("leaves out the orphans nobody can use, and says how many it left out", async () => {
    const result = await (await connect()).call("ios_simulator_list");
    const rows = result.simulators as { available: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((sim) => sim.available !== false)).toBe(true);
    // Still answerable from here — the count and the fix stay in the result.
    expect(result.unavailable).toBeGreaterThan(0);
    expect(String(result.note)).toContain("include_unavailable");
  });

  it("brings them back, with the reason, when asked", async () => {
    const result = await (
      await connect()
    ).call("ios_simulator_list", {
      include_unavailable: true,
    });
    const rows = result.simulators as { available: boolean }[];
    expect(rows.some((sim) => sim.available === false)).toBe(true);
  });
});

describe("lifecycle", () => {
  it("will not erase without an explicit confirm", async () => {
    // The SDK rejects it against the schema, so the tool body never runs and
    // nothing reaches simctl — which is the guarantee worth asserting, rather
    // than the shape of the refusal.
    const log: ExecCall[] = [];
    const result = await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_erase", { device: BOOTED_UDID });
    expect(result.isToolError).toBe(true);
    expect(String(result.error)).toContain("confirm");
    expect(log.some((call) => call.args.includes("erase"))).toBe(false);
  });

  it("shuts a booted simulator down before erasing it, then boots it back", async () => {
    const log: ExecCall[] = [];
    const result = await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_erase", { device: BOOTED_UDID, confirm: true });
    const order = log
      .map((call) => call.args[1])
      .filter((verb) => verb === "shutdown" || verb === "erase" || verb === "boot");
    expect(order).toEqual(["shutdown", "erase", "boot"]);
    expect(result.rebooted).toBe(true);
  });

  it("opens DeviceHub when there is no Simulator.app, as on Xcode 27", async () => {
    const log: ExecCall[] = [];
    const result = await (
      await connect(
        {},
        {
          exec: execMock({
            log,
            failures: {
              "-a Simulator": {
                stderr: "Unable to find application named 'Simulator'",
                exitCode: 1,
              },
            },
          }),
        },
      )
    ).call("ios_simulator_power", { device: BOOTED_UDID, state: "booted", wait_ms: 0 });
    expect(result.isToolError).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(log.some((call) => call.args.join(" ") === "-b com.apple.dt.Devices")).toBe(true);
    // Never a URL: a devices:// form DeviceHub did not recognise made it quit,
    // which shuts every booted simulator down.
    expect(log.some((call) => call.args.some((arg) => arg.startsWith("devices://")))).toBe(false);
    expect(String(result.note)).toContain("select");
  });

  it("reports a window that will not open as a warning, not a failed boot", async () => {
    const result = await (
      await connect(
        {},
        {
          exec: execMock({
            failures: {
              "-a Simulator": {
                stderr: "Unable to find application named 'Simulator'",
                exitCode: 1,
              },
              "com.apple.dt.Devices": { stderr: "Unable to find application", exitCode: 1 },
            },
          }),
        },
      )
    ).call("ios_simulator_power", { device: BOOTED_UDID, state: "booted", wait_ms: 0 });
    expect(result.isToolError).toBe(false);
    expect(result.state).toBe("Booted");
    expect(String(result.warning)).toContain("no window could be opened");
  });

  it("does not boot a simulator implicitly, however unambiguous the target", async () => {
    const log: ExecCall[] = [];
    await (
      await connect({}, { exec: execMock({ log }) })
    ).call("ios_simulator_list_apps", {
      device: "appshot-iphone",
    });
    expect(log.some((call) => call.args.includes("boot"))).toBe(false);
  });
});

describe("the runner", () => {
  it("pins USE_PORT so a second simulator cannot silently take the taps", async () => {
    // WebDriverAgent scans 8100-8199 when USE_PORT is unset, so a second
    // runner comes up healthy on 8101 and a server pointed at 8100 drives the
    // wrong simulator while reporting success.
    const spawned: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const harness = await connect(
      { IOS_SIMULATOR_WDA_PORT: "8101" },
      { spawnRunner: spawnMock(spawned) },
    );
    const result = await harness.call("ios_simulator_restart_wda");
    expect(result.port).toBe(8101);
    expect(spawned[0]?.env["USE_PORT"]).toBe("8101");
    expect(spawned[0]?.env["IOS_SIMULATOR_ID"]).toBe(BOOTED_UDID);
  });
});

describe("diagnostics", () => {
  it("never throws, even when every command fails", async () => {
    const result = await (await connect({}, { exec: exploding })).call("ios_simulator_diagnostics");
    expect(result.isToolError).toBe(false);
    expect(result.ok).toBe(false);
    expect(String(result.nextSteps)).toContain("simctl list devices");
  });

  it("reports the two lanes separately, and counts rather than lists everything", async () => {
    const result = await (await connect({}, { fetch: refusing })).call("ios_simulator_diagnostics");
    expect(result.wda).toMatchObject({ reachable: false, port: 8100 });
    // A machine carries thirty-odd simulators; listing them all here cost more
    // context than the rest of the report put together.
    expect((result.simulators as unknown[]).length).toBeLessThanOrEqual(2);
    expect(result.counts).toMatchObject({ booted: 1 });
  });

  it("names the tool that starts the runner, not a shell command", async () => {
    const result = await (await connect({}, { fetch: refusing })).call("ios_simulator_diagnostics");
    // The reported failure: diagnostics diagnosed a dead runner perfectly and
    // then sent the reader out of the toolset to `npx … ios-simulator-wda run`,
    // which dies with the conversation. restart_wda spawns detached.
    expect(String(result.nextSteps)).toContain("ios_simulator_restart_wda");
    expect(String(result.nextSteps)).not.toContain("npx");
  });

  it("orders the boot before the runner, because the runner requires a booted one", async () => {
    const nothingBooted = DEVICES_JSON.replaceAll('"Booted"', '"Shutdown"');
    const result = await (
      await connect(
        {},
        { exec: execMock({ overrides: { "list devices": nothingBooted } }), fetch: refusing },
      )
    ).call("ios_simulator_diagnostics");
    const steps = result.nextSteps as string[];
    const boot = steps.findIndex((step) => step.includes("ios_simulator_power"));
    const runner = steps.findIndex((step) => step.includes("ios_simulator_restart_wda"));
    expect(boot).toBeGreaterThanOrEqual(0);
    expect(runner).toBeGreaterThan(boot);
    // Two independent bullets left the reader to discover the dependency by
    // hitting it; the runner step now says out loud that it comes second.
    expect(steps[runner]).toContain("once it is booted");
  });

  it("offers the shell recipe instead when the runner tool is not registered", async () => {
    const result = await (
      await connect({ IOS_SIMULATOR_ALLOW_WRITES: "0" }, { fetch: refusing })
    ).call("ios_simulator_diagnostics");
    expect(String(result.nextSteps)).toContain("wda.sh");
    expect(String(result.nextSteps)).not.toContain("ios_simulator_restart_wda");
  });

  it("counts the unavailable ones and says how to clear them", async () => {
    const result = await (await connect()).call("ios_simulator_diagnostics");
    expect((result.counts as { unavailable: number }).unavailable).toBeGreaterThan(0);
    expect(String(result.nextSteps)).toContain("delete unavailable");
  });
});

describe("simctl error envelopes", () => {
  it("pulls the human sentence out of a CoreSimulator error", () => {
    const parsed = parseSimctlError(
      "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\n" +
        "Unable to lookup in current state: Shutdown",
    );
    expect(parsed).toMatchObject({
      code: 405,
      message: "Unable to lookup in current state: Shutdown",
    });
  });

  it("falls back to the first line when there is no envelope", () => {
    expect(parseSimctlError("Invalid device: BOGUS").message).toBe("Invalid device: BOGUS");
  });
});

describe("configuration", () => {
  it("defaults writes ON, which is the one place this server differs from the fleet", () => {
    expect(loadConfig({}, ABSENT_CONFIG).allowWrites).toBe(true);
  });

  it("lets a one-off environment variable turn them off", () => {
    expect(loadConfig({ IOS_SIMULATOR_ALLOW_WRITES: "0" }, ABSENT_CONFIG).allowWrites).toBe(false);
  });

  it("treats an empty variable as unset rather than as an empty value", () => {
    expect(loadConfig({ IOS_SIMULATOR_ID: "  " }, ABSENT_CONFIG).simulatorId).toBeUndefined();
  });

  it("rejects an unknown key in the config file rather than ignoring it", () => {
    expect(() => loadConfig({ IOS_SIMULATOR_WDA_PORT: "9100" }, ABSENT_CONFIG)).not.toThrow();
    expect(loadConfig({ IOS_SIMULATOR_WDA_PORT: "9100" }, ABSENT_CONFIG).wdaPort).toBe(9100);
  });
});
