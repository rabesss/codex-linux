# Build And Packaging

This repository builds Linux artifacts locally from the official upstream Codex
Desktop app. It does not publish or redistribute OpenAI application payloads.

The build system has two release concerns:

- the upstream app pin, which identifies the approved official DMG metadata and
  hash;
- the Linux wrapper revision, which provides the patcher, launcher, package
  builders, updater, feature framework, and docs used to rebuild the local
  package.

## Prerequisites

You need:

- `python3`, `7z` or `7zz`, `curl`, `unzip`, `make`, and `g++`;
- a Rust toolchain with `cargo` for `codex-update-manager`,
  `codex-computer-use-linux`, and the Chrome-compatible native messaging host;
- a user account that can authorize package installation when installing a
  native package.

The installer downloads a managed Linux Node.js runtime into
`codex-app/resources/node-runtime` and uses it for `node`, `npm`, and `npx`
during the build. A system Node.js install is not required for the normal
installer path.

Bootstrap dependencies:

```bash
bash scripts/install-deps.sh
```

It detects `apt`, `dnf5`, `dnf`, `pacman`, or `zypper`, installs system
packages, and bootstraps Rust through `rustup` when needed.

## Manual Dependencies

```bash
# Fedora 41+
sudo dnf install python3 7zip curl unzip rpm-build make gcc-c++ @development-tools

# Fedora < 41
sudo dnf install python3 p7zip p7zip-plugins curl unzip rpm-build make gcc-c++
sudo dnf groupinstall 'Development Tools'

# openSUSE
sudo zypper install python3 p7zip-full curl unzip
sudo zypper install -t pattern devel_basis

# Arch / Manjaro
sudo pacman -S --needed python p7zip curl unzip zstd base-devel

# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On apt-based systems, `scripts/install-deps.sh` can still bootstrap optional
NodeSource Node.js for users who want a system Node.js toolchain:

```bash
bash scripts/install-deps.sh
NODEJS_MAJOR=24 bash scripts/install-deps.sh
```

Ubuntu-family `p7zip-full` can be too old for newer APFS DMGs, so
`install-deps.sh` bootstraps `7zz` into `~/.local/bin` by default.

## Generate The Local App

```bash
make build-app
make build-app-fresh
make build-app DMG=/path/to/Codex.dmg
```

Equivalent direct commands:

```bash
./install.sh
./install.sh /path/to/Codex.dmg
./install.sh --fresh
```

The default path reuses the cached `Codex.dmg` when present. `--fresh` removes
the generated app directory before rebuilding, and native install shortcuts use
`--fresh --reuse-dmg` so they clean `codex-app/` while still reusing the cached
DMG.

The generated `codex-app/` tree contains the locally converted app, Linux
Electron runtime, rebuilt native modules, launcher, patch metadata, managed
runtime resources, bundled Linux integration, and enabled optional features.
Treat it as build output.

Run the generated app without installing a native package:

```bash
make run-app
./codex-app/start.sh
```

## Build Pipeline

```text
official Codex.dmg or approved local pin
  -> extraction with 7z/7zz
  -> app.asar patch descriptors
  -> optional linux-features descriptors and resources
  -> native Node module rebuild
  -> matching Linux Electron runtime
  -> generated launcher and webview server
  -> codex-app/
  -> native package or AppImage
