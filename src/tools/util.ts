import { createArgs, type ScreenNaming } from "@mgcrea/mcp-ios-core";

export {
  compact,
  fail,
  ok,
  okImage,
  okText,
  toFailure,
  wrap,
  wrapResult,
} from "@mgcrea/mcp-ios-core";
export type { ImageContent, TextContent, ToolResult } from "@mgcrea/mcp-ios-core";

/**
 * How the shared tools name themselves and each other in this server.
 *
 * `copy.target` is written out rather than derived: a simulator is picked by
 * UDID, by name, or by being the only booted one, and none of those is what the
 * device server's version of this sentence says. `names.listTargets` is
 * overridden for the same reason — `ios_simulator_list_devices` would be a
 * mouthful for a tool that lists simulators.
 */
export const SIMULATOR_NAMING: ScreenNaming = {
  prefix: "ios_simulator",
  title: "iOS Simulator",
  noun: "simulator",
  envPrefix: "IOS_SIMULATOR",
  names: { listTargets: "ios_simulator_list" },
  copy: {
    target:
      "Which simulator: its UDID or its name as shown by ios_simulator_list. Omit it when exactly " +
      "one is booted — that is the normal case, and IOS_SIMULATOR_ID pins it when it is not. " +
      "Unlike simctl's own `booted`, this never picks arbitrarily between two.",
  },
};

const args = createArgs(SIMULATOR_NAMING);

export const { bundleIdArg, confirmArg, detailArg, screenshotArg, settleArg, xArg, yArg } = args;

/**
 * The schema field is `device` in every tool here, shared and local alike.
 *
 * It looks odd next to a server called "simulator" and it is still the right
 * name: `simctl`'s own interface calls a simulator a device — `simctl list
 * devices`, and `<device>` in the usage line of every subcommand — so this is
 * Apple's word for the thing, and the `ios_simulator_` prefix already says
 * which kind. Mixing `simulator` here with the shared tools' `device` would be
 * worse than either alone.
 */
export const deviceArg = args.targetArg;
