# Codex Desktop Linux

Codex Desktop Linux is a maintained Linux installer and compatibility layer
for OpenAI Codex Desktop. It downloads the official upstream Codex Desktop app
on your machine, converts it into a Linux Electron app, adds Linux desktop
integration, and builds a native package for your distribution.

The project does not redistribute OpenAI application binaries. Build and update
flows download or consume the upstream app locally.

## Quick Start

For most users, the install is:

```bash
git clone https://github.com/rabesss/codex-desktop-linux.git
cd codex-desktop-linux
make install-guided
```

What happens:

1. The setup wizard checks your system, explains what will be installed, and
   lets you pick optional Linux features.
2. It installs required build tools, downloads the official Codex Desktop app,
   builds a Linux package, and installs it.

After the install, launch Codex Desktop from your app launcher or run:

```bash
codex-desktop
```

Check that the installed app is ready:

```bash
codex-desktop-doctor
```

### Before You Start

You need:

- a Linux desktop session;
- `git`;
- internet access for downloading the upstream app and build dependencies;
- a user account that can authorize package installation with `sudo` or
  `pkexec`;
- enough disk space for a downloaded app, extracted build tree, native modules,
  and package artifact. A few gigabytes free is a practical minimum.

Supported package flows are Debian/Ubuntu `.deb`, Fedora/openSUSE `.rpm`, Arch
`.pkg.tar.zst`, and AppImage. The native package path is preferred because it
installs the launcher, icon, MIME handlers, updater service, and system
integration.

`make bootstrap-native` installs dependencies automatically on supported
distributions. For a manual Fedora setup, use the command matching the release:

```bash
# Fedora 41+ (dnf5)
sudo dnf install python3 7zip curl unzip rpm-build @development-tools

# Older Fedora releases
sudo dnf install python3 p7zip p7zip-plugins curl unzip rpm-build
sudo dnf groupinstall 'Development Tools'
```

## Which Command Should I Run?

| Situation | Command |
|---|---|
| First install, simplest path | `make install-guided` |
| Non-interactive first install with defaults | `make bootstrap-native` |
| Dependencies are already installed | `make install-native` |
| Install the packaged custom-model Desktop stack | `make install-custom-models` |
| Build a native package with custom-model support but do not install it | `make package-custom-models` |
| Build the app but do not install a system package | `make build-app-fresh` then `make run-app` |
| Build a specific package format | `make deb`, `make rpm`, `make pacman`, or `make appimage` |
| Use a downloaded local upstream DMG | `make build-app DMG=/path/to/Codex.dmg` |
| See installed readiness later | `codex-desktop-doctor` or `codex-desktop-doctor --json` |

If graphical package authorization is unavailable, the updater opens a terminal
for the same system authorization step. It does not store or forward your
password.

## What Gets Installed?

Native packages install:

- the converted Codex Desktop app under the system app directory;
- a `codex-desktop` launcher;
- a desktop entry, icon, and URL/MIME integration;
- a managed Node.js runtime used by bundled browser tooling;
- the official bundled Browser, Chrome, and Computer Use plugin payloads patched
  for Linux;
- `codex-update-manager`, a user service that can rebuild future updates from
  newer upstream app downloads.

The installed app is still Codex Desktop. This repository only supplies the
Linux packaging and compatibility layer around the official app payload.

## Optional Features In Plain English

You do not have to enable optional features for a normal first install. Start
with the defaults unless you know you need one of these.

| Feature | Use it when |
|---|---|
| `open-target-discovery` | You want Codex to discover local file managers, terminals, and editor launch targets from Linux desktop entries. |
| `codex-wrapper-updater` | You want update controls for this Linux wrapper inside the app. |
| `brave-origin-browser-control` | You want Codex browser control to target Brave Origin Nightly instead of the default supported Chromium-family targets. |
| `custom-model-catalog` | You want provider-aware custom rows in the Desktop model picker from a local catalog. |

The setup wizard can write the feature config for you. Advanced users can also
create `linux-features/features.json` manually:

```json
{
  "enabled": [
    "open-target-discovery",
    "custom-model-catalog"
  ]
}
```

Then rebuild with:

```bash
make install-native
```

## Updating Later

Native packages include a Linux update manager for Debian/Ubuntu, Fedora/
openSUSE, and Arch-family systems. When OpenAI publishes a newer macOS DMG, it:

