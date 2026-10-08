import { mkdtempSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommandError,
  TINY_PNG,
  wdaMock,
  type ExecImpl,
  type FetchLike,
} from "@mgcrea/mcp-ios-core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { ProcessAlive } from "#/client/logs";
import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";
import type { SpawnRunner } from "#/tools/runner";

export { TINY_PNG, wdaMock };
export type { FetchLike };

/**
 * A config path that cannot exist, passed on every `loadConfig` in the suite.
 * Without it a developer's real `~/.config/ios-simulator-mcp/config.json` leaks
 * into the run, and the suite passes on one machine and fails on another — or,
 * worse, the reverse.
 */
export const ABSENT_CONFIG = "/nonexistent/ios-simulator-mcp.json";

/**
 * The same for crash reports: without it the suite would read whatever this
 * Mac's own ~/Library/Logs/DiagnosticReports holds that day.
 */
export const ABSENT_REPORTS = "/nonexistent/DiagnosticReports";

/** A scratch directory per call, so no test reads another's launch logs. */
export const scratchDir = (): string => mkdtempSync(join(tmpdir(), "mcp-ios-simulator-test-"));

export const BOOTED_UDID = "C4AB4BE0-C0BC-436C-8C03-8F87330DFFA5";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(fixtures, name), "utf8");

/** Captured from a real machine, so the shapes are the shapes simctl actually emits. */
export const DEVICES_JSON = fixture("devices.json");
export const RUNTIMES_JSON = fixture("runtimes.json");
export const DEVICETYPES_JSON = fixture("devicetypes.json");
export const PROFILE_JSON = fixture("profile.json");

/**
 * A real `listapps` answer, in the old-style plist simctl actually returns.
 *
 * Trimmed to three apps but the *format* is untouched, because the format is
 * the trap: this is not JSON, `listapps --json` does not exist, and code that
 * assumes otherwise fails on a machine rather than in CI.
 */
export const LISTAPPS_PLIST = `{
    "com.apple.Maps" =     {
        ApplicationType = System;
        Bundle = "file:///Applications/Maps.app/";
        CFBundleDisplayName = Maps;
        CFBundleIdentifier = "com.apple.Maps";
        CFBundleName = Maps;
        CFBundleShortVersionString = "1.0";
        CFBundleVersion = "1.0";
    };
    "io.mgcrea.Canopy" =     {
        ApplicationType = User;
        Bundle = "file:///Users/x/Library/.../Canopy.app/";
        CFBundleDisplayName = Canopy;
        CFBundleIdentifier = "io.mgcrea.Canopy";
        CFBundleShortVersionString = "1.4.0";
        CFBundleVersion = "42";
        DataContainer = "file:///Users/x/Library/.../Data/Application/ABC/";
    };
}`;

/** What plutil turns the above into. The suite exercises both halves of that hop. */
export const LISTAPPS_JSON = JSON.stringify({
  "com.apple.Maps": {
    ApplicationType: "System",
    Bundle: "file:///Applications/Maps.app/",
    CFBundleDisplayName: "Maps",
    CFBundleIdentifier: "com.apple.Maps",
    CFBundleName: "Maps",
    CFBundleShortVersionString: "1.0",
    CFBundleVersion: "1.0",
  },
  "io.mgcrea.Canopy": {
    ApplicationType: "User",
    Bundle: "file:///Users/x/Library/.../Canopy.app/",
    CFBundleDisplayName: "Canopy",
    CFBundleIdentifier: "io.mgcrea.Canopy",
    CFBundleShortVersionString: "1.4.0",
    CFBundleVersion: "42",
    DataContainer: "file:///Users/x/Library/.../Data/Application/ABC/",
  },
});

export type ExecCall = { path: string; args: string[] };

export type ExecMockOptions = {
  /** Override one simctl subcommand's stdout, keyed by a substring of its argv. */
  overrides?: Record<string, string | (() => string)>;
  /** Make one subcommand fail, keyed the same way. */
  failures?: Record<string, { stderr: string; exitCode: number }>;
  log?: ExecCall[];
  /**
   * Where the simulator's own filesystem is. Set, `launch` redirects land under
   * it, as they do for a `/tmp` or `/var/folders` path on a real runtime;
   * unset, they land at the path given, as for one under `/Users`.
   */
  simulatorRoot?: string;
  /** What the launched app has written by the time `launch` returns. */
  launchOutput?: string;
};

/**
 * The process boundary, answering as simctl, plutil, sips, lsof and ps do.
 *
 * Dispatch is on argv rather than on a temp-file path, because unlike devicectl
 * simctl writes its answers to stdout — the only files in play are the ones
 * *this server* writes for plutil, for the screenshot and for a push payload,
 * and those are asserted rather than faked.
 */
