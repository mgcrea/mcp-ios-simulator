import {
  createExec,
  WdaClient,
  type DisplayInfo,
  type ExecImpl,
  type Logger,
  type ScreenHost,
} from "@mgcrea/mcp-ios-core";

import { pngDimensions, readScreenProfile, toDisplayInfo } from "#/client/display";
import {
  RuntimeUnavailableError,
  SimulatorNotBootedError,
  SimulatorNotFoundError,
  startRunnerRemedy,
  TIMEOUT_REMEDY,
  TOOLCHAIN_REMEDY,
  wdaUnavailableRemedy,
} from "#/client/errors";
import { summarizeDevices, type SimulatorSummary } from "#/client/shape";
import { Simctl } from "#/client/simctl";

/**
 * What to say when WebDriverAgent fails, on a simulator.
 *
 * A function of the write gate rather than a constant: three of these four
 * remedies name ios_simulator_restart_wda, and that tool is not registered when
 * writes are off. Sending a caller to a tool it cannot see is the same failure
 * as sending it to a shell it did not need.
 */
const simulatorWdaRemedies = (allowWrites: boolean) => ({
  unavailable: wdaUnavailableRemedy(allowWrites),
  notAuthorized:
    "WebDriverAgent is running but is refusing to drive the UI. On a simulator there is no " +
    "Enable UI Automation toggle to blame, so this is nearly always a stale runner. " +
    startRunnerRemedy(allowWrites),
  noForegroundApp:
    "WebDriverAgent can see no foreground application on a session it has just created. Launch " +
    `the app with ios_simulator_launch, or restart the runner. ${startRunnerRemedy(allowWrites)}`,
  noSuchElement:
    "Call ios_simulator_ui_tree to see what is actually on screen — the element may not have " +
    "appeared yet.",
});

export type SimulatorClientOptions = {
  xcrunPath: string;
  sipsPath: string;
  plutilPath: string;
  openPath: string;
  execTimeoutMs: number;
  wdaTimeoutMs: number;
  wdaPort: number;
  wdaUrl?: string | undefined;
  /** Only so the WebDriverAgent remedies can name a tool this server registers. */
  allowWrites?: boolean | undefined;
  defaultSimulatorId?: string | undefined;
  exec?: ExecImpl | undefined;
  fetch?: typeof fetch | undefined;
  logger?: Logger | undefined;
};

export class SimulatorClient implements ScreenHost<SimulatorSummary> {
  readonly simctl: Simctl;
  readonly exec: ExecImpl;
  readonly sipsPath: string;
  readonly plutilPath: string;
  readonly openPath: string;
  readonly execTimeoutMs: number;
  private readonly opts: SimulatorClientOptions;
  private readonly wdaClients = new Map<string, WdaClient>();
  /** `simctl list` is ~80ms and most tools want it twice; 2s collapses that. */
  private cache: { at: number; simulators: SimulatorSummary[] } | undefined;
  private profiles = new Map<string, Awaited<ReturnType<typeof readScreenProfile>>>();

