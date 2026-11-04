import { describe, expect, it } from "vitest";

import { freePort, parseLsof, parsePsUdids, runnerRanges } from "#/client/runners";

describe("runner discovery", () => {
  it("reads lsof's field output, once per port even on both stacks", () => {
    // Captured from a real runner, plus a second one listening on v4 and v6.
    const stdout = "p74786\nf8\nn*:8100\np80001\nf9\nn127.0.0.1:8101\nf10\nn[::1]:8101\n";
    expect(parseLsof(stdout)).toEqual([
      { pid: 74786, port: 8100 },
      { pid: 80001, port: 8101 },
    ]);
  });

  it("finds SIMULATOR_UDID in each process's environment", () => {
    const stdout =
      "74786 /Users/x/Library/Developer/CoreSimulator/Devices/EB3B/WebDriverAgentRunner-Runner " +
      "HOME=/x SIMULATOR_UDID=EB3BC520-5DE9-42C2-A0B5-A01C91C6843C PATH=/usr/bin\n" +
      "  512 /usr/local/bin/node server.js PATH=/usr/bin\n";
    const udids = parsePsUdids(stdout);
    expect(udids.get(74786)).toBe("EB3BC520-5DE9-42C2-A0B5-A01C91C6843C");
    expect(udids.has(512)).toBe(false);
  });

  it("allocates the first port nothing holds, whoever holds the others", () => {
    expect(freePort([], 8100)).toBe(8100);
    expect(
      freePort(
        [
          { pid: 1, port: 8100, udid: "A" },
          // A host process, not a runner — still a port a runner cannot bind.
          { pid: 2, port: 8101 },
        ],
        8100,
      ),
    ).toBe(8102);
  });

  it("scans WebDriverAgent's own range, and the configured one when it lies elsewhere", () => {
    expect(runnerRanges(8100)).toEqual([[8100, 8199]]);
    expect(runnerRanges(8150)).toEqual([[8100, 8199]]);
    expect(runnerRanges(9100)).toEqual([
      [8100, 8199],
      [9100, 9199],
    ]);
  });
});
