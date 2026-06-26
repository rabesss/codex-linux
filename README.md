# Codex Desktop Linux

Codex Desktop Linux is an unofficial Linux wrapper for OpenAI Codex Desktop.
It builds a local Linux app from the official upstream Codex Desktop DMG, then
packages that app for the user's machine.

This repository does not publish ready-made app packages and does not
redistribute OpenAI application binaries. The upstream Codex Desktop DMG is
downloaded or provided by the user during local build and update flows. Public
CI publishes validation evidence only: metadata, hashes, patch reports, logs,
and review records.

## Start Here

| Need | Use |
|---|---|
| First install on this machine | `make install-guided` |
| Build from a DMG you already downloaded | `make build-app DMG=/path/to/Codex.dmg && make package && make install` |
| Check what upstream app version and package paths are supported | [SUPPORTED.md](SUPPORTED.md) |
| Check the installed app | `codex-desktop-doctor` or `codex-desktop-doctor --json` |
| See current CI validation state | The live badges and workflow links in [SUPPORTED.md](SUPPORTED.md) |

The normal first install is:

```bash
git clone https://github.com/rabesss/codex-linux.git
cd codex-linux
make install-guided
```

The guided installer checks host dependencies, downloads the official upstream
Codex Desktop app locally, applies the Linux wrapper patches, builds a native
package for the current distribution, and installs it with explicit system
authorization.

Supported package-builder paths include Debian/Ubuntu `.deb`,
Fedora/openSUSE `.rpm`, Arch-family pacman packages, Nix flake metadata and
manual package-output refreshes, and local AppImage self-builds. CI validates
the non-redistributing builder surfaces, but CI fixture packages are not release
packages for users.

## Use The App

Launch from the desktop menu or run:

```bash
codex-desktop
```

Check readiness:

```bash
codex-desktop-doctor
codex-desktop-doctor --json
```

Check updater state:

```bash
codex-update-manager status
codex-update-manager status --json
```

When an approved upstream app update exists, the updater rebuilds a local native
package from the approved DMG pin. If OpenAI publishes a newer DMG before this
repo approves it, the updater may report a candidate, but the default update
path should not install that unapproved candidate.

Before installing or reporting a compatibility issue, check [supported versions
and validation](SUPPORTED.md). That generated file is CI-checked on every push
and pull request. Historical failed workflow runs can remain visible in GitHub
after a follow-up commit fixes them, so use the current `main` badges and the
latest workflow runs when judging support status.

## What This Fork Adds

