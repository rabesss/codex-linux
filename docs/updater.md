# Auto-Update Manager

Native packages install `codex-update-manager`, a user service and command-line
tool that rebuilds local Linux packages for Codex Desktop.

The updater is designed around two separate channels:

| Channel | What changes | Default install policy |
|---|---|---|
| Upstream Codex app | The official OpenAI Codex Desktop DMG and its metadata | Install only approved app pins by default. Treat newer live DMGs as candidates until validated and promoted. |
| Linux wrapper | This repository's installer, patches, package builders, updater, launcher, features, and docs | Update wrapper machinery independently when a newer wrapper is required or available. |

One user-facing updater can report both channels, but it should keep their
metadata, validation evidence, and rollback stories separate.

## Updater Responsibilities

`codex-update-manager`:

- checks for approved upstream app pins and optional wrapper updates;
- downloads upstream DMGs locally when an approved pin needs to be rebuilt;
- verifies the downloaded DMG hash before patching;
- rebuilds a native package with the packaged update-builder bundle;
- preserves the user's selected Linux feature config for rebuilds;
- validates required patch points before publishing a rebuilt package;
- waits for Codex Desktop to exit before installing;
- requests explicit operating-system authorization for the final package
  install;
- keeps the existing install active when patch validation or package build
  fails;
- records status, logs, and rollback metadata for recovery.

The resident updater is included in native Debian/Ubuntu, Fedora/openSUSE, and
Arch-family packages. AppImage builds do not include it.

## Approved App Pins And Candidates

The default upstream app path is governed by an approval record. An approved pin
contains metadata only: official DMG URL, upstream version, SHA256, size, HTTP
metadata when available, validation evidence, approval timestamp, and minimum
wrapper revision.

A candidate is a newly discovered upstream DMG that has not completed the
promotion process. Candidates can be useful for maintainer visibility, CI patch
reports, and local dogfood, but they are not the default end-user install
source.

Normal push and pull-request CI does not use the mutable live upstream DMG as a
gate. It validates committed updater policy, metadata, package fixtures, and
flake evaluation. The scheduled/manual upstream DMG watcher owns live drift: it
downloads the current official DMG, builds it, validates required patches, and
then creates either metadata-only candidate evidence or a patch-drift issue.
Promotion remains a reviewed Git change.

The updater must block or fail closed when:

- the downloaded DMG does not match the approved SHA256;
- the approved pin requires a newer wrapper than the installed update-builder;
- required patch descriptors drift or emit blocking validation failures;
- a package cannot be built or cannot be installed with explicit OS
  authorization.

## Normal User Flow

Most users only need to choose **Update** in Codex Desktop, or close the app
when the ready notification appears. The updater installs the rebuilt package
after authorization succeeds and reopens Codex Desktop when appropriate.

The same flow is available from a terminal:

```bash
codex-update-manager check-now
codex-update-manager status
codex-update-manager install-ready
```

`install-ready` does not overwrite a running app. It records that installation
should continue after Codex Desktop exits.

If a rebuild fails before a package is ready, inspect `status` first. Current
builds include the workspace log path in `update_error`; fixing the reported
patch drift and running `check-now` is preferable to deleting updater state.

## Wrapper Updates

Wrapper updates are changes to this repository's Linux packaging and runtime
machinery. They are separate from upstream app pins.

Optional wrapper-update tracking can be enabled with:

```toml
enable_wrapper_updates = true
```

in the updater config file.

Git checkout builders can compare the installed wrapper commit with a remote
branch and stage a wrapper candidate. Frozen native-package builders usually do
not have a `.git` directory, so they rely on installed build metadata and normal
package upgrades instead of assuming that `/opt/codex-desktop/update-builder`
is a live checkout.

If an approved upstream app pin declares a newer minimum wrapper revision than
the installed builder, the updater should update or ask the user to update the
wrapper first. It should not attempt a DMG rebuild with stale patch machinery.

