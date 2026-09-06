import { IosError } from "@mgcrea/mcp-ios-core";

export {
  CommandError,
  CommandTimeoutError,
  IosError,
  ToolchainError,
  WdaError,
  WdaUnavailableError,
} from "@mgcrea/mcp-ios-core";

/** Raising the budget, or noticing the simulator died mid-call. */
export const TIMEOUT_REMEDY =
  "Raise IOS_SIMULATOR_TIMEOUT_MS if this is a slow operation (a boot or a large `install` " +
  "genuinely takes tens of seconds), or check the simulator is still booted.";

export const TOOLCHAIN_REMEDY =
  "Install Xcode and run `xcode-select --install`, or point IOS_SIMULATOR_XCRUN_PATH at a " +
  "different xcrun.";

/**
 * How to get the runner up, from a shell.
 *
 * Much shorter than the device server's equivalent, and that is the headline
 * difference between the two: a simulator runner needs no Apple team, no
 * signing, no trust prompt and no tunnel.
 *
 * This is the *fallback*. It stays because it is the only route when writes are
 * off, and because it is what a person setting the server up for the first time
 * needs — but a remedy that sends a caller holding ios_simulator_restart_wda out
 * to a terminal is a remedy that wastes the tool it already has.
 */
export const START_RUNNER_SCRIPT_REMEDY =
  "Build and start the runner with `scripts/wda.sh setup` then `scripts/wda.sh run` (or " +
  "`npx -p @mgcrea/mcp-ios-simulator ios-simulator-wda run` from an npm install) and leave it " +
  "open — the HTTP server is the XCTest process, so it stops when that command does. It needs no " +
  "Apple Developer team: a simulator build is not signed.";

/** The same thing, done with this server's own tool. */
export const START_RUNNER_TOOL_REMEDY =
  "Start it with ios_simulator_restart_wda, which spawns the runner detached so it outlives this " +
  "conversation. Give it about fifteen seconds, then check ios_simulator_diagnostics for " +
  "`wda.reachable`.";

/**
 * How to get the runner up, in whichever way the caller can actually reach.
 *
 * `ios_simulator_restart_wda` is registered only when writes are on, so naming
 * it unconditionally would be the same mistake this fixes, pointed the other
 * way: a remedy naming a tool that is not in the list.
 */
export const startRunnerRemedy = (allowWrites: boolean): string =>
  allowWrites ? START_RUNNER_TOOL_REMEDY : START_RUNNER_SCRIPT_REMEDY;

/** What to do when WebDriverAgent does not answer at all. */
export const wdaUnavailableRemedy = (allowWrites: boolean): string =>
  `${startRunnerRemedy(allowWrites)} Everything except ios_simulator_ui_tree and the input ` +
  "tools works without it — screenshots go through simctl. If something else already forwards " +
  "the port, set IOS_SIMULATOR_WDA_URL.";

/** No simulator matched, or several did and none was named. */
export class SimulatorNotFoundError extends IosError {
  override readonly name = "SimulatorNotFoundError";

  constructor(message: string, remedy: string) {
    super(message, { remedy });
  }
}

/**
 * The simulator exists but is shut down.
 *
 * Its own error class because the fix is a single specific call and nothing
 * else: almost every simctl subcommand fails this way, `listapps` included, so
 * "it is shut down" would otherwise be buried in a CoreSimulator envelope that
 * reads like a lookup bug.
 */
export class SimulatorNotBootedError extends IosError {
  override readonly name = "SimulatorNotBootedError";

  constructor(name: string, udid: string) {
    super(`${name} is shut down.`, {
      remedy:
        `Boot it with ios_simulator_power {"simulator":"${udid}","state":"booted"} — this server ` +
        "never boots a simulator implicitly, because a cold boot takes tens of seconds and puts a " +
        "window on the user's screen.",
    });
  }
}

/**
 * The simulator's runtime is not installed, so CoreSimulator cannot service it.
 *
 * Worth its own class because the failure it prevents is not an error message
 * at all: `simctl io` against one of these aborts with an uncaught
 * NSInternalInconsistencyException and a thirty-line stack trace.
 */
export class RuntimeUnavailableError extends IosError {
  override readonly name = "RuntimeUnavailableError";

  constructor(name: string, reason: string | undefined) {
    super(`${name} is unavailable${reason ? `: ${reason}` : "."}`, {
      remedy:
        "The iOS runtime this simulator was created against is not installed. Install it in " +
        "Xcode > Settings > Components, or clear the orphans with `xcrun simctl delete unavailable`.",
    });
  }
}

/** Thrown when a write path is reached while IOS_SIMULATOR_ALLOW_WRITES is off. */
export class WritesDisabledError extends IosError {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} changes the simulator, but writes are disabled. ` +
        "Unset IOS_SIMULATOR_ALLOW_WRITES (it defaults to on) to enable them again.",
    );
  }
}

/** A shut-down simulator captures nothing, and that is the usual cause here. */
export const EMPTY_SCREENSHOT_REMEDY =
  "The simulator produced an empty capture. Check it is actually booted with " +
  "ios_simulator_diagnostics, and that its runtime is installed.";
