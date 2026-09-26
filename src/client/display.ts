import { join } from "node:path";

import type { DisplayInfo, ExecImpl } from "@mgcrea/mcp-ios-core";

import { IosError } from "#/client/errors";
import type { RawDeviceType } from "#/client/simctl";

/**
 * Screen geometry for a simulator, which has no `devicectl device info displays`.
 *
 * Three sources were measured, and the split between them is the interesting
 * part:
 *
 *  - **`profile.plist`, per device type.** `mainScreenWidth`, `mainScreenHeight`
 *    and `mainScreenScale`, agreeing exactly with both `io enumerate` and the
 *    captured PNG. A pure file read: no simctl call, nothing to boot, and no
 *    crash surface on an unavailable simulator. This is where `pointScale`
 *    comes from.
 *  - **The captured PNG's own header.** This is where *pixels* come from
 *    whenever there is a capture, because `simctl io … screenConfig geometry`
 *    can resize a booted simulator's screen at runtime and the profile would
 *    then be silently wrong — putting every tap coordinate in the wrong space
 *    with nothing looking wrong.
 *  - **`io enumerate`**, which also reports it, but is a text parse of a
 *    150-line dump and aborts on an unavailable device. Not used.
 */
export const profilePlistPath = (bundlePath: string): string =>
  join(bundlePath, "Contents", "Resources", "profile.plist");

export type ScreenProfile = {
  mainScreenWidth?: number;
  mainScreenHeight?: number;
  mainScreenScale?: number;
};

/**
 * Where Xcode 27 moved the screen geometry: its `profile.plist` no longer carries
 * any `mainScreen*` key — for every device type, old ones included — and the
 * same three numbers live under `capabilities.ScreenDimensionsCapability`.
 */
export const capabilitiesPlistPath = (bundlePath: string): string =>
  join(bundlePath, "Contents", "Resources", "capabilities.plist");

type CapabilitiesPlist = {
  capabilities?: {
    ScreenDimensionsCapability?: {
      "main-screen-width"?: number;
      "main-screen-height"?: number;
      "main-screen-scale"?: number;
    };
  };
};

type PlistOpts = { plutilPath: string; exec: ExecImpl; timeoutMs: number };

const readPlistJson = async <T>(path: string, opts: PlistOpts): Promise<T | undefined> => {
  try {
    const { stdout } = await opts.exec(
      opts.plutilPath,
      ["-convert", "json", "-o", "-", path],
      opts.timeoutMs,
    );
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
};

export const readScreenProfile = async (
  deviceType: RawDeviceType,
  opts: PlistOpts,
): Promise<ScreenProfile> => {
  if (!deviceType.bundlePath) return {};
  const profile =
    (await readPlistJson<ScreenProfile>(profilePlistPath(deviceType.bundlePath), opts)) ?? {};
  if (profile.mainScreenScale !== undefined) return profile;

  const dims = (
    await readPlistJson<CapabilitiesPlist>(capabilitiesPlistPath(deviceType.bundlePath), opts)
  )?.capabilities?.ScreenDimensionsCapability;
  if (!dims) return profile;
  return {
    mainScreenWidth: dims["main-screen-width"],
    mainScreenHeight: dims["main-screen-height"],
    mainScreenScale: dims["main-screen-scale"],
  };
};

/**
 * Width and height straight out of a PNG's IHDR.
 *
 * Cheaper than shelling to `sips` for the one number that must not be stale,
 * and the bytes are already in hand: the signature is fixed, `IHDR` is always
 * the first chunk, and the two dimensions are big-endian at offsets 16 and 20.
 */
export const pngDimensions = (png: Buffer): { width: number; height: number } | undefined => {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined;
  if (png.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

/**
 * Assemble a `DisplayInfo`.
 *
 * `orientation` is derived by comparing the capture's own aspect against the
 * profile's portrait dimensions, and is `"unknown"` when there is no capture to
 * compare — never guessed as `"portrait"`, because the whole point of the field
 * is telling a caller whether the screen they are about to read is rotated.
 *
 * `backlightState` is left undefined: a simulator has no backlight, and
 * `io enumerate`'s `Power state` is about the framebuffer port rather than the
 * screen, so mapping it would be a lie.
 */
export const toDisplayInfo = (
  profile: ScreenProfile,
  capture?: { width: number; height: number },
): DisplayInfo => {
  const scale = profile.mainScreenScale ?? 1;
  const pixelWidth = capture?.width ?? profile.mainScreenWidth;
  const pixelHeight = capture?.height ?? profile.mainScreenHeight;

  if (!pixelWidth || !pixelHeight) {
    throw new IosError("Could not determine the simulator's screen geometry.", {
      remedy:
        "The device type's profile.plist could not be read and no screenshot was available. " +
        "Run ios_simulator_diagnostics — an unavailable runtime is the usual cause.",
    });
  }

  const landscape =
    profile.mainScreenWidth !== undefined && profile.mainScreenHeight !== undefined
      ? pixelWidth > pixelHeight && profile.mainScreenWidth < profile.mainScreenHeight
      : pixelWidth > pixelHeight;

  return {
    pixelWidth,
    pixelHeight,
    pointWidth: Math.round(pixelWidth / scale),
    pointHeight: Math.round(pixelHeight / scale),
    pointScale: scale,
    orientation: capture ? (landscape ? "landscape" : "portrait") : "unknown",
  };
};
