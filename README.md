# @mgcrea/mcp-ios-simulator

Model Context Protocol server for driving an **iOS Simulator** from a model:
screenshot the screen, read its accessibility tree, tap, swipe, type, manage the
app under test — and stage the device itself, which is the part no physical
device can do.

No Apple Developer team. No code signing. No device trust. No tunnel. Nothing to
unlock. And **screenshots work with nothing installed at all**.

## Features

- **See the screen, with zero setup.** `simctl` captures it directly, scaled to
  exactly the device's point size, so a position read off the image is a tap
  coordinate with no conversion. No WebDriverAgent needed for this.
- **Read the screen.** A flattened, pruned accessibility tree — type, label,
  identifier and the precomputed tap point per element — instead of the tens of
  KB of nested JSON WebDriverAgent actually returns.
- **Drive the screen.** Tap by coordinate or by accessibility label, swipe, type,
  press Home. Every action returns the resulting screen by default, so a
  mis-aimed tap is visible on the call that made it.
- **Stage the device.** Dark mode, Dynamic Type size, increased contrast, a
  frozen 9:41 status bar, a simulated location, and app permissions granted or
  denied without a prompt anyone has to tap. **None of this is possible on real
  hardware.**
- **Push without APNs.** Deliver a real remote notification with no certificate
  and no server.
- **Manage the app.** Install a build, launch it with fixture arguments,
  terminate it, uninstall it, open a deep link. An app's data container is an
  ordinary path on this Mac, so its database or logs are read directly — there
  is nothing to copy off a device.
- **Read its logs.** `launch` with `capture_logs: true` writes the app's stdout,
  stderr and every `Logger`/`os_log` message into one file, and `read_logs`
  follows it with a cursor, a regex filter and Xcode's thirty-character line
  prefix cut down to the time.
- **Read its crashes.** Simulator crash reports land among this Mac's own in
  `~/Library/Logs/DiagnosticReports`; `list_crash_logs` keeps only the
  simulators', says which simulator each came from, and `get_crash_log` returns
  the exception and the faulting thread with library names resolved.

## Security

**Writes are on by default**, and that is deliberate. The rest of the fleet is
read-only until a flag is set because a mutating tool acts on someone's real
account or someone's real phone. A simulator is neither: it holds no person's
data, and `ios_simulator_erase` puts it back to factory in seconds.

What that still costs you, stated honestly:

- `install` and `launch` run code on your Mac. A simulated process is a host
  process.
- The app's data container is a plain host path, readable by anything.
- `erase` and `uninstall` are irreversible — they are the two tools behind an
  explicit `confirm`.
- `list_crash_logs` reads this Mac's DiagnosticReports folder. It keeps only
  simulator reports and `get_crash_log` refuses a Mac app's, but the folder is
  yours and the server reads it as you.
- `IOS_SIMULATOR_ALLOW_WRITES=0` restores the device server's posture in one
  variable, and then the seventeen driving tools are **absent** from `tools/list`
  rather than refused, because a refusal still lets a model try, retry and reason
  about a way around it.

**Your credentials.** There are none. The server holds no tokens and talks to no
vendor API. Everything goes through `xcrun simctl` and a loopback HTTP server.

**Supply chain.** Three runtime dependencies: `@modelcontextprotocol/server`,
`zod`, and [`@mgcrea/mcp-ios-core`](../mcp-ios-core) — our own, and itself
dependent on only the first two. Scaling images uses `sips` and reading property
lists uses `plutil`, both of which ship with macOS, specifically so neither an
image library nor a plist parser has to be installed.

## How it reaches the simulator

| Lane                     | Carries                                                                                                                                     | Needs                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `xcrun simctl`           | simulators, apps, install, launch, deep links, **the screenshot**, appearance, status bar, location, permissions, push, boot/shutdown/erase | Xcode. Nothing else.                        |
| WebDriverAgent over HTTP | the accessibility tree, tap, swipe, type, buttons                                                                                           | a runner started once with `scripts/wda.sh` |

The asymmetry with `mcp-ios-device` is worth stating plainly: there, _every_
pixel comes through WebDriverAgent, so nothing about the screen works until a
signed runner is installed and trusted on the phone. Here `simctl` captures the
screen itself, so **eighteen of the twenty-five tools work with no runner at all**
— only `ios_simulator_ui_tree`, `ios_simulator_wait_for_element` and the five
input tools need one, and building it
takes about two minutes with no Apple account.

`ios_simulator_diagnostics` reports both lanes separately, so "the simulator is
fine but the runner is not up" is a distinguishable answer rather than a generic
failure.