## Authorization Model

The updater runs unprivileged. Only the final package install or rollback needs
system authorization.

Native packages ship a Polkit policy for constrained updater install commands.
On desktops with a graphical Polkit agent, the prompt should appear as a normal
system authorization dialog. On minimal window managers, the updater may open a
terminal so the same install action can be authorized there.

If automatic authorization cannot be opened, the package remains ready and
`codex-update-manager status` prints a recovery command using the detected
package format. This prompt is OS package authorization, not Codex account,
provider API, or keyring authentication. The updater does not store or forward
passwords.

## Local Rebuild Workspaces

Update rebuilds happen under the user's updater cache. Each workspace contains
the downloaded DMG, copied update-builder bundle, generated `codex-app/`, logs,
patch reports, and native package artifact.

The ready package stays in the workspace until installation succeeds or a newer
approved candidate supersedes it. Do not upload these workspaces as public CI
artifacts because they can contain OpenAI application payloads.

Runtime files:

```text
~/.config/codex-update-manager/config.toml
~/.local/state/codex-update-manager/state.json
~/.local/state/codex-update-manager/service.log
~/.cache/codex-update-manager/
```

Inspect state:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
```

## Rollback

If a rebuilt update installs but the previous retained package was better,
close Codex Desktop and run:

```bash
codex-update-manager rollback
```

Rollback uses the last retained known-good package and refuses to run when no
rollback package is available. Rollback uses the same explicit OS authorization
boundary as normal package installs.

## Manual-Update Packages

Build a native package without the resident updater:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

That package omits `codex-update-manager`, the user service unit, updater
Polkit policy, `/opt/codex-desktop/update-builder`, desktop updater actions,
and launcher updater startup checks.

Installing a no-updater package over a default package also stops and disables
existing updater service instances where possible.

Manual updates should come from a checkout you trust:

```bash
PACKAGE_WITH_UPDATER=0 make update-native
```

`make update-native` runs `git pull --ff-only`, regenerates `codex-app/` from a
fresh upstream DMG, builds the native package, and installs it.

## Manual Promotion Checklist

Maintainers should promote an upstream app candidate only after:

1. Recording DMG URL, upstream version, SHA256, size, ETag, and `Last-Modified`.
2. Running upstream-build validation and preserving the patch report.
3. Confirming CI artifacts contain no DMG, extracted `.app`, rebuilt package,
   or other OpenAI application payload.
4. Verifying the wrapper revision used for validation is committed and pushed.
5. Rebuilding a local native package from the candidate.
6. Running focused updater/package checks and `codex-desktop-doctor`.
7. Dogfooding launch, session reuse, update UI, and relevant optional features.
8. Confirming official Codex/OpenAI routing remains direct.
9. Recording the minimum wrapper revision required by the approved pin.
10. Updating the approved app pin in Git with reviewable metadata only.

The upstream watcher can produce two records:

- candidate evidence when the live DMG differs from the approved pin and all
  required patches validate;
- patch-drift evidence when a required patch is missing, obsolete, or needs a
  semantic retarget before the DMG can be promoted.

The metadata-only CI artifact contains `upstream-dmg-candidate.json`. After
local dogfood passes, promote it with:

```bash
node scripts/ci/promote-upstream-dmg-lock.js \
  release/upstream-dmg-lock.json \
  --from-candidate-manifest /path/to/upstream-dmg-candidate.json \
  --repo-dir "$PWD" \
  --approved-by manual \
  --notes "Passed local dogfood."

node scripts/ci/validate-upstream-dmg-lock.js release/upstream-dmg-lock.json
```

If the candidate manifest was produced outside GitHub Actions, pass
`--wrapper-min-commit <40-character-sha>` so the approved pin records the exact
wrapper revision used for validation.

## Service Controls

```bash
make service-enable
make service-status
codex-update-manager status --json
```

`make service-enable` is meant for installed native packages, not repo-only
generated apps.
