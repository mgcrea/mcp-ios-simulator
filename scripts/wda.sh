#!/usr/bin/env bash
# Build and run WebDriverAgent against an iOS Simulator — the half of
# mcp-ios-simulator that can read the accessibility tree and touch the screen.
#
# Screenshots do NOT need this: `simctl io screenshot` works with nothing
# installed. Only ios_simulator_ui_tree and the input tools do.
#
# Compared with the physical-device version of this script, everything hard is
# gone: no Apple Developer team, no provisioning profile, no code signing, no
# untrusted-developer prompt on the device, no tunnel. A simulator build is not
# signed at all.
#
#   scripts/wda.sh setup    clone + build the runner (once, ~2 minutes)
#   scripts/wda.sh run      start it and keep it running (leave this open)
#   scripts/wda.sh status   is it answering?
#
# Environment:
#   IOS_SIMULATOR_ID         UDID or name        (default: the only booted simulator)
#   IOS_SIMULATOR_WDA_PORT   port to bind        (default: 8100)
#   USE_PORT                 same thing, for people driving xcodebuild by hand
#   NODE                     node binary         (default: node off PATH)
#   WDA_DIR                  checkout location   (default: ~/.cache/mcp-ios-simulator/WebDriverAgent)
#   WDA_REF                  git tag to pin      (default: v16.12.3)
set -euo pipefail

WDA_DIR="${WDA_DIR:-$HOME/.cache/mcp-ios-simulator/WebDriverAgent}"
WDA_REF="${WDA_REF:-v16.12.3}"
DERIVED="${WDA_DIR}/.build"
PORT="${USE_PORT:-${IOS_SIMULATOR_WDA_PORT:-8100}}"
# Not always on PATH: a host that embeds its own runtime leaves nothing called
# `node` to find, and every invocation below fails with "command not found".
NODE="${NODE:-node}"

die() { echo "error: $*" >&2; exit 1; }

# The simulator record, straight from simctl's own JSON — the same source the
# server uses, so the script and the server can never disagree about which
# simulator they mean.
sim_json() {
  xcrun simctl list devices -j -e | "$NODE" -e '
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      const all = Object.values(JSON.parse(raw).devices ?? {}).flat();
      const want = process.env.IOS_SIMULATOR_ID;
      const usable = all.filter((d) => d.isAvailable !== false);
      const booted = usable.filter((d) => d.state === "Booted");
      const match = want && want !== "booted"
        ? usable.find((d) => d.udid.toLowerCase() === want.toLowerCase() || d.name === want)
        : booted.length === 1 ? booted[0] : undefined;
      if (!match) {
        console.error(booted.length > 1
          ? "Several simulators are booted. Set IOS_SIMULATOR_ID to one of: " +
            booted.map((d) => `${d.name} = ${d.udid}`).join(", ")
          : "No booted simulator. Boot one in Simulator.app, or `xcrun simctl boot <udid>`.");
        process.exit(1);
      }
      console.log(JSON.stringify({ udid: match.udid, name: match.name, state: match.state }));
    });
  '
}

field() { "$NODE" -e 'const d=JSON.parse(process.argv[1]);process.stdout.write(String(d[process.argv[2]]??""))' "$1" "$2"; }

cmd_setup() {
  local sim udid name
  sim="$(sim_json)"; udid="$(field "$sim" udid)"; name="$(field "$sim" name)"
  echo "==> simulator: $name ($udid)"

  if [ ! -d "$WDA_DIR/.git" ]; then
    echo "==> cloning appium/WebDriverAgent $WDA_REF"
    mkdir -p "$(dirname "$WDA_DIR")"
    git clone --depth 1 --branch "$WDA_REF" https://github.com/appium/WebDriverAgent.git "$WDA_DIR"
  else
    echo "==> reusing $WDA_DIR"
    git -C "$WDA_DIR" fetch --depth 1 origin "refs/tags/$WDA_REF:refs/tags/$WDA_REF" 2>/dev/null || true
    git -C "$WDA_DIR" checkout -q "$WDA_REF"
  fi

  # A separate checkout from the device server's on purpose. The two could share
  # one — the products land in Debug-iphonesimulator/ rather than Debug-iphoneos/
  # — but they would then share a derivedDataPath two xcodebuild processes can
  # enter at once, and a `git checkout $WDA_REF` in one would yank the ref out
  # from under the other the first time the pins diverge.
  echo "==> building the runner (no signing: a simulator build needs no team)"
  xcodebuild build-for-testing \
    -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
    -scheme WebDriverAgentRunner \
    -destination "platform=iOS Simulator,id=$udid" \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO

  echo
  echo "Built. Now run: scripts/wda.sh run"
}

cmd_run() {
  local sim udid name xctestrun patched
  sim="$(sim_json)"; udid="$(field "$sim" udid)"; name="$(field "$sim" name)"
  xctestrun="$(ls "$DERIVED"/Build/Products/WebDriverAgentRunner_iphonesimulator*.xctestrun 2>/dev/null | head -1 || true)"
  [ -n "$xctestrun" ] || die "no build found in $DERIVED — run \`scripts/wda.sh setup\` first"

  # Pin the port, always. Left unset, WebDriverAgent scans 8100-8199 and binds
  # the first free one (FBConfiguration.m: DefaultStartingPort 8100, range 100),
  # so a second simulator's runner comes up healthy on 8101 and a server
  # configured for 8100 drives the *first* simulator while every tool reports
  # success. With USE_PORT set the range collapses to one and a collision is a
  # loud bind failure instead of a silent wrong-target bug.
  #
  # Patched into a copy of the xctestrun rather than the original, so a second
  # simulator on a different port does not race the first.
  # Beside the original, not in $DERIVED: an xctestrun resolves its product
  # paths against __TESTROOT__, which is its own directory, so a copy one level
  # up looks for the .xctest bundle in a place that does not exist and fails
  # with "Missing test product".
  patched="$(dirname "$xctestrun")/wda-$PORT.xctestrun"
  cp "$xctestrun" "$patched"
  /usr/bin/plutil -replace WebDriverAgentRunner.EnvironmentVariables.USE_PORT \
    -string "$PORT" "$patched" 2>/dev/null \
    || die "could not set USE_PORT in $patched — check the xctestrun's FormatVersion"

  echo "==> starting WebDriverAgent on $name ($udid), port $PORT"
  echo "    it stays up for as long as this command runs; Ctrl-C stops it"
  # `test-without-building` is what keeps the runner alive: the XCTest session is
  # the process, so the HTTP server dies with it. There is no daemon mode.
  exec env USE_PORT="$PORT" xcodebuild test-without-building \
    -xctestrun "$patched" \
    -destination "platform=iOS Simulator,id=$udid"
}

cmd_status() {
  local url; url="http://127.0.0.1:${PORT}/status"
  echo "==> GET $url"
  if curl -fsS --max-time 5 "$url"; then
    echo
  else
    echo "not answering — run \`scripts/wda.sh run\`, or check the port with lsof -iTCP:$PORT" >&2
    exit 1
  fi
}

case "${1:-}" in
  setup) cmd_setup ;;
  run) cmd_run ;;
  status) cmd_status ;;
  *) echo "usage: $0 {setup|run|status}" >&2; exit 2 ;;
esac