## Configure

| Variable                          | Default                            | What it does                                                                  |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| `IOS_SIMULATOR_ID`                | the only booted simulator          | UDID, name, or `booted`. Two booted and no value is an error that names them. |
| `IOS_SIMULATOR_ALLOW_WRITES`      | **on**                             | `0` drops the seventeen driving tools from `tools/list`.                      |
| `IOS_SIMULATOR_LAUNCH_ARGS`       | none                               | Launch arguments applied when `launch` passes none of its own.                |
| `IOS_SIMULATOR_WDA_PORT`          | `8100`                             | Must match the runner's `USE_PORT`. One port per simulator.                   |
| `IOS_SIMULATOR_WDA_URL`           | `http://127.0.0.1:<port>`          | Explicit override; rarely needed.                                             |
| `IOS_SIMULATOR_MAX_TREE_BYTES`    | `24000`                            | Byte cap on a `ui_tree` payload.                                              |
| `IOS_SIMULATOR_TIMEOUT_MS`        | `120000`                           | Budget for one `simctl` call; a boot is slow.                                 |
| `IOS_SIMULATOR_WDA_TIMEOUT_MS`    | `30000`                            | Budget for one WebDriverAgent call.                                           |
| `IOS_SIMULATOR_OUTPUT_DIR`        | `$TMPDIR/mcp-ios-simulator`        | Screenshots, launch logs, the runner log.                                     |
| `IOS_SIMULATOR_CRASH_REPORTS_DIR` | `~/Library/Logs/DiagnosticReports` | Where `list_crash_logs` looks.                                                |
| `IOS_SIMULATOR_DEBUG`             | off                                | Log every `simctl` and WebDriverAgent call to stderr.                         |

The same keys in camelCase can go in `~/.config/ios-simulator-mcp/config.json`
(`IOS_SIMULATOR_CONFIG` to move it). The environment wins **per field**, so a
one-off `IOS_SIMULATOR_ALLOW_WRITES=0` beats a file that says `true`. Unknown keys
in the file are an error rather than silently ignored — a typo that looks like
"that setting had no effect" is the worst way to learn where your configuration
came from.

See [.env.example](.env.example) for the annotated version.

## Quick start

Requires macOS with Xcode and a booted simulator.

### A. Everything except the tree and the taps, with no setup

```bash
npx -y @mgcrea/mcp-ios-simulator
```

`list`, `list_apps`, `screenshot`, `diagnostics`, `power`, `install`, `launch`,
`open_url`, `set_environment`, `push` and `erase` all work immediately.

### B. The input lane

`ui_tree`, `tap`, `tap_element`, `swipe`, `type` and `press_button` need a
WebDriverAgent runner. Build and start it — no team id, no signing, no prompt:

```bash
scripts/wda.sh setup   # ~2 minutes
scripts/wda.sh run     # leave this running
scripts/wda.sh status  # is it answering?
```

Installed from npm, the same script is the `ios-simulator-wda` binary:

```bash
npx -p @mgcrea/mcp-ios-simulator ios-simulator-wda setup
npx -p @mgcrea/mcp-ios-simulator ios-simulator-wda run
```

### C. Wired into a client

See [.mcp.json.example](.mcp.json.example).

## Tools

Twenty-five. Eight are read-only; the other seventeen disappear with
`IOS_SIMULATOR_ALLOW_WRITES=0`. `read_logs` is among those seventeen although it
changes nothing: it only reads what `launch` started capturing, so it goes where
`launch` goes.

