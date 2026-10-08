import { open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { crashKind, crashProcessName } from "@mgcrea/mcp-ios-core";

import { IosError } from "#/client/errors";

/**
 * Simulator crash reports, out of this Mac's own DiagnosticReports.
 *
 * A simulator app is a Mac process, so when it crashes the Mac's ReportCrash
 * writes the `.ips` — into `~/Library/Logs/DiagnosticReports`, older ones under
 * `Retired/`, mixed in with every Mac app's and daemon's. On the machine this
 * was written against that was 593 `.ips` files, 464 of them from simulators,
 * and nearly all of those were the simulators' own daemons rather than an app
 * anyone was debugging.
 *
 * Telling the two apart, as measured on Xcode 27.0 with an iOS 27.0 runtime:
 *
 * - The header line's `platform` is the Mach-O platform of the crashed binary.
 *   Every simulator report had 7 (`PLATFORM_IOSSIMULATOR` in
 *   `<mach-o/loader.h>`) and every Mac report had 1, with no exceptions either
 *   way. That is one line of a few hundred bytes, so it is the filter.
 * - The header's `is_simulated` is **not** the marker, despite the name: it
 *   was set on 13 reports, every one a Mac process with platform 1 — Safari,
 *   Mail and two of their helpers.
 * - `procPath` does not say either: it is anonymised to `/Volumes/VOLUME/…` or
 *   `/Users/USER/…` with the middle starred out, so no device path survives.
 * - Which simulator is in the report body, as `coalitionName`:
 *   `com.apple.CoreSimulator.SimDevice.<UDID>`. Its key ended by byte 1,731 in
 *   every one of the 464, so reading the first `HEAD_BYTES` finds it without
 *   parsing reports that run to 80 KB.
 */

/** `PLATFORM_*SIMULATOR` in `<mach-o/loader.h>`: iOS, tvOS, watchOS, visionOS. Only 7 was seen. */
const SIMULATOR_PLATFORMS = new Set([7, 8, 9, 12]);

/** Enough for the header and the body's `coalitionName`, with room to spare. */
const HEAD_BYTES = 8192;

const COALITION =
  /"coalitionName"\s*:\s*"com\.apple\.CoreSimulator\.SimDevice\.([0-9A-Fa-f-]{36})"/;

/** Opened at once. The directory holds hundreds of files; this keeps clear of EMFILE. */
const CONCURRENCY = 32;

export type CrashReportRow = {
  /** Relative to the reports directory, e.g. `Retired/Canopy-2026-10-02-213409.ips`. */
  name: string;
  process: string;
  bundleId: string | undefined;
  kind: string;
  /** As the report writes it, e.g. `2026-10-08 23:28:26.00 +0200`. */
  timestamp: string | undefined;
  /** The simulator it came from, when the body named one. */
  udid: string | undefined;
};

type Header = {
  platform?: number;
  bug_type?: string;
  app_name?: string;
  name?: string;
  bundleID?: string;
  timestamp?: string;
};

const readHead = async (path: string): Promise<string> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
};

const parseHeader = (text: string): Header | undefined => {
  const newline = text.indexOf("\n");
  try {
    return JSON.parse(newline === -1 ? text : text.slice(0, newline)) as Header;
  } catch {
    return undefined;
  }
};

/** `2026-10-08 23:28:26.00 +0200` → epoch ms, for ordering. File mtimes are not reliable here. */
const timestampMs = (value: string | undefined): number => {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{2})(\d{2})$/.exec(
    value ?? "",
  );
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : 0;
};

const listIps = async (dir: string): Promise<string[]> => {
  const top = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const retired = await readdir(join(dir, "Retired")).catch(() => []);
  return [
    ...top.filter((name) => name.endsWith(".ips")),
    ...retired.filter((name) => name.endsWith(".ips")).map((name) => `Retired/${name}`),
  ];
};

/**
 * Every simulator report in `dir`, newest first. Reads the first 8 KB of each
 * `.ips`, never the whole file, except to find the UDID in the rare report
 * whose `coalitionName` did not fit in that.
 */
export const listSimulatorCrashReports = async (dir: string): Promise<CrashReportRow[]> => {
  const names = await listIps(dir);
  const rows: CrashReportRow[] = [];
  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      names.slice(i, i + CONCURRENCY).map(async (name): Promise<CrashReportRow | undefined> => {
        const path = join(dir, name);
        const head = await readHead(path).catch(() => "");
        const header = parseHeader(head);
        if (!header || !SIMULATOR_PLATFORMS.has(Number(header.platform))) return undefined;
        let udid = COALITION.exec(head)?.[1];
        if (!udid) udid = COALITION.exec(await readFile(path, "utf8").catch(() => ""))?.[1];
        return {
          name,
          process: header.app_name || header.name || crashProcessName(name),
          bundleId: header.bundleID,
          kind: crashKind(header.bug_type),
          timestamp: header.timestamp,
          udid: udid?.toUpperCase(),
        };
      }),
    );
    for (const row of batch) if (row) rows.push(row);
  }
  return rows.toSorted((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));
};

/**
 * The absolute path of a report named by `ios_simulator_list_crash_logs`, or a
 * refusal. The schema already rejects `..` and absolute names; this is the
 * check that cannot be argued with, made on the resolved path.
 */
export const crashReportPath = (dir: string, name: string): string => {
  const root = resolve(dir);
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new IosError(`"${name}" is not inside the crash reports directory.`, {
      remedy: "Pass a `name` exactly as ios_simulator_list_crash_logs returned it.",
    });
  }
  return path;
};

/** Whether a report's header says it came from a simulator. */
export const isSimulatorReport = (text: string): boolean => {
  const header = parseHeader(text);
  return header !== undefined && SIMULATOR_PLATFORMS.has(Number(header.platform));
};

/** The simulator a full report came from, when its body says. */
export const reportUdid = (text: string): string | undefined =>
  COALITION.exec(text)?.[1]?.toUpperCase();
