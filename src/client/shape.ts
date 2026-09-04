// The context-window layer.
//
// `simctl listapps` spends ~38 KB on the 31 apps a stock simulator carries, 25
// of which are Apple's own, and most of every entry is group-container UUIDs no
// caller acts on. `list devices` is smaller but still reports five keys per
// simulator that only matter to CoreSimulator.
//
// So: lists return the few fields the other tools consume, and nothing else.

import type { RawDeviceType, RawRuntime, RawSim, RawSimApp } from "#/client/simctl";

export type SimulatorSummary = {
  /**
   * The UDID. Called `id` because that is the name the shared `ScreenHost`
   * contract uses — a physical device has two identifiers and a simulator has
   * one, so there is nothing here to disambiguate. Rendered back as `udid` by
   * `toListRow`, which is the word anyone reading the output will know it by.
   */
  id: string;
  name: string;
  /** `Booted` or `Shutdown`, verbatim from CoreSimulator. */
  state: string;
  runtime: string;
  deviceType: string | undefined;
  deviceTypeIdentifier: string | undefined;
  /**
   * False when the runtime is missing. Kept rather than filtered: "why can't I
   * use that one" has to be answerable from the list, and an unavailable
   * simulator is the one input that makes `simctl io` abort rather than fail.
   */
  available: boolean;
  unavailableReason?: string;
  lastBootedAt?: string;
};

/**
 * Flatten the runtime-keyed map `list devices` returns.
 *
 * The key is a runtime *identifier* and identifiers are not unique — a machine
 * carrying both iOS 26.4 and 26.4.1 has two entries under
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-4`. So the key is never used as a
 * primary key: it is joined against `list runtimes` for a display name, 0..n
 * matches tolerated, and carried through verbatim besides.
 */
export const summarizeDevices = (
  devices: Record<string, RawSim[]>,
  runtimes: RawRuntime[],
  deviceTypes: RawDeviceType[],
): SimulatorSummary[] => {
  const runtimeName = new Map(
    runtimes.map((r) => [r.identifier, r.name ?? r.version ?? r.identifier]),
  );
  const typeName = new Map(deviceTypes.map((t) => [t.identifier, t.name]));

  return Object.entries(devices).flatMap(([runtimeId, sims]) =>
    (sims ?? []).map((sim) => ({
      id: sim.udid,
      name: sim.name,
      state: sim.state,
      runtime: runtimeName.get(runtimeId) ?? runtimeId.split(".").pop() ?? runtimeId,
      deviceType: sim.deviceTypeIdentifier ? typeName.get(sim.deviceTypeIdentifier) : undefined,
      deviceTypeIdentifier: sim.deviceTypeIdentifier,
      available: sim.isAvailable !== false,
      ...(sim.availabilityError ? { unavailableReason: sim.availabilityError } : {}),
      ...(sim.lastBootedAt ? { lastBootedAt: sim.lastBootedAt } : {}),
    })),
  );
};

export type SimAppSummary = {
  bundleId: string;
  name: string | undefined;
  version: string | undefined;
  build: string | undefined;
  type: string | undefined;
  /**
   * Host filesystem paths, and the reason there is no `pull_container` tool: a
   * simulator's containers are already on this machine, so reading an app's
   * SwiftData store is an ordinary file read rather than a copy off a device.
   */
  bundlePath: string | undefined;
  dataContainer: string | undefined;
};

/** `file:///Users/…/Foo.app/` → `/Users/…/Foo.app`, which is what a person can use. */
const toPath = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  if (!url.startsWith("file://")) return url;
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
};

export const summarizeApps = (
  apps: Record<string, RawSimApp>,
  opts: { includeAll?: boolean } = {},
): SimAppSummary[] =>
  Object.values(apps)
    .filter((app) => opts.includeAll === true || app.ApplicationType === "User")
    .map((app) => ({
      bundleId: app.CFBundleIdentifier ?? "",
      name: app.CFBundleDisplayName ?? app.CFBundleName,
      version: app.CFBundleShortVersionString,
      build: app.CFBundleVersion,
      type: app.ApplicationType,
      bundlePath: toPath(app.Bundle ?? app.Path),
      dataContainer: toPath(app.DataContainer),
    }))
    .filter((app) => app.bundleId !== "")
    .toSorted((a, b) => a.bundleId.localeCompare(b.bundleId));

/** The public shape of one row of `ios_simulator_list`. */
export const toListRow = (sim: SimulatorSummary): Record<string, unknown> => ({
  udid: sim.id,
  name: sim.name,
  state: sim.state,
  runtime: sim.runtime,
  ...(sim.deviceType ? { deviceType: sim.deviceType } : {}),
  ...(sim.available ? {} : { available: false }),
  ...(sim.unavailableReason ? { unavailableReason: sim.unavailableReason } : {}),
});
