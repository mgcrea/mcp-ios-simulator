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
 * How to get the runner up. Much shorter than the device server's equivalent,
 * and that is the headline difference between the two: a simulator runner needs
 * no Apple team, no signing, no trust prompt and no tunnel.
 */
export const START_RUNNER_REMEDY =
  "Build and start the runner with `scripts/wda.sh setup` then `scripts/wda.sh run` (or " +
  "`npx -p @mgcrea/mcp-ios-simulator ios-simulator-wda run` from an npm install) and leave it " +
  "open — the HTTP server is the XCTest process, so it stops when that command does. It needs no " +
  "Apple Developer team: a simulator build is not signed.";

/** What to do when WebDriverAgent does not answer at all. */
export const WDA_UNAVAILABLE_REMEDY =
  `${START_RUNNER_REMEDY} Everything except ios_simulator_ui_tree and the input tools works ` +
  "without it — screenshots go through simctl. If something else already forwards the port, set " +
  "IOS_SIMULATOR_WDA_URL.";

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