```

The package builders repackage an already generated `codex-app/`. They do not
download or extract the DMG themselves.

## Package Formats

After `make build-app` or `make build-app-fresh`, build a package from
`codex-app/`:

| Format | Build command | Output | Install |
|---|---|---|---|
| Debian | `make deb` | `dist/codex-desktop_*.deb` | `sudo dpkg -i dist/codex-desktop_*.deb` |
| RPM | `make rpm` | `dist/codex-desktop-*.x86_64.rpm` | `sudo dnf install dist/codex-desktop-*.rpm` or `sudo zypper install dist/codex-desktop-*.rpm` |
| Arch | `make pacman` | `dist/codex-desktop-*.pkg.tar.zst` | `sudo pacman -U dist/codex-desktop-*.pkg.tar.zst` |
| AppImage | `make appimage` | `dist/codex-desktop-*.AppImage` | Run directly |
| Auto-detect | `make package && make install` | matches host distro | handled by `make install` |

Override package version:

```bash
PACKAGE_VERSION=2026.03.24.220723+88f07cd3 make deb
```

## Native Packages And Update Builder

Default native packages install:

- the converted app under the system package root;
- the `codex-desktop` launcher;
- desktop entry, icon, URL/MIME integration, and installed-state doctor;
- `codex-update-manager`;
- a systemd user service for update checks;
- a Polkit policy for constrained package install and rollback commands;
- `/opt/codex-desktop/update-builder`, a frozen copy of the wrapper machinery
  needed for local update rebuilds.

The update builder must contain enough wrapper metadata to know which revision
produced the installed package. It should not rely on a live `.git` checkout.

Build without the resident updater:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

That mode omits the updater service, Polkit policy, desktop update actions, and
update-builder bundle. Users then update from a trusted checkout manually.

## Governed Upstream Pins

For a governed release, the upstream app pin should be recorded as metadata and
hashes only. The native package build may consume the approved DMG locally, but
public releases and CI artifacts must not upload the DMG, extracted app, or
rebuilt package payload containing OpenAI application code.

Ordinary push and pull-request CI validates committed metadata and package
fixtures. It does not download the moving upstream `Codex.dmg`, so unrelated
wrapper changes are not blocked when OpenAI publishes a new DMG. Live DMG
validation is isolated to scheduled/manual automation that records either a
candidate or a patch-drift issue.

When validating a new upstream DMG:

```bash
make inspect-upstream DMG=/path/to/Codex.dmg
```

Inspection writes rebuild and patch reports without replacing `codex-app/`.
Promotion of a candidate app pin is a Git review step, not an automatic result
of "latest DMG exists."

Nix package-output refreshes are downstream of that live-DMG lane. The normal CI
flake check proves committed metadata and evaluation are coherent; the dedicated
Nix refresh workflow performs full package-output builds only after upstream
watcher success or explicit maintainer dispatch.

The local container runner follows the same boundary:

```bash
./scripts/ci-local.sh nix
CI_NIX_BUILD_OUTPUTS=1 ./scripts/ci-local.sh nix
```

Use the first command for ordinary CI parity and the second only when you
intentionally want to build the fixed-output package payloads.

## Custom-Model Package Profile

The public custom-model build is a normal native package generated with a
checked-in feature profile:

```bash
make install-custom-models
```

That command is equivalent to:

```bash
CODEX_LINUX_FEATURES_CONFIG=profiles/custom-models/features.json make install-native
```

It downloads the official upstream app locally, applies the Linux/custom-model
patches, builds the host distro package, and installs it. The profile enables:

- `open-target-discovery`;
- `codex-wrapper-updater`;
- `custom-model-catalog`.

It does not make any custom provider the global Codex default. Official
Codex/OpenAI routing should stay direct. Custom rows route only when the user
selects a row whose catalog metadata and provider config define that route.

To build a native package without installing it:

```bash
make package-custom-models
```

The generated artifact lands under `dist/` in the package format selected by
the host. Override the feature manifest for a downstream package with:

```bash
CUSTOM_MODELS_FEATURES_CONFIG=/path/to/features.json make package-custom-models
```

Do not store provider secrets in feature profiles or catalog metadata.

## AppImage Local Self-Build

```bash
make build-app
make appimage
./dist/codex-desktop-*.AppImage
```

The AppImage flow does not include `codex-update-manager`, the systemd user
service, Polkit policy, or the native-package update builder.

When upstream Codex Desktop changes, rebuild locally:

```bash
git pull --ff-only
make build-app-fresh
make appimage
```

AppImage builds require `appimagetool` on `PATH`, or:

```bash
APPIMAGETOOL=/path/to/appimagetool make appimage
```

## Running The Generated App

By default, second launches reuse the running app through the Linux warm-start
handoff.

Open an independent app process:

```bash
./codex-app/start.sh --new-instance
```

Configure the port range or make every launch use multi-instance mode:

```bash
CODEX_MULTI_LAUNCH_PORT_RANGE=5175-5199 ./codex-app/start.sh --new-instance
CODEX_MULTI_LAUNCH=1 CODEX_MULTI_LAUNCH_PORT_RANGE=5175-5199 ./codex-app/start.sh
```

## Off-Screen Browser QA

For UI QA on an active desktop session, run Codex Desktop inside an isolated
Xvfb display and connect an Electron-capable browser automation tool to the
Chrome DevTools Protocol port. This avoids focusing the visible session while
still exercising the real Electron shell.

```bash
xvfb-run -a -s "-screen 0 1280x900x24" \
  env CODEX_WEBVIEW_PORT=5185 CODEX_MULTI_LAUNCH_PORT_RANGE=5185-5189 \
  /opt/codex-desktop/start.sh --new-instance --x11 -- \
  --remote-debugging-port=9334 \
  --remote-debugging-address=127.0.0.1
```

Use a fresh webview port and CDP port for each independent QA run. Do not treat
the bare webview URL as a complete substitute for Electron QA because that page
lacks the host/preload APIs used by the installed app.

## Electron Mirrors

If runtime downloads from GitHub are slow or blocked:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ make build-app
```

`ELECTRON_HEADERS_URL` is passed to `node-gyp --dist-url` for Electron-targeted
native module rebuilds and must provide both `node-v<version>-headers.tar.gz`
and the matching `SHASUMS256.txt`.

## Build Parallelism

```bash
MAX_BUILD_THREADS=8 make build-app-fresh
MAX_BUILD_THREADS=8 make package
MAX_BUILD_THREADS=8 make install-native
```

`MAX_BUILD_THREADS=0` is the default and preserves each tool's automatic
behavior. A nonzero value controls Cargo jobs, native module rebuild jobs,
Debian package compression, pacman package compression, and RPM zstd payload
compression.

## Make Targets

Run:

```bash
make help
```

Common targets:

```bash
make check
make test
make build-updater
make build-app
make build-app-fresh
make bootstrap-native
make install-native
make install-custom-models
make package-custom-models
make update-native
make run-app
make build-dev-app
make run-dev-app
make deb
make rpm
make pacman
make appimage
make package
make install
make service-enable
make service-status
make clean-dist
make clean-state
```

## Validation

For documentation-only changes, run:

```bash
git diff --check
scripts/workstation/verify-policy.sh
```

For installer, launcher, package, patcher, updater, or feature changes, run the
focused checks listed in [Architecture](architecture.md#validation) and the
repository `AGENTS.md`.
