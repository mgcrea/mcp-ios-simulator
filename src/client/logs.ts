import { stat } from "node:fs/promises";

/**
 * The log captures this server has started, newest per simulator and app.
 *
 * Much less machinery than the device server's `ConsoleCaptures`, because on a
 * simulator nothing has to stay attached. `simctl launch --stdout/--stderr`
 * hands the redirect to the simulator's launchd and returns as soon as the app
 * is spawned; the app then writes its own file for as long as it runs. So there
 * is no child process to watch, to keep out of this server's signal group, or
 * to kill on exit — a capture is a path and a pid, and it outlives this server
 * without leaking anything.
 *
 * Whether it is still running is a question about the app's process, which on a
 * simulator is an ordinary process on this Mac: measured on an iOS 27.0
 * runtime, the pid `simctl launch` prints is a host pid owned by the user, and
 * `kill(pid, 0)` answers for it like for any other.
 */
export type Capture = {
  udid: string;
  simulatorName: string;
  bundleId: string;
  /** Where the file actually is on this Mac, which is not always where it was asked for. */
  path: string;
  pid: number | undefined;
  startedAt: string;
};

/** The liveness probe, as a seam: tests cannot rely on whichever pid is free on the machine. */
export type ProcessAlive = (pid: number) => boolean;

export const defaultProcessAlive: ProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a process that exists and belongs to someone else. Not one a
    // simulator app of this user's should ever be, but "alive" is the truthful
    // reading of it; only ESRCH means gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class LaunchCaptures {
  private readonly captures = new Map<string, Capture>();
  private latest: Capture | undefined;

  constructor(private readonly alive: ProcessAlive = defaultProcessAlive) {}

  private key(udid: string, bundleId: string): string {
    return `${udid}\u0000${bundleId}`;
  }

  /**
   * One capture per simulator and app. A relaunch replaces the record rather
   * than adding a second, so a read never has to choose between two files of
   * the same app — the older file stays on disk, it is just no longer "the" log.
   */
  record(capture: Capture): void {
    this.captures.set(this.key(capture.udid, capture.bundleId), capture);
    this.latest = capture;
  }

  find(udid: string | undefined, bundleId: string | undefined): Capture | undefined {
    if (udid && bundleId) return this.captures.get(this.key(udid, bundleId));
    const all = [...this.captures.values()].filter(
      (c) => (!udid || c.udid === udid) && (!bundleId || c.bundleId === bundleId),
    );
    if (all.length === 0) return undefined;
    return this.latest && all.includes(this.latest)
      ? this.latest
      : all.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  /**
   * Whether the app is still writing. A pid can be reused once the app exits,
   * and that is accepted: the cost of a false "running" is only that a final
   * half-written line waits for the next read.
   */
  running(capture: Capture): boolean {
    return capture.pid !== undefined && this.alive(capture.pid);
  }
}

/** True when `path` exists on this Mac. */
export const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );
