import type { DisplayInfo } from "@mgcrea/mcp-ios-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { startRunnerRemedy } from "#/client/errors";
import { toListRow, type SimulatorSummary } from "#/client/shape";
import type { SimulatorClient } from "#/client/simulator";
import type { ToolContext } from "#/tools/index";
import { deviceArg, wrap } from "#/tools/util";

export type Diagnosis = {
  ok: boolean;
  writes: "enabled" | "disabled";
  /**
   * The booted ones only, plus the target. A typical machine carries thirty-odd
   * simulators and listing them all here spent more of the context window than
   * the whole rest of the report — and none of them is what a diagnosis is
   * about. `counts` carries the shape of the rest; ios_simulator_list is there
   * for the full picture.
   */
  simulators: Record<string, unknown>[];
  counts: { total: number; booted: number; unavailable: number };
  target?: { udid: string; name: string; state: string; runtime: string };
  display?: DisplayInfo;
  wda: {
    url: string;
    port: number;
    reachable: boolean;
    /** Which simulator actually owns the port — the failure unique to this server. */
    boundTo?: string;
    state?: unknown;
    error?: string;
  };
  problems: string[];
  nextSteps: string[];
};

/**
 * Which simulator owns the WebDriverAgent port.
 *
 * This check has no device-server equivalent and it is the most valuable one
 * here. A simulator shares the host's network stack, so a runner's port is a
 * *host* port, and WebDriverAgent scans 8100-8199 when `USE_PORT` is unset. Two
 * booted simulators therefore give you a second runner answering healthily on
 * 8101 while a server pointed at 8100 drives the first one and reports success
 * on every call.
 *
 * Every process inside a simulator carries `SIMULATOR_UDID` in its environment,
 * and `ps -Eww` prints it, so the port's real owner is knowable rather than
 * assumed.
 */
const portOwner = async (client: SimulatorClient, port: number): Promise<string | undefined> => {
  try {
    const { stdout: pids } = await client.exec(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      5000,
    );
    const pid = pids.trim().split("\n")[0];
    if (!pid) return undefined;
    const { stdout: env } = await client.exec("/bin/ps", ["-Eww", "-p", pid], 5000);
    return /SIMULATOR_UDID=([0-9A-Fa-f-]{36})/.exec(env)?.[1];
  } catch {
    // lsof is not always installed and needs no permissions we can assume.
    // Not knowing the owner is a missing field, not a failure.
    return undefined;
  }
};

/**
 * The whole point of this tool is that **it never throws**. Every other tool
 * fails when nothing is booted, the runtime is missing or the runner is not up,
 * and each of those looks much like the others from the outside. This one
 * collects all of it as data and names which half is missing.
 */
