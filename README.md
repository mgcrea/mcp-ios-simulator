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
  terminate it, open a deep link. An app's data container is an ordinary path on
  this Mac, so its database or logs are read directly — there is nothing to copy
  off a device.

## Security

**Writes are on by default**, and that is deliberate. The rest of the fleet is
read-only until a flag is set because a mutating tool acts on someone's real
account or someone's real phone. A simulator is neither: it holds no person's
data, and `ios_simulator_erase` puts it back to factory in seconds.

What that still costs you, stated honestly:

- `install` and `launch` run code on your Mac. A simulated process is a host
  process.
- The app's data container is a plain host path, readable by anything.
- `erase` is irreversible — it is the only tool behind an explicit `confirm`.
- `IOS_SIMULATOR_ALLOW_WRITES=0` restores the device server's posture in one
  variable, and then the fourteen driving tools are **absent** from `tools/list`
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
screen itself, so **fourteen of the nineteen tools work with no runner at all**
— only `ios_simulator_ui_tree` and the five input tools need one, and building it
takes about two minutes with no Apple account.

`ios_simulator_diagnostics` reports both lanes separately, so "the simulator is
fine but the runner is not up" is a distinguishable answer rather than a generic
failure.

## Configure

| Variable                       | Default                     | What it does                                                                  |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------- |
| `IOS_SIMULATOR_ID`             | the only booted simulator   | UDID, name, or `booted`. Two booted and no value is an error that names them. |
| `IOS_SIMULATOR_ALLOW_WRITES`   | **on**                      | `0` drops the fourteen driving tools from `tools/list`.                       |
| `IOS_SIMULATOR_LAUNCH_ARGS`    | none                        | Launch arguments applied when `launch` passes none of its own.                |
| `IOS_SIMULATOR_WDA_PORT`       | `8100`                      | Must match the runner's `USE_PORT`. One port per simulator.                   |
| `IOS_SIMULATOR_WDA_URL`        | `http://127.0.0.1:<port>`   | Explicit override; rarely needed.                                             |
| `IOS_SIMULATOR_MAX_TREE_BYTES` | `24000`                     | Byte cap on a `ui_tree` payload.                                              |
| `IOS_SIMULATOR_TIMEOUT_MS`     | `120000`                    | Budget for one `simctl` call; a boot is slow.                                 |
| `IOS_SIMULATOR_WDA_TIMEOUT_MS` | `30000`                     | Budget for one WebDriverAgent call.                                           |
| `IOS_SIMULATOR_OUTPUT_DIR`     | `$TMPDIR/mcp-ios-simulator` | Screenshots, launch logs, the runner log.                                     |
| `IOS_SIMULATOR_DEBUG`          | off                         | Log every `simctl` and WebDriverAgent call to stderr.                         |

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

Twenty-one. Six are read-only; the other fifteen disappear with
`IOS_SIMULATOR_ALLOW_WRITES=0`.

| Tool                             | Writes?       | What it does                                                             |
| -------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `ios_simulator_list`             |               | Every simulator, with state and whether its runtime is installed         |
| `ios_simulator_diagnostics`      |               | Both lanes, the resolved target, the geometry, and who owns the WDA port |
| `ios_simulator_list_apps`        |               | Installed apps, with bundle id and host-path data container              |
| `ios_simulator_screenshot`       |               | The screen, in point space — **no runner needed**                        |
| `ios_simulator_ui_tree`          |               | Addressable elements with precomputed tap points                         |
| `ios_simulator_wait_for_element` |               | Poll until something appears, or goes away                               |
| `ios_simulator_tap`              | ✓             | Tap a point                                                              |
| `ios_simulator_tap_element`      | ✓             | Tap by identifier, label or predicate                                    |
| `ios_simulator_swipe`            | ✓             | Drag between two points                                                  |
| `ios_simulator_type`             | ✓             | Type into the focused field, or a named one                              |
| `ios_simulator_press_button`     | ✓             | Home                                                                     |
| `ios_simulator_power`            | ✓             | Boot or shut down; never implicit                                        |
| `ios_simulator_erase`            | ✓ **confirm** | Wipe to factory — the only irreversible tool                             |
| `ios_simulator_install`          | ✓             | Install a simulator `.app`                                               |
| `ios_simulator_launch`           | ✓             | Launch, with fixture arguments and captured output                       |
| `ios_simulator_terminate`        | ✓             | Kill a running app                                                       |
| `ios_simulator_open_url`         | ✓             | Deep links and universal links                                           |
| `ios_simulator_set_environment`  | ✓             | Appearance, Dynamic Type, contrast, status bar, location, permissions    |
| `ios_simulator_add_media`        | ✓             | Seed the photo library — the way around the missing camera               |
| `ios_simulator_push`             | ✓             | A remote notification, with no APNs certificate                          |
| `ios_simulator_restart_wda`      | ✓             | Start or restart the runner, detached                                    |

Deliberately absent: `create`, `clone`, `delete`, `rename`, `upgrade` and `pair`
(fleet management, not driving, and `delete all` is a footgun with no upside);
`get_app_container` (`list_apps` already returns the path); `uninstall`
(`install` overwrites, and `erase` covers first-run properly); `keychain`,
`pbcopy`, `spawn`, `diagnose` and `recordVideo` (real capabilities that an agent
would use approximately never, and every tool costs listing bytes on every
connect).

`addmedia` was on that list until 0.2.0, and it was the wrong call. A simulator
has no camera, so seeding the photo library is not a nice-to-have — it is the
only way an app whose first step is "choose a photo" can be driven here at all.
Anyone hitting that had to drop out to a shell, which is exactly what these
tools exist to avoid.

## Traps worth knowing

All measured on Xcode 26.6 (17F113).

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
  wants and confusing the first time; `power` opens Simulator.app by default.
- **Two runtimes can share one identifier**, so the key of `list devices` is not
  a primary key.

## Develop

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

## License

MIT — see [LICENSE](./LICENSE).