export const execMock = (opts: ExecMockOptions = {}): ExecImpl => {
  const log = opts.log ?? [];
  return async (path, args) => {
    log.push({ path, args });
    const argv = args.join(" ");

    for (const [key, failure] of Object.entries(opts.failures ?? {})) {
      if (argv.includes(key)) {
        throw new CommandError(`\`simctl ${key}\` failed: ${failure.stderr}`, {
          command: `${path} ${argv}`,
          exitCode: failure.exitCode,
          details: failure.stderr,
        });
      }
    }
    for (const [key, value] of Object.entries(opts.overrides ?? {})) {
      if (argv.includes(key))
        return { stdout: typeof value === "function" ? value() : value, stderr: "" };
    }

    if (path.endsWith("sips")) {
      if (args.includes("-g")) {
        const file = args[args.length - 1] as string;
        const dims = file.endsWith(".png") ? [1206, 2622] : [402, 874];
        return { stdout: `/x\n  pixelWidth: ${dims[0]}\n  pixelHeight: ${dims[1]}\n`, stderr: "" };
      }
      const out = args[args.indexOf("--out") + 1] as string;
      await writeFile(out, Buffer.from(TINY_PNG, "base64"));
      return { stdout: "", stderr: "" };
    }

    if (path.endsWith("plutil")) {
      const file = args[args.length - 1] as string;
      // Two different plist reads go through plutil: the app list this server
      // just wrote out, and a device type's profile straight off disk.
      return { stdout: file.endsWith("profile.plist") ? PROFILE_JSON : LISTAPPS_JSON, stderr: "" };
    }

    if (path.endsWith("lsof") || path.endsWith("ps")) return { stdout: "", stderr: "" };

    if (args.includes("simctl") && args.includes("launch")) {
      // simctl opens the redirects as part of the spawn, before it returns, and
      // appends rather than truncates. Faked the same way, so the code that
      // goes looking for the file afterwards runs against a real file.
      const redirects = new Set(
        args
          .filter((arg) => arg.startsWith("--stdout=") || arg.startsWith("--stderr="))
          .map((arg) => arg.slice(arg.indexOf("=") + 1)),
      );
      for (const redirect of redirects) {
        const landed = opts.simulatorRoot
          ? join(opts.simulatorRoot, redirect.replace(/^\/private(?=\/)/, ""))
          : redirect;
        await mkdir(dirname(landed), { recursive: true });
        await appendFile(landed, opts.launchOutput ?? "");
      }
      // `launch [--flags] <udid> <bundle id> [app argv]`.
      const bundleId = args.slice(args.indexOf("launch") + 1).filter((a) => !a.startsWith("--"))[1];
      return { stdout: `${bundleId}: 4242\n`, stderr: "" };
    }

    if (argv.includes("list devices")) return { stdout: DEVICES_JSON, stderr: "" };
    if (argv.includes("list runtimes")) return { stdout: RUNTIMES_JSON, stderr: "" };
    if (argv.includes("list devicetypes")) return { stdout: DEVICETYPES_JSON, stderr: "" };
    if (argv.includes("listapps")) return { stdout: LISTAPPS_PLIST, stderr: "" };
    if (argv.includes("io ") && argv.includes("screenshot")) {
      // simctl writes the capture to the path it was given — the documented `-`
      // for stdout does not work, and a mock that returned bytes would hide it.
      const target = args[args.length - 1] as string;
      await writeFile(target, Buffer.from(TINY_PNG, "base64"));
      return { stdout: "", stderr: "Note: No display specified. Defaulting to display: …" };
    }
    if (argv.includes("ui ") && argv.includes("appearance"))
      return { stdout: "light\n", stderr: "" };
    if (argv.includes("ui ") && argv.includes("content_size"))
      return { stdout: "medium\n", stderr: "" };
    if (argv.includes("status_bar") && argv.includes("list")) {
      return { stdout: "Current Status Bar Overrides:\n====\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
};

/** Records what would have been spawned, and starts nothing. */
export const spawnMock =
  (log: { command: string; args: string[]; env: Record<string, string> }[] = []): SpawnRunner =>
  async (command, args, { env }) => {
    log.push({ command, args, env });
    return 4242;
  };

export const connect = async (
  env: Record<string, string> = {},
  opts: {
    exec?: ExecImpl;
    fetch?: FetchLike;
    spawnRunner?: SpawnRunner;
    processAlive?: ProcessAlive;
  } = {},
) => {
  const config: Config = loadConfig(
    {
      IOS_SIMULATOR_OUTPUT_DIR: scratchDir(),
      IOS_SIMULATOR_CRASH_REPORTS_DIR: ABSENT_REPORTS,
      ...env,
    },
    ABSENT_CONFIG,
  );
  const { server, client } = createServer({
    config,
    exec: opts.exec ?? execMock(),
    fetch: (opts.fetch ?? wdaMock()) as unknown as typeof fetch,
    // Defaulted, never optional: a test that reached the real one would leave an
    // xcodebuild running on whoever ran the suite.
    spawnRunner: opts.spawnRunner ?? spawnMock(),
    // Never a real kill(2): pid 4242 may well be something on this machine.
    processAlive: opts.processAlive ?? (() => true),
  });

  // Both halves of a linked pair must come from the *same* package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  return {
    client,
    config,
    toolNames: async (): Promise<string[]> =>
      (await mcp.listTools()).tools.map((t) => t.name).toSorted(),
    tools: async () => (await mcp.listTools()).tools,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      let res;
      try {
        res = await mcp.callTool({ name, arguments: args });
      } catch (err) {
        // A schema violation is rejected by the SDK at the protocol layer and
        // never reaches the tool body — which is the behaviour we want, so the
        // harness reports it rather than failing to parse it.
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const content = res.content as { type: string; text?: string }[];
      const text = content.find((p) => p.type === "text")?.text ?? "{}";
      const image = content.find((p) => p.type === "image");
      try {
        return {
          ...JSON.parse(text),
          isToolError: res.isError === true,
          hasImage: image !== undefined,
        };
      } catch {
        return { isToolError: res.isError === true, error: text, hasImage: image !== undefined };
      }
    },
  };
};
