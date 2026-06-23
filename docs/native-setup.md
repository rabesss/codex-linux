# Native Setup

This project has two native install entrypoints:

- `make install-guided` for a single guided first-install command.
- `make bootstrap-native` for the fastest non-interactive first install.
- `make setup-native` for a guided checklist and optional Linux feature picker.

## Guided Install

```bash
git clone https://github.com/rabesss/codex-desktop-linux.git
cd codex-desktop-linux
make install-guided
```

The wizard performs system checks and feature selection, then installs build
dependencies, rebuilds the app from the official upstream payload, creates the
native package, and installs it. Use `make setup-native` instead when you only
want the checklist or feature configuration and do not want installation work.

After package installation, the app's first-run flow should remain visible even
when the Codex CLI is missing from the user's shell `PATH`; the packaged
launcher/runtime recovery path owns that condition. Invalid or fake API keys
must be rejected before the app advances or writes Codex auth state.

## Fast Native Install

```bash
git clone https://github.com/rabesss/codex-desktop-linux.git
cd codex-desktop-linux
make bootstrap-native
```

`make bootstrap-native` installs build dependencies, regenerates `codex-app/`
from a fresh upstream `Codex.dmg`, builds the matching native package, and
installs the newest artifact from `dist/`.

If dependencies are already installed:

```bash
make install-native
```

For the maintained custom-model Desktop package, run:

```bash
make install-custom-models
```

This uses `profiles/custom-models/features.json` and keeps official
OpenAI/Codex traffic on the first-party provider while enabling custom rows for
the Desktop model picker.
Direct provider rows do not require `codex-shim`; install and run the shim only
for shim or CLIProxyAPI-backed catalog rows.

## Guided Setup

```bash
make setup-native
```

The wizard detects your distro, package manager, native package format, desktop
session, GUI prompt helpers, `pkexec`, portal status, installed package state,
updater state, and optional Linux feature manifests.

It can write the git-ignored `linux-features/features.json` file for the next
build. You can choose features by id, number, or range in the prompt.

The wizard remains separate from `make bootstrap-native`, `make
install-native`, `make package`, and `make install`, which stay non-interactive
for scripts and CI. `make install-guided` explicitly opts the wizard into the
existing dependency and install targets.

## Non-Interactive Feature Selection

```bash
CODEX_LINUX_FEATURES=open-target-discovery,custom-model-catalog \
PACKAGE_WITH_UPDATER=0 \
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
make setup-native
```

To have the wizard orchestrate existing install commands, opt in explicitly:

```bash
CODEX_BOOTSTRAP_DRY_RUN=1 \
CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
make setup-native
```

```bash
CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
make setup-native
```

Build-time feature changes only apply after rebuilding and reinstalling:

```bash
make install-native
```

For a scripted custom-model build, prefer the checked-in profile target:

```bash
make install-custom-models
```

Or pass the same profile explicitly:

```bash
CODEX_LINUX_FEATURES_CONFIG=profiles/custom-models/features.json make install-native
```

For manual-update packages:

```bash
PACKAGE_WITH_UPDATER=0 make install-native
```

## Removed Feature Cleanup

The old Agent Workspaces, Read Aloud, conversation, AppShots, remote-control,
Zed opener, Copilot-effort, and example feature code has been removed from this
repo. The setup wizard no longer treats those ids as supported feature
selections. If an older local install left user-home artifacts behind, remove
only the exact stale paths after confirming they are unused.

## Color Output

The wizard uses ANSI color when the terminal supports it.

```bash
CODEX_BOOTSTRAP_COLOR=0 make setup-native  # disable
CODEX_BOOTSTRAP_COLOR=1 make setup-native  # force
```