1. downloads the official DMG locally;
2. rebuilds the matching Linux package with your enabled features;
3. waits for Codex Desktop to close;
4. asks for system package-install authorization; and
5. installs the package and reopens Codex Desktop.

Required patch points are validated against each new upstream bundle before a
package is offered. If upstream changes an expected bundle shape, the update
stays uninstalled and `codex-update-manager status` reports the rebuild log
instead of replacing the working app with a partially patched build.

On GNOME, KDE, and other desktops with a Polkit agent, authorization appears as
a normal graphical prompt. On minimal window managers, the updater opens the
installed terminal emulator and presents Polkit's text prompt there. Passwords
remain with the operating system authentication tools.

Use the in-app **Update** action, close Codex Desktop when the ready notification
appears, or run:

```bash
codex-update-manager check-now
codex-update-manager status
codex-update-manager install-ready
```

The AppImage build does not include the resident system updater. AppImage users,
and anyone who disabled the updater at package-build time, can update from the
repository manually:

```bash
git pull --ff-only
make install-native
```

Run `codex-desktop-doctor` after an update if the app or launcher behaves
unexpectedly.

## Custom Models Are Optional

Custom model support is opt-in. You only need the `custom-model-catalog`
feature if you want non-OpenAI/custom provider rows in Desktop.

For a normal official Codex/OpenAI account setup, do not route traffic through
the shim. Official Codex/OpenAI traffic should stay on the first-party route.

For the maintained custom-model build, install or package Desktop with the
public profile:

```bash
make install-custom-models
```

`make install-custom-models` uses
`profiles/custom-models/features.json`, enabling `open-target-discovery`,
`codex-wrapper-updater`, and `custom-model-catalog`. It intentionally does not
enable the Brave Origin Nightly browser-control override, which is a workstation
profile choice rather than a public default. To build release artifacts without
installing them locally, run:

```bash
make package-custom-models
```

When `custom-model-catalog` is enabled, Desktop reads model capability and
context-window metadata from the configured custom catalog. That metadata
controls the picker row, context footer, compaction threshold, and truncation
policy for custom rows. Catalog rows declare their own `model_provider`, so a
direct provider row can route through its own `[model_providers.<id>]` config
while shim rows continue to route through `codex_shim`.

For direct or local providers, use the setup helper to create the catalog row
and print the matching official Codex provider config without storing secrets:

```bash
node scripts/custom-model-catalog-setup.js add-direct \
  --provider openrouter \
  --provider-name "OpenRouter" \
  --base-url "https://openrouter.ai/api/v1" \
  --wire-api responses \
  --env-key OPENROUTER_API_KEY \
  --slug openrouter-qwen3-coder \
  --model qwen/qwen3-coder \
  --display-name "Qwen3 Coder" \
  --supports-tools
```

The helper writes catalog metadata to `$CODEX_HOME/custom-models.json` by
default, prints a `[model_providers.<id>]` snippet for the user config, and
leaves the global `model_provider` on `openai`.

The custom-model picker uses route-neutral model names. For example, a
CLIProxyAPI route can display `Step 3.7 Flash:free` while the tooltip/provider
metadata carries `CLIProxyAPI / Nous Portal`. Internal slugs may still include
route prefixes so saved threads, overrides, and CLIProxyAPI routing remain
stable.

When multiple providers are present, the model submenu groups rows by provider
using that same provider metadata. This keeps the picker scannable without
putting provider prefixes back into the primary model labels. Current Desktop
also recovers the group label from the generated `<model> via <provider>.`
description when the upstream dropdown strips custom provider fields before
rendering.

On a clean machine, the picker only needs to show the normal official
OpenAI/Codex rows. Custom provider groups appear only after the user installs a
build with `custom-model-catalog` and provides a custom catalog. The catalog can
define direct providers, local OpenAI-compatible providers, or optional
`codex_shim` rows for CLIProxyAPI/local-adapter routing. The top-level Codex
provider should still be `openai`.

If the same custom model appears more than once under the same provider, treat
that as stale catalog/build state rather than a local global-provider setting.
Current Desktop and shim builds expect `/api/models` to expose one visible row
per `(provider_display_name, display_name)` pair; route-stable slugs can still
differ behind that visible row.

