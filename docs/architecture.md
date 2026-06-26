# Architecture

This repository adapts the official upstream macOS Codex Desktop DMG into a
Linux app and native package. It is a wrapper and compatibility layer, not a
redistribution channel for OpenAI application binaries.

The architecture is governed by two independent channels:

```text
Upstream Codex app channel
  official DMG metadata -> validation -> candidate -> manual promotion -> approved pin

Linux wrapper channel
  installer/patches/features/updater/package builders -> wrapper release/update
```

The updater may present one UI, but the channels keep separate provenance,
validation, rollback, and promotion decisions.

## Upstream App Channel

The upstream app channel tracks the official OpenAI Codex Desktop DMG by
metadata and SHA256. A newly observed DMG is a candidate until CI validation and
manual dogfood promote it into the approved pin set.

Approved app pin metadata should include:

- upstream app version;
- official DMG URL;
- SHA256 and size;
- ETag and `Last-Modified` when available;
- patch report or validation evidence;
- approval timestamp and process marker;
- minimum wrapper revision required to rebuild safely.

No approved-pin, CI, or public-release artifact should include the DMG, extracted
`.app`, rebuilt `codex-app/`, or native package payload containing OpenAI app
code.

## Linux Wrapper Channel

The wrapper channel is this repository's Linux implementation:

- `install.sh`, `Makefile`, and `scripts/lib/`;
- `scripts/patches/core/` descriptors;
- `linux-features/`;
- `launcher/start.sh.template` and webview server support;
- `packaging/`;
- `updater/`;
- `computer-use-linux/`;
- public docs and validation scripts.

Wrapper updates can be required before an approved upstream app pin is safe to
consume. Packaged update-builders are frozen source bundles, so they must carry
build metadata and policy files instead of assuming a live `.git` checkout.

## Build Pipeline

1. `install.sh` extracts `Codex.dmg` with `7z` or `7zz`.
2. It detects the Electron version from upstream metadata, with a pinned
   fallback when needed.
3. It extracts and patches `app.asar` through the core patch registry.
4. Enabled optional `linux-features/` descriptors add patches, resources,
   runtime hooks, and package hooks.
5. Native Node modules such as `better-sqlite3` and `node-pty` are rebuilt for
   Linux through `@electron/rebuild`.
6. A matching Linux Electron runtime is downloaded.
7. Bundled Linux integration and managed runtime resources are staged.
8. The Linux launcher is generated into `codex-app/start.sh`.
9. Package builders repackage `codex-app/` into `.deb`, `.rpm`,
   `.pkg.tar.zst`, or AppImage artifacts.
10. Default native packages install `codex-update-manager`, a systemd user
    service, Polkit policy, and update-builder bundle.

The installer replaces the macOS Electron binary with a Linux build, recompiles
native modules, and removes macOS-only pieces such as Sparkle.

## Patch System

Core Linux compatibility patches live under `scripts/patches/core/`.
Descriptors declare phase, order, target filters, and CI policy. They are
fail-soft unless explicitly marked as required for upstream-build validation.

Optional additions belong under `linux-features/`. Feature descriptor ids are
namespaced in patch reports and are optional by default.

Upstream-drift automation validates required descriptors against candidate DMGs
and publishes patch reports as metadata-only artifacts. A missing required patch
blocks promotion; it should not create a public rebuilt app payload.

Filename patterns are only a targeting aid for minified Vite chunks. Required
patches should prefer semantic detectors that prove one of three states:

- the patch was applied;
- upstream already has equivalent Linux-safe behavior;
- the upstream surface drifted or disappeared and needs maintainer review.

Patch reports should make those states explicit so maintainers know whether to
retarget, retire, or keep a descriptor before promoting a new DMG.

## Launcher

The launcher serves extracted webview assets from `content/webview/` on
`127.0.0.1`, validates the origin, then starts Electron.

When installed build metadata changes, the launcher invalidates only disposable
Electron web caches so new hashed asset contents cannot be hidden by an old
cache entry. User profile data, chats, cookies, and settings are not removed.

Warm-start launches hand off actions such as `--new-chat` over a Unix-domain
socket instead of spawning a second app process.

Native-package-only launcher behavior, such as desktop-entry hints and default
update-manager startup, lives in:

```text
packaging/linux/codex-packaged-runtime.sh
```

The current evaluation for a future Rust replacement of the local webview
server lives in [webview-server-evaluation.md](webview-server-evaluation.md).

## Updater

`codex-update-manager` is an unprivileged local rebuild and install coordinator.
It can check approved app pins, detect optional wrapper updates, rebuild a local
native package with the packaged update builder, wait for app exit, and request
explicit OS authorization for package install or rollback.

The updater should fail closed when the DMG hash does not match the approved
pin, when required patches drift, or when the installed wrapper is older than
the minimum wrapper revision required by an approved pin.

See [Updater](updater.md).

## Custom Model Integration

Custom models use explicit catalog rows instead of changing the global Codex
provider:

```text
custom catalog JSON or optional adapter catalog
  -> Desktop model picker and thread lifecycle
  -> selected row's model_provider
  -> configured provider endpoint
```

`rabesss/codex-linux` owns the Desktop bundle patches. Its
`custom-model-catalog` feature merges the custom catalog and preserves the
selected custom model, provider, session config, and dynamic tools across
thread start, fork, and resume. It also stages a Desktop-only Codex CLI wrapper
that launches `codex app-server` with a merged `model_catalog_json`, so custom
context windows, compaction thresholds, truncation limits, reasoning levels,
image support, and verified tool support reach Codex core instead of only
decorating picker labels.

`rabesss/codex-shim` is an optional companion adapter for rows that need local
request translation. It is not required for official rows, and it is not a
replacement for first-party OpenAI/Codex routing.

Official rows bypass local custom-provider adapters and continue to use
`model_provider = "openai"`. This is an architectural invariant, not a setup
preference.

## Security And Credentials

Public repository content must not include plaintext secrets, provider keys,
debug payload captures, private service units, local credential paths, or
machine-local launchers that inject credentials.

Catalog metadata describes model capabilities and routing labels; it does not
store API keys. Package installation authorization is handled by the operating
system through Polkit or the package manager and is separate from Codex account
or provider credentials.

## Validation

Run the subset that matches your change. For documentation-only changes:

```bash
git diff --check
scripts/workstation/verify-policy.sh
```

For installer, packaging, patcher, or updater changes:

```bash
bash -n install.sh scripts/lib/*.sh launcher/start.sh.template scripts/build-deb.sh scripts/build-rpm.sh scripts/build-pacman.sh scripts/build-appimage.sh scripts/install-deps.sh
node --check scripts/patch-linux-window-ui.js
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
cargo check -p codex-computer-use-linux
cargo test -p codex-computer-use-linux
make package
```

Before promoting an upstream app candidate, also validate the candidate DMG,
review patch reports, inspect package contents when packaging changed, and
confirm that public artifacts do not contain OpenAI app payloads.

For contribution policy and review expectations, see
[CONTRIBUTING.md](../CONTRIBUTING.md).