This project is heavily inspired by
[`ilysenko/codex-desktop-linux`](https://github.com/ilysenko/codex-desktop-linux):
that project established the practical local-conversion model for turning the
official Codex Desktop app into Linux packages. This fork keeps that model and
adds governed upstream-app promotion, stricter release boundaries, optional
custom-model routing, and package-focused Linux maintenance.

This repository is not a binary mirror of Codex Desktop and is not a blind
"latest DMG" updater. It keeps two update streams separate:

| Channel | Owns | Default user effect |
|---|---|---|
| Upstream Codex app channel | Official OpenAI DMG URL, version metadata, SHA256, size, HTTP metadata, patch-validation status, approved pins | Users receive only approved upstream app pins by default. Newer live DMGs are candidates until validated and promoted. |
| Linux wrapper channel | Installer, patch descriptors, updater code, Linux feature framework, package builders, launcher, bundled Linux integration, docs | Wrapper changes can update the local rebuild machinery independently from an upstream app pin. |

One updater UX can report both channels, but provenance, validation state,
rollback, and promotion are intentionally separate.

## How Updates Work

Native packages include `codex-update-manager`, a user service and CLI that can
rebuild a Linux package from an approved upstream app pin.

The governed flow is:

1. The scheduled/manual upstream DMG watcher detects upstream DMG metadata.
2. The candidate DMG is downloaded only inside the validation environment.
3. The Linux patch set is applied and a patch report is produced.
4. If validation passes, automation records metadata-only candidate evidence.
5. If validation fails, automation records a patch-drift issue with the failed
   required descriptors and patch report.
6. A maintainer performs local dogfood and review.
7. A promoted approval record pins the upstream app version, URL, SHA256, size,
   validation evidence, and minimum wrapper revision.
8. End-user update checks consume the approved record by default.

If OpenAI publishes a newer DMG before it is approved, the updater may report
that a candidate exists, but it should not replace the installed app from that
unapproved candidate in the default path.

Normal push and pull-request CI does not download the mutable live
`Codex.dmg`. It validates committed metadata, updater policy, package fixtures,
patch code, docs, and flake evaluation. Live upstream drift is isolated to the
upstream watcher and the Nix refresh workflow that runs after watcher success
or explicit maintainer dispatch.

## Approved Upstream App Pins

An approved upstream app pin is the release contract for the OpenAI app
payload. It should contain only portable metadata:

- upstream app version;
- official DMG URL;
- SHA256 and size;
- ETag and `Last-Modified` when available;
- approval timestamp and reviewer/process marker;
- minimum Linux wrapper revision required to rebuild safely;
- links or paths to metadata-only patch reports.

The approval record must not contain local filesystem paths, debug payload
captures, secrets, extracted app files, DMG payloads, or native packages
containing OpenAI application code.

## Wrapper Updates

The Linux wrapper channel covers this repository's own code and package
machinery: `install.sh`, patch descriptors, `linux-features/`, the updater,
package builders, launcher templates, bundled Linux integration, and docs.

Wrapper updates matter because a future upstream DMG may require newer patch or
builder logic before it can be safely consumed. A governed updater should either
apply the required wrapper machinery first or block with a clear message instead
of attempting a rebuild with stale patch code.

Packaged installs are frozen copies, not live Git checkouts. Runtime wrapper
checks therefore rely on installed build metadata or package upgrades; they
should not assume that `/opt/codex-desktop/update-builder` has a `.git`
directory.

## Build And Package Flow

The normal local build flow is:

```text
official Codex.dmg
  -> local extraction
  -> Linux patch descriptors and enabled features
  -> Linux Electron runtime and rebuilt native modules
  -> codex-app/
  -> native package or AppImage
```

Supported package flows include Debian/Ubuntu `.deb`, Fedora/openSUSE `.rpm`,
Arch-family `.pkg.tar.zst`, and local AppImage self-builds. Native packages are
preferred because they install the launcher, desktop entry, icon, MIME/URL
integration, Polkit policy, updater service, and packaged update builder.

Common distribution dependency commands:

```bash
# Fedora 41+
sudo dnf install python3 7zip curl unzip rpm-build @development-tools

# Fedora < 41
sudo dnf install python3 p7zip p7zip-plugins curl unzip rpm-build
```

Common commands:

| Situation | Command |
|---|---|
| Guided first install | `make install-guided` |
| Non-interactive native install | `make bootstrap-native` |
| Dependencies are already installed | `make install-native` |
| Build without installing | `make build-app-fresh` |
| Build and install a native package | `make package && make install` |
| Build a specific package format | `make deb`, `make rpm`, `make pacman`, or `make appimage` |
| Build from a local DMG | `make build-app DMG=/path/to/Codex.dmg` |
| Build the public custom-model profile | `make package-custom-models` |

The package scripts repackage `codex-app/`; they do not download or extract the
DMG themselves.

## Optional Linux Features

Core Linux compatibility is part of the base build. Optional features live
under `linux-features/` and are disabled unless selected before building.

Public examples include:

| Feature | ID | Purpose |
|---|---|---|
| Open target discovery | `open-target-discovery` | Discover local launch targets from Linux desktop entries. |
| Wrapper updater UI | `codex-wrapper-updater` | Expose Linux wrapper update actions inside the app. |
| Custom model catalog | `custom-model-catalog` | Add provider-aware custom rows to the Desktop model picker. |
| Browser target override | `brave-origin-browser-control` | Use a reviewed optional browser-control target instead of the portable default. |

The guided installer can write the feature config. Advanced users can create
`linux-features/features.json` manually:

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

## Custom Models Boundary

Custom-model support is optional and route-explicit.

Official Codex/OpenAI account traffic should stay on the first-party route.
Do not make the global Codex provider a shim or proxy just because custom rows
are enabled.

When `custom-model-catalog` is enabled, Desktop can read a local catalog of
custom rows. Each row declares its own provider route and capabilities. Direct
or local providers use their own Codex provider config. `rabesss/codex-shim` is
an optional companion adapter for rows that need a local translation layer; it
is not part of the official OpenAI route.

Catalog metadata may describe display names, provider labels, context windows,
reasoning support, image support, and tool support. It must not store API keys
or other credentials. Keep provider secrets in the user's normal Codex or OS
credential mechanism.

For the public custom-model package profile:

```bash
make install-custom-models
make package-custom-models
```

That profile enables `open-target-discovery`, `codex-wrapper-updater`, and
`custom-model-catalog`. It intentionally leaves local browser target policy out
of the public default.

See [Custom models](docs/custom-models.md) for catalog examples and
capability fields.

## Security And Credentials

Security expectations for public builds and docs:

- Do not redistribute the official OpenAI DMG, extracted `.app`, or native
  packages that contain OpenAI app code.
- Do not commit plaintext API keys, session tokens, debug payload captures,
  private launchers, or service units that inject secrets.
- Keep official OpenAI/Codex traffic direct unless the user explicitly selects
  a custom row with its own route.
- Keep custom provider credentials outside catalog metadata.
- Treat package installation as operating-system authorization. Polkit or the
  package manager may ask for a login/admin password; that is distinct from
  Codex account, keyring, or provider API credentials.
- Keep optional downloads and integrations behind reviewed feature boundaries.

## Manual Promotion Checklist

Before promoting a new upstream app pin:

1. Capture DMG URL, version, SHA256, size, ETag, and `Last-Modified`.
2. Validate the candidate against the Linux patch set and save the patch report.
3. Confirm CI artifacts contain only metadata, hashes, logs, and reports.
4. Verify the wrapper revision used for validation is committed and pushed.
5. Rebuild a local package from the candidate and run focused updater/package
   checks.
6. Dogfood the installed app: launch, login/session reuse, update UI, browser
   integration when enabled, and `codex-desktop-doctor`.
7. Confirm official Codex/OpenAI routing remains direct.
8. Record the minimum wrapper revision required by the approved pin.
9. Promote the candidate by updating the approved app pin in Git.
10. Keep rollback instructions and the previous known-good package/version
    reachable.

## Troubleshooting First Installs

| Symptom | First check |
|---|---|
| Dependencies are missing | Run `make bootstrap-native`; it calls the dependency installer for supported distributions. |
| An update is ready but no graphical authorization appears | Close Codex Desktop, run `codex-update-manager status`, then follow the printed recovery command. |
| The app launches with Wayland sizing or popup issues | Try `codex-desktop --x11`. |
| Browser control does not work | Check the selected browser/profile integration with `codex-desktop-doctor`. |
| Custom models do not appear | Confirm `custom-model-catalog` is enabled and the catalog is readable. |
| Unsure what state the install is in | Run `codex-desktop-doctor --json` and include that output in a bug report. |

More detail is in [Build and packaging](docs/build-and-packaging.md),
[Updater](docs/updater.md), [Architecture](docs/architecture.md), and
[Troubleshooting](docs/troubleshooting.md).

## Project Docs

- [Supported versions and validation](SUPPORTED.md)
- [Architecture](docs/architecture.md)
- [Build and packaging](docs/build-and-packaging.md)
- [Updater](docs/updater.md)
- [Native setup](docs/native-setup.md)
- [Custom models](docs/custom-models.md)
- [Browser Control](docs/browser-control.md)
- [Linux Features architecture](docs/linux-features-architecture.md)
- [Linux Computer Use](docs/linux-computer-use.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Nix](docs/nix.md)
- [Webview server evaluation](docs/webview-server-evaluation.md)

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI.
This repository automates a local conversion and Linux packaging process around
the official app payload. It is not endorsed by OpenAI or by the inspiration
project unless those maintainers explicitly say otherwise.

## License

MIT