OpenAI Codex also supports `--oss` for local Ollama and LM Studio providers.
That remains available alongside catalog-driven local provider rows. See
OpenAI's
[advanced Codex configuration](https://developers.openai.com/codex/config-advanced#oss-mode-local-providers)
for the `--oss` mode.

Compaction can be moved earlier without reducing the displayed context window.
For example, the optional shim can keep GLM 5.2 at a 1,000,000-token context
while compacting at 165,000 tokens:

```bash
codex-shim desktop compaction set "GLM 5.2" 165k --truncation 48k --all
systemctl --user restart codex-shim.service
codex-shim doctor
```

## Troubleshooting First Installs

| Symptom | What to try |
|---|---|
| The setup says dependencies are missing | Run `make bootstrap-native`; it calls the dependency installer for supported distros. |
| An update is ready but no graphical password prompt appears | Close Codex Desktop. The updater should open a terminal authorization prompt automatically. If it cannot, run `codex-update-manager status`, then `codex-update-manager install-ready`. |
| The app launches but looks incorrectly sized on Wayland | Try `codex-desktop --x11`. Some compositors need XWayland for the current Electron build. |
| Browser control does not work | Install/enable the Codex Chrome extension for the selected Chromium-family browser, then run `codex-desktop-doctor`. |
| Custom models do not appear | Ensure `custom-model-catalog` is enabled, the custom catalog is readable or the optional shim catalog service is running, and official traffic is still configured to use the default OpenAI provider. |
| Custom model names show `CLIProxyAPI / Cursor ...` in the main picker label | Update `codex-shim`, regenerate its Desktop catalog, restart `codex-shim.service`, then restart Codex Desktop. Current shim builds keep route metadata in `provider_display_name` instead of the primary label. |
| The same custom model appears twice under the same provider | Regenerate the custom catalog, or update both repositories if using shim, and inspect the catalog source for duplicate visible provider/model pairs. Current builds de-duplicate those pairs before they reach the selector. |
| Custom model grouping is missing or all rows appear under one provider | Check `provider_display_name` in the active custom catalog and keep the generated description in the `<model> via <provider>.` shape; Desktop uses that as a fallback when upstream normalizes picker rows. For shim rows, inspect `codex-shim`'s `/api/models` output. |
| A custom model shows the wrong context window | Regenerate the active custom catalog and restart Codex Desktop. If the row uses the shim, also update `codex-shim`, regenerate its Desktop catalog, and restart the shim service. |
| Unsure what state the install is in | Run `codex-desktop-doctor --json` and include that output in an issue. |

More detail is in [Native setup](docs/native-setup.md),
[Build and packaging](docs/build-and-packaging.md), and
[Troubleshooting](docs/troubleshooting.md).

## Maintainer Model

This repository is not a simple mirror of the original Linux wrapper. Its goal
is to keep a controlled, auditable port of the desktop app with clear feature
boundaries:

- official Codex/OpenAI account traffic stays on the first-party route;
- custom provider routing belongs behind explicit opt-in provider config, with
  codex-shim available as an optional adapter for rows that need it;
- Linux-only integrations live behind a feature framework instead of being
  silently enabled for every user;
- local assistive backends such as Computer Use are owned, reviewed source in
  this repo or explicit user-selected commands.

## Companion Repository

Custom-model support is split deliberately across two public repositories:

| Repository | Responsibility |
|---|---|
| [`rabesss/codex-desktop-linux`](https://github.com/rabesss/codex-desktop-linux) | Builds and packages Desktop, adds the custom-model picker, preserves provider identity across start/fork/resume, and exposes Linux Browser tooling. |
| [`rabesss/codex-shim`](https://github.com/rabesss/codex-shim) | Optional adapter that serves a loopback model catalog and translates Codex Responses requests, streaming events, tool calls, and compaction to CLIProxyAPI-backed providers. |

Neither repository should absorb the other's job. Desktop must keep official
OpenAI/Codex traffic direct; the shim is an opt-in route for custom rows only.
The maintained integration is on `main` in both repositories. The former
`plugins/browser-control-linux` branch has been merged and removed.

## What Is In This Repo

The repo is organized around a generated app, not a checked-in app bundle.

| Area | What it does |
|---|---|
| `install.sh`, `Makefile`, `scripts/lib/` | Download/extract the upstream DMG, rebuild native modules, patch the app, stage resources, and generate `codex-app/`. |
| `scripts/patches/core/` | Fail-soft/fail-closed patch descriptors for Linux app behavior: windowing, tray, launch actions, browser integration, updater bridge, settings, feature gates, and webview fixes. |
| `computer-use-linux/` | Rust MCP backend for Linux Computer Use, including screenshots, accessibility tree access, input paths, and compositor/window-manager backends. |
| `plugins/openai-bundled/` | Bundled plugin payloads staged into the Linux app, including Computer Use metadata. |
| `linux-features/` | Opt-in Linux feature system. Features can add patches, staged files, runtime hooks, package hooks, and cleanup metadata. |
| `packaging/` | Debian, RPM, pacman, AppImage, desktop entry, polkit, and packaged runtime integration. |
| `updater/` | Rust update manager that checks for newer upstream DMGs and can rebuild/install a native package after the app exits. |
| `contrib/user-local-install/` | User-local install path for people who do not want a system package. |
| `profiles/workstation/` | Example maintained feature profile. It is intentionally separate from the portable defaults. |
| `tests/`, `.github/workflows/` | Script, patch, package, Rust, and upstream-drift validation. |

Generated outputs such as `codex-app/`, `dist/`, `target/`, and local feature
configuration are build artifacts and should not be committed.

## Feature Model

Core Linux compatibility is part of the base build. Optional integrations are
selected before building.

Core behavior includes:

- Linux Electron launch support and managed Node runtime;
- native package and AppImage build paths;
- local webview server startup and warm-start handoff;
- Linux file manager and browser integration patches;
- Chromium-family browser-control target selection;
- Chrome-compatible native messaging host support;
- bundled Linux Computer Use backend registration;
- updater bridge and package update manager;
- fail-closed patch reports for required upstream compatibility.

Optional features include:

| Feature | ID | Notes |
|---|---|---|
| Brave Origin browser control | `brave-origin-browser-control` | Optional feature on `main` that targets Brave Origin Nightly and the Codex Chrome extension. |
| Custom Model Catalog | `custom-model-catalog` | Adds strict Desktop patch points for provider-aware custom catalog rows. |
| Wrapper updater UI | `codex-wrapper-updater` | Exposes wrapper update actions in the app. |
| Open Target Discovery | `open-target-discovery` | Adds Linux target discovery surfaces. |

Enable features by creating `linux-features/features.json`:

```json
{
  "enabled": [
    "open-target-discovery",
    "custom-model-catalog"
  ]
}
```

Then rebuild:

```bash
make install-native
```

Private features can live under the git-ignored
`linux-features/local/<feature-id>/` directory and use the same feature
manifest contract.

## Removed Optional Features

The inherited and sunset optional features that are not part of the maintained
Linux port have been removed from this fork. That includes `agent-workspace`,
`appshots`, `copilot-reasoning-effort`, `conversation-mode`, `read-aloud`,
`read-aloud-mcp`, `remote-control-ui`, `remote-mobile-control`, `zed-opener`,
and `example-feature`.

Custom-model browser control uses the patched official Browser/Chrome plugin
path and the maintained Linux Computer Use backend. The active workstation build
does not stage `agent-workspace-linux`, voice runtimes, remote-control daemons,
editor-specific opener code, or optional screenshot helpers. Reintroduce any of
those capabilities only as a new reviewed feature with tests and update-builder
coverage.

## Browser Control

Users can choose the browser Codex controls, but the choice is limited to
browser/profile layouts that this repo knows how to patch and verify.

Core builds support Google Chrome, Brave Browser stable, and Chromium. The
optional `brave-origin-browser-control` feature on `main` adds Brave Origin
Nightly. Firefox-family browsers and unlisted Chromium-family browsers need a
new feature before they are safe browser-control targets.

See [Browser Control](docs/browser-control.md) for setup steps, limitations,
and an agent prompt users can hand to their assistant.

## Custom Models

Enable `custom-model-catalog` when provider-aware custom rows should appear
beside official models. The Desktop feature owns UI and session routing. A
shared catalog owns row metadata. Direct and local rows use their own
`[model_providers.<id>]` config, while the optional shim owns CLIProxyAPI/local
adapter protocol translation for rows that use `codex_shim`.

Current builds preserve `model`, `modelProvider`, provider configuration, and
dynamic tools when a custom thread is started, forked, or resumed. This fixes a
previous failure where `/goal` could fork a custom thread without its
custom provider route, after which Desktop stopped sending that thread's
requests to the selected provider. Custom threads also skip the first-party
automatic title request, so an exhausted official account does not create a
misleading title-generation error after a successful custom-model turn. The
durable non-default provider definition for each saved custom row must still
exist after restart; the top-level default must remain `openai`.

The optional shim must be current enough to preserve native Responses tool
item types and Desktop namespace metadata. Browser/MCP calls from custom rows
depend on the selected provider path: this repo exposes and preserves dynamic
tools, while `codex-shim` flattens nested or flat MCP tool names for
CLIProxyAPI-backed providers and restores `type`, `namespace`, and child
`name` on the return path. Rows that are not verified for tool calling should
not advertise `supports_tools`.

See [Custom models](docs/custom-models.md) and the companion
[`codex-shim` Linux Desktop guide](https://github.com/rabesss/codex-shim/blob/main/docs/linux-desktop.md).

## Known Constraints

- Browser control is reliable for normal read, navigate, click, fill, and
  screenshot workflows, but links that open with `target="_blank"` may create
  a tab the extension backend does not surface. Read the link target and
  navigate explicitly when tab discovery matters.
- Locator behavior differs by backend. In-app Browser locators can re-resolve
  after reload, while the extension backend can return a count of zero for a
  locator built before navigation. Re-snapshot before interaction when page
  state changed.
- The Browser Playwright subset intentionally omits general `page`, `mouse`,
  `keyboard`, and forced-action APIs. Use the documented locator methods and
  `evaluate` for scrolling.
- Navigation waits live under `tab.playwright`, for example
  `tab.playwright.waitForLoadState(...)`; there is no `tab.waitForLoadState`
  shortcut.
- DOM CUA currently returns visible nodes as a string, not JSON. Parse the
  `node_id` values from that string before calling DOM CUA actions.
- In-app Browser file upload and HTML5 drag-and-drop are not currently
  supported by the in-app backend.
- Chrome internal pages cannot be claimed. The extension backend also does not
  implement `browser.tabs.content`; use per-tab DOM snapshot/evaluation APIs.
- Navigation performs an upstream site-safety status check. It can add visible
  latency and must not be bypassed by this port.
- The in-app backend can log a non-blocking unsupported
  `Target.setAutoAttach` request while normal locator actions still succeed.
- Browser telemetry may occasionally report a non-blocking execution-context
  error even when the requested action succeeds.

More detailed workarounds and API notes are in
[Browser Control](docs/browser-control.md#backend-constraints).

## Installed-State Doctor

Native packages install a lightweight readiness command:

```bash
codex-desktop-doctor
codex-desktop-doctor --json
```

The doctor checks the installed launcher, desktop entry, Electron runtime,
managed Node.js runtime, update service, browser-control plugin staging, and
Computer Use backend without launching Desktop.
Failed checks are treated as readiness blockers; warnings are diagnostics for
optional or environment-dependent integrations.

When the Linux desktop settings page is available, its **Installed readiness**
row calls the same doctor from inside the app and shows the current pass,
warning, or blocker summary. Set `CODEX_DESKTOP_DOCTOR_PATH` only for
nonstandard side-by-side installs that need a custom doctor command.

## Trust And Routing

This repo should not hide network paths from the user.

- Official Codex account traffic remains first-party OpenAI/Codex traffic.
- Custom model/provider traffic should be explicit and labeled by the route the
  user selected.
- A model that does not support image input must not be advertised as
  multimodal.
- Third-party Computer Use plugin staging is blocked by policy checks.
- Optional feature downloads must be explicit and reviewed.

Implementation-specific routing, local workstation policy, and maintainer
handoff notes should stay outside the public documentation unless they are
generalized into user-facing setup material.

## Validation

Useful checks while developing:

```bash
git diff --check
scripts/workstation/verify-policy.sh
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
cargo test --workspace
bash tests/scripts_smoke.sh
```

For a side-by-side app build before replacing an installed package:

```bash
scripts/workstation/build-dev.sh
```

For browser-control profile validation on a built app:

```bash
scripts/workstation/verify-browser-control.sh codex-app
```

## Documentation

- [Architecture](docs/architecture.md)
- [Build and packaging](docs/build-and-packaging.md)
- [Native setup](docs/native-setup.md)
- [Linux Computer Use](docs/linux-computer-use.md)
- [Custom models](docs/custom-models.md)
- [Browser Control](docs/browser-control.md)
- [Linux Features architecture](docs/linux-features-architecture.md)
- [Updater](docs/updater.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Nix](docs/nix.md)
- [Webview server evaluation](docs/webview-server-evaluation.md)

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI.
This tool automates a local conversion process for users who already have
access to the upstream app.

## License

MIT
