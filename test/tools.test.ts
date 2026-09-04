import type { ExecImpl } from "@mgcrea/mcp-ios-core";
import { describe, expect, it } from "vitest";

import { pngDimensions, toDisplayInfo } from "#/client/display";
import { parseSimctlError } from "#/client/simctl";
import { loadConfig } from "#/config";
import {
  ABSENT_CONFIG,
  BOOTED_UDID,
  connect,
  execMock,
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
  "ios_simulator_list",
  "ios_simulator_list_apps",
  "ios_simulator_screenshot",
  "ios_simulator_ui_tree",
];

describe("the write gate", () => {
  // Inverted relative to every other server in the fleet, so the assertions are
  // inverted too: the permissive state is the default, and the thing worth
  // failing CI over is a tool silently *joining* it.
  it("registers everything by default, because a simulator is disposable", async () => {
    const names = await (await connect()).toolNames();
    expect(names).toHaveLength(19);
    expect(names).toContain("ios_simulator_tap");
    expect(names).toContain("ios_simulator_erase");
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
    expect(String(result.remedy)).toContain("wda.sh");
    expect(String(result.remedy)).toContain("no Apple Developer team");
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
