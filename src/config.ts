import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * There are no credentials here, and unlike the device server there is barely
 * any setup either. Two lanes reach a simulator and both are local:
 *
 *   * `xcrun simctl` — Apple's own tool. It covers app lifecycle, the device's
 *     whole staged environment, and the screen itself: `simctl io screenshot`
 *     needs no runner at all.
 *   * WebDriverAgent — an HTTP server inside the simulator, on the *host's*
 *     loopback since a simulator shares the host network stack. Only the
 *     accessibility tree and synthetic touches go through it.
 */
const ConfigSchema = z
  .object({
    /**
     * UDID, name, or the literal `booted`. Left unset, a single booted
     * simulator is used and two or more is an error that names them, rather
     * than the coin flip simctl's own `booted` performs.
     */
    simulatorId: z.string().min(1).optional(),
    wdaUrl: z.url().optional(),
    /**
     * Must match the runner's `USE_PORT`. One port per simulator: they all bind
     * the same host loopback, so two runners on 8100 is a silent wrong-target
     * bug rather than a collision.
     */
    wdaPort: z.number().int().min(1).max(65535).default(8100),
    wdaTimeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
    /** A cold boot or a large `install` genuinely takes tens of seconds. */
    execTimeoutMs: z.number().int().min(1000).max(1_800_000).default(120_000),
    /**
     * **On by default**, which is the one place this server deliberately breaks
     * the fleet convention. What makes the device server read-only is that a
     * phone belongs to a real person; a simulator is disposable and holds
     * nobody's data. `ios_simulator_erase` still requires an explicit `confirm`
     * because it is the only irreversible tool here.
     */
    allowWrites: z.boolean().default(true),
    /** Applied by `launch` when the call passes no `arguments` of its own. */
    launchArgs: z.array(z.string()).default([]),
    /** Saved screenshots, launch logs and the runner log. */
    outputDir: z.string().min(1).default(join(tmpdir(), "mcp-ios-simulator")),
    maxTreeBytes: z.number().int().min(1000).max(500_000).default(24_000),
    xcrunPath: z.string().min(1).default("/usr/bin/xcrun"),
    sipsPath: z.string().min(1).default("/usr/bin/sips"),
    /** The `listapps` plist lane, and the device-type profile read. */
    plutilPath: z.string().min(1).default("/usr/bin/plutil"),
    /** `simctl boot` is headless; this is what attaches a window. */
    openPath: z.string().min(1).default("/usr/bin/open"),
  })
  .strict()
  .superRefine((_cfg, _ctx) => {
    // Deliberately NOT an error when there is no simulator and no Xcode. An MCP
    // server that exits on startup shows up in the client as a bare
    // "MCP error -32000: Connection closed" with stderr swallowed, so the one
    // message that would have explained the problem never reaches anyone.
    // ios_simulator_diagnostics reports all of it as data instead.
  });

export type Config = z.infer<typeof ConfigSchema>;

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  const n = Number(t);
  return Number.isInteger(n) ? n : undefined;
};

/** Whitespace-separated, so `IOS_SIMULATOR_LAUNCH_ARGS="-DemoMode -NoCloud"` works. */
const parseArgs = (value: string | undefined): string[] | undefined => {
  const t = trimmed(value);
  return t === undefined ? undefined : t.split(/\s+/);
};

export const defaultConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  trimmed(env.IOS_SIMULATOR_CONFIG) ??
  join(homedir(), ".config", "ios-simulator-mcp", "config.json");

/**
 * `.strict()` on purpose: a typo'd `wdaPort` spelled `wda_port` must be an
 * error. Silently ignoring an unknown key looks exactly like "that setting had
 * no effect", which is the worst possible way to learn where your config came
 * from.
 */
const readConfigFile = (path: string): Partial<Config> => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return ConfigSchema.partial().strict().parse(JSON.parse(raw)) as Partial<Config>;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * A one-off `IOS_SIMULATOR_ALLOW_WRITES=0` has to beat a file that says `true`,
 * while a file that sets `simulatorId` keeps working when the environment says
 * nothing about it. Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = defaultConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const pick = <K extends keyof Config>(
    fromEnv: Config[K] | undefined,
    key: K,
  ): Config[K] | undefined => fromEnv ?? file[key];

  return ConfigSchema.parse({
    simulatorId: pick(trimmed(env.IOS_SIMULATOR_ID), "simulatorId"),
    wdaUrl: pick(trimmed(env.IOS_SIMULATOR_WDA_URL), "wdaUrl"),
    wdaPort: pick(parseIntOpt(env.IOS_SIMULATOR_WDA_PORT), "wdaPort"),
    wdaTimeoutMs: pick(parseIntOpt(env.IOS_SIMULATOR_WDA_TIMEOUT_MS), "wdaTimeoutMs"),
    execTimeoutMs: pick(parseIntOpt(env.IOS_SIMULATOR_TIMEOUT_MS), "execTimeoutMs"),
    allowWrites: pick(parseBool(env.IOS_SIMULATOR_ALLOW_WRITES), "allowWrites"),
    launchArgs: pick(parseArgs(env.IOS_SIMULATOR_LAUNCH_ARGS), "launchArgs"),
    outputDir: pick(trimmed(env.IOS_SIMULATOR_OUTPUT_DIR), "outputDir"),
    maxTreeBytes: pick(parseIntOpt(env.IOS_SIMULATOR_MAX_TREE_BYTES), "maxTreeBytes"),
    xcrunPath: pick(trimmed(env.IOS_SIMULATOR_XCRUN_PATH), "xcrunPath"),
    sipsPath: pick(trimmed(env.IOS_SIMULATOR_SIPS_PATH), "sipsPath"),
    plutilPath: pick(trimmed(env.IOS_SIMULATOR_PLUTIL_PATH), "plutilPath"),
    openPath: pick(trimmed(env.IOS_SIMULATOR_OPEN_PATH), "openPath"),
  });
};
