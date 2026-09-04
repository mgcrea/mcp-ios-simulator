import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoShellMetachars,
  createExec,
  type ExecImpl,
  type Logger,
} from "@mgcrea/mcp-ios-core";

import { IosError, TIMEOUT_REMEDY, TOOLCHAIN_REMEDY } from "#/client/errors";

/**
 * `xcrun simctl` — Apple's own simulator tool, and the half of this server that
 * needs nothing installed and nothing signed.
 *
 * It covers strictly more here than `devicectl` does on a physical device: app
 * lifecycle, but also the screen itself (`io screenshot`), the appearance, the
 * status bar, permissions, location and push. Only the accessibility tree and
 * synthetic touches need WebDriverAgent.
 *
 * Three output shapes, and knowing which is which explains the whole class:
 *
 *  - `list` takes `-j` and writes clean JSON to **stdout**. It is the only
 *    subcommand that does; `listapps --json` does not exist.
 *  - `listapps` writes an old-style NeXTSTEP plist. `plutil` converts it, but
 *    `ExecImpl` has no stdin, so it goes through a temp file and two processes.
 *  - everything else answers in prose, including `(null)` and `unknown`, which
 *    are passed through rather than normalised — see the readers below.
 */
export type SimctlOptions = {
  xcrunPath: string;
  plutilPath: string;
  timeoutMs: number;
  exec?: ExecImpl | undefined;
  logger?: Logger | undefined;
};

export type RawSim = {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  availabilityError?: string;
  deviceTypeIdentifier?: string;
  lastBootedAt?: string;
};

export type RawRuntime = {
  identifier: string;
  name?: string;
  version?: string;
  isAvailable?: boolean;
};

export type RawDeviceType = {
  identifier: string;
  name?: string;
  bundlePath?: string;
  modelIdentifier?: string;
};

/** One app as `listapps` reports it, once plutil has turned it into JSON. */
export type RawSimApp = {
  CFBundleIdentifier?: string;
  CFBundleDisplayName?: string;
  CFBundleName?: string;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string;
  ApplicationType?: string;
  Bundle?: string;
  Path?: string;
  DataContainer?: string;
};

/**
 * The two exit codes simctl actually uses, and what they mean.
 *
 * `148` is a device it could not even parse as an identifier. `149` is
 * everything else, wrapped in an envelope whose first line is machine-readable
 * and whose second line is the only part worth showing a person.
 */
const INVALID_DEVICE = 148;

/**
 * Pull the human sentence out of a CoreSimulator error envelope.
 *
 *   An error was encountered processing the command (domain=…, code=405):
 *   Unable to lookup in current state: Shutdown
 *
 * Without this the message a caller sees is the first line, which names a
 * numeric code and says nothing about what to do.
 */
export const parseSimctlError = (
  stderr: string,
): { domain?: string; code?: number; message: string } => {
  const envelope = /\(domain=([^,]+),\s*code=(\d+)\)\s*:?\s*\n?([\s\S]*)/.exec(stderr);
  if (envelope) {
    return {
      domain: envelope[1]?.trim(),
      code: Number(envelope[2]),
      message: (envelope[3] ?? "").trim().split("\n")[0]?.trim() ?? stderr.trim(),
    };
  }
  return { message: stderr.trim().split("\n")[0]?.trim() ?? stderr.trim() };
};

/**
 * simctl reports its interesting failures in prose, and each has a different
 * fix. Every string here describes something only a simulator has.
 */
const remedyFor = (stderr: string): string | undefined => {
  const { message } = parseSimctlError(stderr);
  const text = `${stderr} ${message}`.toLowerCase();
  if (text.includes("invalid device")) {
    return "That is not a UDID or a name simctl knows. Run ios_simulator_list to see what exists.";
  }
  if (text.includes("unable to lookup in current state: shutdown")) {
    return 'The simulator is shut down. Boot it with ios_simulator_power {"state":"booted"}.';
  }
  if (text.includes("current state: booted")) {
    return "The simulator is already booted, which for most operations means there is nothing to do.";
  }
  if (text.includes("no such file or directory")) {
    return (
      "Check the path exists and is a `.app` **bundle directory** built for the simulator — an " +
      "`.ipa` or a device build will not install, and reports exactly this."
    );
  }
  if (text.includes("failed to initialize io ports")) {
    return (
      "The simulator's runtime is not installed, so CoreSimulator cannot service it. Install the " +
      "runtime, or clear the orphans with `xcrun simctl delete unavailable`."
    );
  }
  return undefined;
};