export const diagnose = async (
  client: SimulatorClient,
  ctx: ToolContext,
  deviceHint?: string,
): Promise<Diagnosis> => {
  const problems: string[] = [];
  const nextSteps: string[] = [];
  const writes = ctx.allowWrites ? "enabled" : "disabled";

  let simulators: SimulatorSummary[] = [];
  try {
    simulators = await client.listSimulators({ fresh: true });
  } catch (err) {
    problems.push(`Could not list simulators: ${err instanceof Error ? err.message : String(err)}`);
    nextSteps.push(
      "Install Xcode and its command line tools, then run `xcrun simctl list devices`.",
    );
    return {
      ok: false,
      writes,
      simulators: [],
      counts: { total: 0, booted: 0, unavailable: 0 },
      wda: { url: client.wdaUrl(), port: client.wdaPort, reachable: false },
      problems,
      nextSteps,
    };
  }

  const booted = simulators.filter((sim) => sim.state === "Booted");
  const unavailable = simulators.filter((sim) => !sim.available);
  const counts = {
    total: simulators.length,
    booted: booted.length,
    unavailable: unavailable.length,
  };

  if (simulators.length === 0) {
    problems.push("simctl knows about no simulators at all.");
    nextSteps.push("Install a runtime: Xcode > Settings > Components.");
  } else if (booted.length === 0) {
    problems.push("No simulator is booted.");
    nextSteps.push(
      'Boot one with ios_simulator_power {"state":"booted"} — this server never boots implicitly.',
    );
  }
  const nothingBooted = simulators.length > 0 && booted.length === 0;

  let target: SimulatorSummary | undefined;
  try {
    target = await client.resolveTarget(deviceHint);
  } catch (err) {
    if (booted.length > 0) {
      problems.push(err instanceof Error ? err.message : String(err));
      const remedy = (err as { remedy?: string }).remedy;
      if (remedy) nextSteps.push(remedy);
    }
  }

  let display: DisplayInfo | undefined;
  if (target) {
    try {
      display = await client.display(target);
    } catch {
      // Geometry comes from the device type's profile.plist, so failing here
      // means the profile could not be read — worth a missing field, not a
      // failed report.
    }
  }

  // WebDriverAgent. `reachable` and usable coincide on a simulator: there is no
  // Enable UI Automation toggle, so the device server's separate `authorized`
  // probe would be pure latency. What replaces it is `boundTo`.
  const url = client.wdaUrl();
  const wda: Diagnosis["wda"] = { url, port: client.wdaPort, reachable: false };
  try {
    wda.state = await client.wda(target ?? ({ id: "", name: "" } as SimulatorSummary)).status();
    wda.reachable = true;
  } catch (err) {
    wda.error = err instanceof Error ? err.message : String(err);
    problems.push("WebDriverAgent is not answering, so the UI tree and the input tools will fail.");
    // Ordered, not merely listed. The runner tool calls `requireBooted`, so on a
    // machine with nothing booted the two steps above and below are one
    // sequence and running them the other way round cannot work — which the
    // previous pair of independent bullets did not say anywhere.
    nextSteps.push(
      (nothingBooted ? "Then, once it is booted: " : "") +
        startRunnerRemedy(ctx.allowWrites) +
        " Everything else — including screenshots — works without it.",
    );
  }

  if (wda.reachable) {
    const owner = await portOwner(client, client.wdaPort);
    if (owner) wda.boundTo = owner;
    if (owner && target && owner.toLowerCase() !== target.id.toLowerCase()) {
      const other = simulators.find((sim) => sim.id.toLowerCase() === owner.toLowerCase());
      problems.push(
        `Port ${client.wdaPort} is owned by ${other?.name ?? owner}, not ${target.name}. ` +
          "Every tap and every UI tree read would go to the wrong screen.",
      );
      nextSteps.push(
        "WebDriverAgent scans 8100-8199 when USE_PORT is unset, so a second simulator's runner " +
          "takes the next free port and nothing looks wrong. Give this one its own port with " +
          "IOS_SIMULATOR_WDA_PORT and start its runner with a matching USE_PORT.",
      );
    }
  }

  if (unavailable.length > 0) {
    nextSteps.push(
      `${unavailable.length} simulators have no installed runtime and cannot be used at all. ` +
        "`xcrun simctl delete unavailable` clears them.",
    );
  }

  return {
    ok: problems.length === 0,
    writes,
    simulators: [...booted, ...(target && target.state !== "Booted" ? [target] : [])].map(
      toListRow,
    ),
    counts,
    ...(target
      ? {
          target: {
            udid: target.id,
            name: target.name,
            state: target.state,
            runtime: target.runtime,
          },
        }
      : {}),
    ...(display ? { display } : {}),
    wda,
    problems,
    nextSteps,
  };
};

export const registerDiagnosticsTools = (
  server: McpServer,
  client: SimulatorClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "ios_simulator_diagnostics",
    {
      title: "iOS Simulator: Diagnostics",
      description:
        "Report both lanes separately and never fail: which simulators exist and which are " +
        "usable, which one this server would drive, its screen geometry, and whether " +
        "WebDriverAgent is answering — including *which* simulator owns its port, which is the " +
        "one way to catch a second runner quietly taking your taps. Start here when anything " +
        "else misbehaves.",
      inputSchema: z.object({ device: deviceArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ device }) => wrap(async () => diagnose(client, ctx, device)),
  );

  server.registerResource(
    "diagnostics",
    "ios-simulator://diagnostics",
    {
      title: "iOS Simulator diagnostics",
      description: "The same report as ios_simulator_diagnostics, as a resource.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await diagnose(client, ctx)),
        },
      ],
    }),
  );
};