  constructor(opts: SimulatorClientOptions) {
    this.opts = opts;
    this.exec = opts.exec ?? createExec({ timeout: TIMEOUT_REMEDY, toolchain: TOOLCHAIN_REMEDY });
    this.sipsPath = opts.sipsPath;
    this.plutilPath = opts.plutilPath;
    this.openPath = opts.openPath;
    this.execTimeoutMs = opts.execTimeoutMs;
    this.simctl = new Simctl({
      xcrunPath: opts.xcrunPath,
      plutilPath: opts.plutilPath,
      timeoutMs: opts.execTimeoutMs,
      ...(opts.exec ? { exec: opts.exec } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  }

  async listSimulators(opts: { fresh?: boolean } = {}): Promise<SimulatorSummary[]> {
    const cached = this.cache;
    if (!opts.fresh && cached && Date.now() - cached.at < 2000) return cached.simulators;
    const [devices, runtimes, deviceTypes] = await Promise.all([
      this.simctl.listDevices(),
      this.simctl.listRuntimes(),
      this.simctl.listDeviceTypes(),
    ]);
    const simulators = summarizeDevices(devices, runtimes, deviceTypes);
    this.cache = { at: Date.now(), simulators };
    return simulators;
  }

  /**
   * Resolve a hint to exactly one simulator, or refuse.
   *
   * The device server's rule — never guess between two — transfers, but
   * "connected" has to become the right predicate. A typical machine carries
   * dozens of simulators, most of them shut down and some of them unavailable,
   * so the population is mostly non-candidates.
   *
   * Three things happen here that cannot happen further down:
   *
   *  - `all` and `unavailable` are refused outright. `simctl erase all` wipes
   *    every simulator on the machine, and a hint is a string from a model.
   *  - `booted` is resolved *here* rather than passed through. simctl's own
   *    documentation says that with several booted it "will choose one of
   *    them", and a coin flip that drives the wrong screen most of the time is
   *    exactly what the refuse-to-guess rule exists to prevent.
   *  - availability is checked before the target is returned, because `simctl
   *    io` against an unavailable simulator aborts with an uncaught
   *    NSInternalInconsistencyException rather than failing.
   *
   * State is deliberately *not* checked: `ios_simulator_list` and
   * `ios_simulator_diagnostics` are useful against a shut-down simulator, so
   * requiring booted is each tool's decision, via `requireBooted`.
   */
  async resolveTarget(hint?: string): Promise<SimulatorSummary> {
    const wanted = hint ?? this.opts.defaultSimulatorId;
    const simulators = await this.listSimulators();

    if (wanted === "all" || wanted === "unavailable") {
      throw new SimulatorNotFoundError(
        `"${wanted}" is not a simulator, it is how simctl says *every* simulator.`,
        "Name one by UDID or by name. `simctl erase all` would wipe the machine, so this server " +
          "refuses to forward it.",
      );
    }

    const usable = simulators.filter((sim) => sim.available);
    if (wanted !== undefined && wanted !== "booted") {
      const byUdid = simulators.filter((sim) => sim.id.toLowerCase() === wanted.toLowerCase());
      // A name is ambiguous far more often than a UDID: the same device name
      // exists once per runtime, and the orphans of an uninstalled runtime keep
      // theirs. Prefer the ones that can actually be used, so "iPhone 17 Pro"
      // resolves to the real one rather than erroring against a dead 26.3 twin.
      const named = simulators.filter((sim) => sim.name === wanted);
      const byName = named.some((sim) => sim.available)
        ? named.filter((sim) => sim.available)
        : named;
      const matches = byUdid.length > 0 ? byUdid : byName;
      if (matches.length === 0) {
        throw new SimulatorNotFoundError(
          `No simulator matches "${wanted}".`,
          simulators.length === 0
            ? "simctl knows about no simulators at all. Install a runtime in Xcode > Settings > Components."
            : `Run ios_simulator_list to see them. ${usable.length} of ${simulators.length} are available.`,
        );
      }
      if (matches.length > 1) {
        throw new SimulatorNotFoundError(
          `${matches.length} simulators are named "${wanted}".`,
          `Pass a UDID instead: ${matches.map((sim) => `${sim.name} = ${sim.id}`).join(", ")}.`,
        );
      }
      return this.assertAvailable(matches[0] as SimulatorSummary);
    }

    const booted = usable.filter((sim) => sim.state === "Booted");
    if (booted.length === 1) return this.assertAvailable(booted[0] as SimulatorSummary);
    if (booted.length === 0) {
      const candidates = usable
        .slice(0, 6)
        .map((sim) => `${sim.name} = ${sim.id}`)
        .join(", ");
      throw new SimulatorNotFoundError(
        "No simulator is booted.",
        usable.length === 0
          ? "No simulator on this machine has an installed runtime. Install one in Xcode > Settings > Components."
          : `Boot one with ios_simulator_power, e.g. ${candidates}.`,
      );
    }
    throw new SimulatorNotFoundError(
      `${booted.length} simulators are booted, so there is no obvious default.`,
      `Pass \`simulator\` (or set IOS_SIMULATOR_ID) to one of: ${booted
        .map((sim) => `${sim.name} = ${sim.id}`)
        .join(", ")}.`,
    );
  }

  private assertAvailable(sim: SimulatorSummary): SimulatorSummary {
    if (!sim.available) throw new RuntimeUnavailableError(sim.name, sim.unavailableReason);
    return sim;
  }

  /** Every tool that needs a running simulator calls this; the resolver does not. */
  requireBooted(sim: SimulatorSummary): SimulatorSummary {
    if (sim.state !== "Booted") throw new SimulatorNotBootedError(sim.name, sim.id);
    return sim;
  }

  /**
   * Geometry. Cached per device *type* rather than per simulator, since that is
   * what the profile describes and it changes only when Xcode does.
   */
  async display(target: SimulatorSummary, capturePng?: string): Promise<DisplayInfo> {
    const id = target.deviceTypeIdentifier;
    let profile = id ? this.profiles.get(id) : undefined;
    if (!profile) {
      const deviceType = (await this.simctl.listDeviceTypes()).find((t) => t.identifier === id);
      profile = deviceType
        ? await readScreenProfile(deviceType, {
            plutilPath: this.plutilPath,
            exec: this.exec,
            timeoutMs: this.execTimeoutMs,
          })
        : {};
      if (id) this.profiles.set(id, profile);
    }
    const capture = capturePng ? pngDimensions(Buffer.from(capturePng, "base64")) : undefined;
    return toDisplayInfo(profile, capture);
  }

  /** The capture lane that needs no runner — the whole reason this server is cheap to start. */
  async screenshotPng(target: SimulatorSummary): Promise<string> {
    this.requireBooted(target);
    return this.simctl.screenshotPng(target.id);
  }

  /**
   * Where WebDriverAgent is.
   *
   * Unlike the device lane there is no tunnel address to derive: a simulator
   * shares the host's network stack, so the runner's port *is* a host loopback
   * port. That is also the trap — several booted simulators contend for the
   * same one, and WebDriverAgent scans 8100-8199 when `USE_PORT` is unset, so a
   * second runner comes up healthy on 8101 and a server pointed at 8100 drives
   * the first simulator while reporting success. `ios_simulator_diagnostics`
   * reports which simulator actually owns the port.
   */
  wdaUrl(): string {
    return this.opts.wdaUrl ?? `http://127.0.0.1:${this.opts.wdaPort}`;
  }

  get wdaPort(): number {
    return this.opts.wdaPort;
  }

  wda(_target: SimulatorSummary): WdaClient {
    const url = this.wdaUrl();
    const existing = this.wdaClients.get(url);
    if (existing) return existing;
    const client = new WdaClient({
      baseUrl: async () => url,
      timeoutMs: this.opts.wdaTimeoutMs,
      remedies: simulatorWdaRemedies(this.opts.allowWrites !== false),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
    });
    this.wdaClients.set(url, client);
    return client;
  }
}