/**
 * The one argument that must never reach simctl.
 *
 * `erase`, `delete` and `shutdown` all accept the literal string `all`, and
 * `simctl erase all` wipes every simulator on the machine. A device hint that
 * happens to be the word "all" is the single worst thing this server could
 * forward, so it is refused here as well as in the resolver — the resolver is
 * where it should be caught, and this is where it cannot be missed.
 */
export const assertNotBulkTarget = (udid: string): void => {
  if (udid === "all" || udid === "unavailable" || udid === "booted") {
    throw new IosError(`Refusing to pass "${udid}" to simctl as a device.`, {
      remedy:
        "simctl reads these as *every* matching simulator, so `erase all` would wipe the machine. " +
        "Resolve to one concrete UDID with ios_simulator_list first.",
    });
  }
};

export class Simctl {
  private readonly opts: SimctlOptions;
  private readonly exec: ExecImpl;
  /** Device types change only when Xcode is updated; re-reading is pure cost. */
  private deviceTypes: RawDeviceType[] | undefined;

  constructor(opts: SimctlOptions) {
    this.opts = opts;
    this.exec =
      opts.exec ?? createExec({ timeout: TIMEOUT_REMEDY, toolchain: TOOLCHAIN_REMEDY, remedyFor });
  }

  /** Raw stdout, for the subcommands that answer in prose. */
  private async run(args: string[]): Promise<string> {
    this.opts.logger?.debug?.("simctl", ...args);
    const { stdout } = await this.exec(
      this.opts.xcrunPath,
      ["simctl", ...args],
      this.opts.timeoutMs,
    );
    return stdout;
  }