| Tool                             | Writes?       | What it does                                                             |
| -------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `ios_simulator_list`             |               | Every simulator, with state and whether its runtime is installed         |
| `ios_simulator_diagnostics`      |               | Both lanes, the resolved target, the geometry, and who owns the WDA port |
| `ios_simulator_list_apps`        |               | Installed apps, with bundle id and host-path data container              |
| `ios_simulator_screenshot`       |               | The screen, in point space — **no runner needed**                        |
| `ios_simulator_ui_tree`          |               | Addressable elements with precomputed tap points                         |
| `ios_simulator_wait_for_element` |               | Poll until something appears, or goes away                               |
| `ios_simulator_list_crash_logs`  |               | Simulator crash reports, newest first, by simulator and process          |
| `ios_simulator_get_crash_log`    |               | One report: exception, termination, faulting thread                      |
| `ios_simulator_tap`              | ✓             | Tap a point                                                              |
| `ios_simulator_tap_element`      | ✓             | Tap by identifier, label or predicate                                    |
| `ios_simulator_swipe`            | ✓             | Drag between two points                                                  |
| `ios_simulator_type`             | ✓             | Type into the focused field, or a named one                              |
| `ios_simulator_press_button`     | ✓             | Home                                                                     |
| `ios_simulator_power`            | ✓             | Boot or shut down; never implicit                                        |
| `ios_simulator_erase`            | ✓ **confirm** | Wipe to factory                                                          |
| `ios_simulator_install`          | ✓             | Install a simulator `.app`                                               |
| `ios_simulator_launch`           | ✓             | Launch, with fixture arguments and captured output                       |
| `ios_simulator_read_logs`        | ✓ (gate only) | Follow a `capture_logs` launch: stdout, stderr and os_log, with a cursor |
| `ios_simulator_uninstall`        | ✓ **confirm** | Remove one app and its data                                              |
| `ios_simulator_terminate`        | ✓             | Kill a running app                                                       |
| `ios_simulator_open_url`         | ✓             | Deep links and universal links                                           |
| `ios_simulator_set_environment`  | ✓             | Appearance, Dynamic Type, contrast, status bar, location, permissions    |
| `ios_simulator_add_media`        | ✓             | Seed the photo library — the way around the missing camera               |
| `ios_simulator_push`             | ✓             | A remote notification, with no APNs certificate                          |
| `ios_simulator_restart_wda`      | ✓             | Start or restart the runner, detached                                    |

Deliberately absent: `create`, `clone`, `delete`, `rename`, `upgrade` and `pair`
(fleet management, not driving, and `delete all` is a footgun with no upside);
`get_app_container` (`list_apps` already returns the path); `keychain`,
`pbcopy`, `spawn`, `diagnose` and `recordVideo` (real capabilities that an agent
would use approximately never, and every tool costs listing bytes on every
connect).

`addmedia` was on that list until 0.2.0, and it was the wrong call. A simulator
has no camera, so seeding the photo library is not a nice-to-have — it is the
only way an app whose first step is "choose a photo" can be driven here at all.
Anyone hitting that had to drop out to a shell, which is exactly what these
tools exist to avoid.

`uninstall` was on it too, on the grounds that `install` overwrites and `erase`
covers a first run. But `erase` takes every other app's data and a reboot with
it, and "this app's first launch, everything else as it was" is the ordinary
case. It sits behind `confirm` like `erase`.

## Traps worth knowing

Measured on Xcode 26.6 (17F113) unless marked Xcode 27, which was checked on
Xcode 27.0 (27A266a) with an iOS 27.0 runtime.

- **`simctl io … screenshot -` does not write to stdout.** The help text says it
  does. It creates a file literally named `-` in the current working directory
  and prints `Wrote screenshot to: …` to stderr, exit 0. This server always
  passes a real path.
- **`simctl io` on a simulator whose runtime is missing aborts** — SIGABRT, exit
  134, an uncaught `NSInternalInconsistencyException` and a thirty-line stack
  trace, not an error message. Availability is checked in the resolver, before
  the call. On a typical machine a large fraction of simulators are in this
  state.
- **`erase`, `delete` and `shutdown` all accept the literal `all`.** A target of
  `"all"` reaching `simctl erase` wipes every simulator on the machine. Refused
  in the resolver and again in the adapter.
- **`booted` is a coin flip.** simctl's own help: "If multiple devices are booted
  … simctl will choose one of them." Resolved to a concrete UDID here first.
- **WebDriverAgent scans ports 8100-8199 when `USE_PORT` is unset.** With two
  booted simulators, the second runner comes up healthy on 8101 and a server
  pointed at 8100 drives the _first_ one while every call reports success.
  `scripts/wda.sh` always pins `USE_PORT`, and `diagnostics` reports the port's
  real owner via `SIMULATOR_UDID` from `ps -Eww`.
- **`listapps` returns an old-style NeXTSTEP plist, not JSON.** `--json` is a flag
  on `list` and nothing else.
- **A status bar override survives a reboot.** Clear it or it quietly pollutes
  every later screenshot.
- **`simctl launch` environment variables need a `SIMCTL_CHILD_` prefix** on the
  calling process, not a flag.
- **An app's `Logger` output reaches no file unless `OS_ACTIVITY_DT_MODE` is
  set** (Xcode 27). Settings launched plainly wrote 8 lines to stderr; launched
  with `SIMCTL_CHILD_OS_ACTIVITY_DT_MODE=YES` it wrote 77 in the same eight
  seconds, the unified log mirrored with Xcode's prefix. `capture_logs` sets it.
