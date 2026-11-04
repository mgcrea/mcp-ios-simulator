import type { ExecImpl } from "@mgcrea/mcp-ios-core";

/**
 * One TCP listener in the runner port range, and the simulator it runs inside
 * when it runs inside one.
 *
 * `udid` is absent for anything on the host — a dev server that happens to sit
 * on 8100 is still worth knowing about, because a runner cannot bind there.
 */
export type RunnerListener = { pid: number; port: number; udid?: string };

/** WebDriverAgent's own scan range when `USE_PORT` is unset (FBConfiguration.m). */
export const WDA_DEFAULT_PORT = 8100;
export const WDA_PORT_SPAN = 100;

/**
 * The ranges worth scanning: WebDriverAgent's default one, and the one this
 * server allocates from when IOS_SIMULATOR_WDA_PORT moves it elsewhere.
 */
export const runnerRanges = (basePort: number): [number, number][] => {
  const ranges: [number, number][] = [[WDA_DEFAULT_PORT, WDA_DEFAULT_PORT + WDA_PORT_SPAN - 1]];
  if (basePort < WDA_DEFAULT_PORT || basePort >= WDA_DEFAULT_PORT + WDA_PORT_SPAN) {
    ranges.push([basePort, Math.min(65535, basePort + WDA_PORT_SPAN - 1)]);
  }
  return ranges;
};

/**
 * `lsof -F pn` output: a `p<pid>` line opens each process, then one `n<addr>`
 * line per socket. A runner listening on both stacks shows up twice.
 */
export const parseLsof = (stdout: string): { pid: number; port: number }[] => {
  const seen = new Set<string>();
  const out: { pid: number; port: number }[] = [];
  let pid: number | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) ? value : undefined;
    } else if (line.startsWith("n") && pid !== undefined) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (!Number.isInteger(port)) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, port });
    }
  }
  return out;
};

/**
 * `ps -Eww -o pid=,command=` output, one process per line with its environment
 * appended. Every process inside a simulator carries `SIMULATOR_UDID`.
 */
export const parsePsUdids = (stdout: string): Map<number, string> => {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1]);
    const udid = /SIMULATOR_UDID=([0-9A-Fa-f-]{36})/.exec(line)?.[1];
    if (Number.isInteger(pid) && udid) out.set(pid, udid);
  }
  return out;
};

/**
 * Every listener in the runner ranges, each attributed to its simulator.
 *
 * A simulator shares the host's network stack, so a runner's port is a host
 * port and nothing in WebDriverAgent's `/status` names the simulator behind it
 * — the process environment is the only reliable owner. Failure is an empty
 * list rather than an error: lsof exits 1 when nothing matches, and not knowing
 * who owns a port must degrade to the old fixed-port behaviour, not break
 * every UI call.
 */
export const scanRunners = async (
  exec: ExecImpl,
  basePort: number,
  timeoutMs = 5000,
): Promise<RunnerListener[]> => {
  let sockets: { pid: number; port: number }[];
  try {
    const args = ["-nP", "-sTCP:LISTEN", "-F", "pn"];
    for (const [from, to] of runnerRanges(basePort)) args.push(`-iTCP:${from}-${to}`);
    sockets = parseLsof((await exec("/usr/sbin/lsof", args, timeoutMs)).stdout);
  } catch {
    return [];
  }
  if (sockets.length === 0) return [];

  let udids = new Map<number, string>();
  try {
    const pids = [...new Set(sockets.map((s) => s.pid))].join(",");
    udids = parsePsUdids(
      (await exec("/bin/ps", ["-Eww", "-o", "pid=,command=", "-p", pids], timeoutMs)).stdout,
    );
  } catch {
    // The ports are still known to be taken, which is what allocation needs.
  }
  return sockets
    .map((s) => {
      const udid = udids.get(s.pid);
      return udid ? { ...s, udid } : s;
    })
    .toSorted((a, b) => a.port - b.port);
};

/** The first port from `basePort` up that nothing listens on. */
export const freePort = (listeners: RunnerListener[], basePort: number): number => {
  const taken = new Set(listeners.map((l) => l.port));
  for (let port = basePort; port < basePort + WDA_PORT_SPAN && port <= 65535; port++) {
    if (!taken.has(port)) return port;
  }
  return basePort;
};