  /**
   * `list` and only `list`. `-e` stops `/` being escaped as `\/`, which matters
   * only for fixture readability but costs nothing.
   */
  private async runJson<T>(args: string[]): Promise<T> {
    const stdout = await this.run([...args, "-j", "-e"]);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new IosError(`simctl ${args.join(" ")} did not return JSON.`, {
        details: stdout.slice(0, 400),
      });
    }
  }

  /**
   * A NeXTSTEP plist, via `plutil` and a temp file.
   *
   * The obvious `simctl listapps … | plutil -convert json -o - -` is not
   * expressible: `ExecImpl` takes argv and no stdin, deliberately, because that
   * is what keeps every caller value data rather than shell syntax. So simctl's
   * stdout is written out and handed to plutil by path. A fresh directory per
   * call rather than a shared one, so two concurrent tools cannot read each
   * other's answer with nothing looking wrong.
   */
  private async runPlist<T>(args: string[]): Promise<T> {
    const stdout = await this.run(args);
    const dir = await mkdtemp(join(tmpdir(), "simctl-"));
    const path = join(dir, "out.plist");
    try {
      await writeFile(path, stdout);
      const { stdout: json } = await this.exec(
        this.opts.plutilPath,
        ["-convert", "json", "-o", "-", path],
        this.opts.timeoutMs,
      );
      return JSON.parse(json) as T;
    } catch (err) {
      if (err instanceof IosError) throw err;
      throw new IosError(`Could not read simctl ${args[0]} output as a property list.`, {
        details: stdout.slice(0, 400),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ list --

  async listDevices(): Promise<Record<string, RawSim[]>> {
    const result = await this.runJson<{ devices?: Record<string, RawSim[]> }>(["list", "devices"]);
    return result.devices ?? {};
  }

  async listRuntimes(): Promise<RawRuntime[]> {
    return (await this.runJson<{ runtimes?: RawRuntime[] }>(["list", "runtimes"])).runtimes ?? [];
  }

  async listDeviceTypes(): Promise<RawDeviceType[]> {
    this.deviceTypes ??=
      (await this.runJson<{ devicetypes?: RawDeviceType[] }>(["list", "devicetypes"]))
        .devicetypes ?? [];
    return this.deviceTypes;
  }

  // ------------------------------------------------------------- lifecycle --

  async boot(udid: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["boot", udid]);
  }

  async shutdown(udid: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["shutdown", udid]);
  }

  async erase(udid: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["erase", udid]);
  }

  /** Attach the Simulator UI to whatever is booted. A `boot` alone is headless. */
  async openApp(openPath: string): Promise<void> {
    await this.exec(openPath, ["-a", "Simulator"], this.opts.timeoutMs);
  }

  // ------------------------------------------------------------------ apps --

  async listApps(udid: string): Promise<Record<string, RawSimApp>> {
    assertNotBulkTarget(udid);
    return this.runPlist<Record<string, RawSimApp>>(["listapps", udid]);
  }

  async install(udid: string, appPath: string): Promise<void> {
    assertNotBulkTarget(udid);
    assertNoShellMetachars("path", appPath);
    await this.run(["install", udid, appPath]);
  }

  /**
   * Launch, optionally replacing a running copy.
   *
   * Environment variables do not go on the command line: simctl reads them from
   * its **own** environment under a `SIMCTL_CHILD_` prefix. `ExecImpl` pins a
   * minimal environment on purpose, so a caller wanting them has to say so, and
   * this is where that would be threaded through.
   */
  async launch(
    udid: string,
    bundleId: string,
    opts: { args?: string[]; terminateExisting?: boolean; stdout?: string; stderr?: string } = {},
  ): Promise<string> {
    assertNotBulkTarget(udid);
    const flags = [
      ...(opts.terminateExisting ? ["--terminate-running-process"] : []),
      ...(opts.stdout ? [`--stdout=${opts.stdout}`] : []),
      ...(opts.stderr ? [`--stderr=${opts.stderr}`] : []),
    ];
    return this.run(["launch", ...flags, udid, bundleId, ...(opts.args ?? [])]);
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["terminate", udid, bundleId]);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["openurl", udid, url]);
  }

  // ---------------------------------------------------------------- screen --

  /**
   * A PNG of the screen, base64, with no WebDriverAgent involved.
   *
   * The documented `-` for stdout **does not work**: measured on Xcode 26.6, it
   * writes a file literally named `-` into the current working directory and
   * leaves stdout empty, exit code 0. So this passes a real path, like the
   * device lane's `--json-output` does, and for the same reason uses a fresh
   * directory per call.
   *
   * A successful capture also writes a `Note: No display specified…` line to
   * stderr, so non-empty stderr is not a failure here.
   */
  async screenshotPng(udid: string): Promise<string> {
    assertNotBulkTarget(udid);
    const dir = await mkdtemp(join(tmpdir(), "simshot-"));
    const path = join(dir, "shot.png");
    try {
      await this.run(["io", udid, "screenshot", "--type=png", path]);
      return (await readFile(path)).toString("base64");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ----------------------------------------------------------- environment --

  /**
   * Read a `simctl ui` option.
   *
   * `unknown` and `unsupported` are passed through rather than normalised: they
   * mean genuinely different things — the runtime is too old, versus it failed
   * to read — and collapsing them throws away a distinction a caller can act on.
   */
  async uiGet(udid: string, option: string): Promise<string> {
    assertNotBulkTarget(udid);
    return (await this.run(["ui", udid, option])).trim();
  }

  async uiSet(udid: string, option: string, value: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["ui", udid, option, value]);
  }

  async statusBarOverride(udid: string, flags: string[]): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["status_bar", udid, "override", ...flags]);
  }

  async statusBarClear(udid: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["status_bar", udid, "clear"]);
  }

  async statusBarList(udid: string): Promise<string> {
    assertNotBulkTarget(udid);
    return (await this.run(["status_bar", udid, "list"])).trim();
  }

  async locationSet(udid: string, latitude: number, longitude: number): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["location", udid, "set", `${latitude},${longitude}`]);
  }

  async locationClear(udid: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["location", udid, "clear"]);
  }

  /** `grant` and `revoke` need a bundle id; `reset` does not. */
  async privacy(udid: string, action: string, service: string, bundleId?: string): Promise<void> {
    assertNotBulkTarget(udid);
    await this.run(["privacy", udid, action, service, ...(bundleId ? [bundleId] : [])]);
  }

  /**
   * A simulated remote push. The payload goes through a temp file rather than
   * stdin, for the same argv-only reason as the plist lane.
   */
  async push(udid: string, bundleId: string, payload: unknown): Promise<void> {
    assertNotBulkTarget(udid);
    const dir = await mkdtemp(join(tmpdir(), "simpush-"));
    const path = join(dir, "payload.json");
    try {
      await writeFile(path, JSON.stringify(payload));
      await this.run(["push", udid, bundleId, path]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export { INVALID_DEVICE };