- **`--stdout` and `--stderr` may be the same file** (Xcode 27). A probe app
  alternating `print`, stderr and `Logger` produced one file with all fifteen
  lines in order and nothing overwritten. The redirect **appends**, so a
  relaunch into the same path keeps the previous run's lines — every
  `capture_logs` launch gets a fresh file.
- **A launch log under `/tmp` or `$TMPDIR` is not where you asked** (Xcode 27).
  The simulator opens the redirect itself, and it has its own `/tmp` and
  `/var/folders`: `--stdout=/tmp/x/a.out` created
  `<device>/data/tmp/x/a.out`, and the path given never existed — which is
  where this server's default output directory is. `launch` now looks in both
  places and returns the real one. A path under `/Users` is written as given.
- **A simulator crash report says it is one in `platform`, not
  `is_simulated`** (Xcode 27). Of 593 reports on one Mac, the 464 from
  simulators all had header `platform: 7` (`PLATFORM_IOSSIMULATOR`), the Mac's
  all had 1, and `is_simulated: 1` was on 13 _Mac_ reports — Safari, Mail and two
  helpers. `procPath` is anonymised, so the simulator's UDID comes from the
  body's `coalitionName` (`com.apple.CoreSimulator.SimDevice.<UDID>`), which sat
  in the first 1.8 KB of every one.
- **A Swift `fatalError` message is in the log, not the crash report**
  (Xcode 27). The probe's report had the `_assertionFailure` frame and no
  application-specific text; the message was on stderr. `get_crash_log` says so
  when it happens.
- **`simctl uninstall` of an app that is not installed succeeds** (Xcode 27),
  silently, exit 0. Success does not prove it was there.
- **Launching an app that is not installed fails as "The request to open …
  failed"** (Xcode 27), `FBSOpenApplicationServiceErrorDomain` code 4, with nothing about installation.
  The error now carries that remedy.
- **A label belongs to the control _and_ to every container around it.**
  WebDriverAgent answers depth-first, so an unqualified label match lands on the
  navigation bar as readily as on the button — and a tap on a container does
  nothing while reporting success. `tap_element` narrows a label to the
  interactive types first, and says `preferredControl` when it did.
- **`isVisible` is not always truthful.** A `PHPicker` presented over Safari
  reports all nine of its asset cells `isVisible: "0"` while they are on screen
  and tappable — a synthesised tap on one opens the preview. The default
  `ui_tree` filter drops them, which is why the result carries a `filtered`
  tally: a short list that has been filtered and a screen that is genuinely bare
  are otherwise the same answer.
- **`simctl install` wants a `.app` bundle directory** built for the simulator —
  an `.ipa` or a device build fails with "No such file or directory", which reads
  like a path typo.
- **`simctl boot` gives you no window.** It runs headless, which is what an agent
  wants and confusing the first time; `power` opens a window by default.
- **Xcode 27 ships no Simulator.app.** The simulator's window belongs to
  DeviceHub (`com.apple.dt.Devices`), and `open -a Simulator` fails. `power`
  tries Simulator.app first and falls back to opening DeviceHub by bundle id; a
  window that still will not open is a `warning` on a boot that worked, never
  an error.
- **DeviceHub cannot be told which device to show.** It keeps one device per
  window, on whatever was last picked in its sidebar. No `devices://` URL
  switches it — `device/<UDID>`, a bare UDID and `simulator/<UDID>` were all
  ignored — and a query-string form it did not recognise made it quit, taking
  every booted simulator down with it. `power` therefore opens it by bundle id
  and says in its `note` to select the device. Screenshots and the WDA lane do
  not care which device the window shows.
- **Quitting DeviceHub shuts every booted simulator down.** Unlike
  Simulator.app, whose window could close with the device left running, a
  plain Quit takes the simulators with it; DeviceHub's separate "Quit and Keep
  Simulators Running" does not. Since `power` opens DeviceHub by default, a
  device that vanishes mid-session usually means someone quit that window.
  Pass `open_window: false` to boot headless when nobody needs to watch.
- **Xcode 27 moved the screen geometry out of `profile.plist`.** No device
  type's profile carries `mainScreen*` any more, old types included; the same
  numbers are under `capabilities.ScreenDimensionsCapability` in
  `capabilities.plist`. Reading only the profile defaults the scale to 1 and
  labels a 1206×2622 pixel capture as points, with nothing looking wrong.
- **Two runtimes can share one identifier**, so the key of `list devices` is not
  a primary key.

## Develop

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

## License

MIT — see [LICENSE](./LICENSE).
