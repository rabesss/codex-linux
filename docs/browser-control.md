# Browser Control

Codex exposes both an in-app Browser backend and an external Chrome-extension
path for driving a real local browser. Both use the official bundled Browser
client. They are separate from the desktop's default-browser setting.

The Linux build stages the bundled Codex Chrome plugin, a native messaging
host, browser-profile discovery patches, and optional target-specific features.
Browser support is on `main`; no feature branch is required.

## Supported Targets

| Browser target | Feature | Status |
|---|---|---|
| Google Chrome | Core | Supported through the standard Linux Chrome plugin patches. |
| Brave Browser stable | Core | Supported through the standard Linux Chrome plugin patches. |
| Chromium | Core | Supported through the standard Linux Chrome plugin patches. |
| Brave Origin Nightly | `brave-origin-browser-control` | Supported when the optional feature is enabled. |

Firefox-family browsers do not use the Chrome extension/native-messaging layout
patched here. Other Chromium-family browsers need explicit executable, profile,
extension, native-host, and launch support before they are treated as supported.

The browser-control target does not have to be the system default browser.
Setup, verification, and plugin patches may read the system default browser for
diagnostics or as a supported-browser tie breaker, but they must not change the
desktop's HTTP/HTML default-browser setting.

## Selection Rules

The patched plugin prefers:

1. A supported profile where the Codex extension is installed.
2. The supported browser matching the read-only
   `xdg-settings get default-web-browser` value.
3. The first existing supported profile root.
4. Google Chrome paths as the fallback shape.

Core native-messaging manifest locations are:

- `~/.config/google-chrome/NativeMessagingHosts`
- `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts`
- `~/.config/chromium/NativeMessagingHosts`

Features can add locations through
`.codex-linux/chrome-native-host-manifest-paths` in the generated app.
`CODEX_CHROME_EXECUTABLE` overrides the opener command, but does not add profile
or manifest support for an unknown browser.

## Setup

For Chrome, Brave stable, or Chromium:

1. Install the browser and the Codex Chrome extension in the intended profile.
2. Build or reinstall Desktop:

   ```bash
   make setup-native
   make bootstrap-native
   ```

3. Launch Desktop once so the native host manifest is synchronized.
4. Confirm the Browser plugin/status surface detects the extension and host.

For Brave Origin Nightly, enable the feature before rebuilding:

```json
{
  "enabled": [
    "brave-origin-browser-control"
  ]
}
```

Then install the extension in Brave Origin Nightly and run:

```bash
make install-native
scripts/workstation/verify-browser-control.sh codex-app
```

The verifier checks the built plugin, manifest, extension state, and a
temporary-profile CDP screenshot. Set
`CODEX_BROWSER_CONTROL_SKIP_CDP_SCREENSHOT=1` only when the environment cannot
launch the selected browser.

## Diagnostics

The standalone screenshot probe accepts a target without changing the default
browser:

```bash
scripts/workstation/verify-browser-cdp-screenshot.js --target chrome
scripts/workstation/verify-browser-cdp-screenshot.js --target brave
scripts/workstation/verify-browser-cdp-screenshot.js --target chromium
```

It can also attach to an existing debugging endpoint:

```bash
scripts/workstation/verify-browser-cdp-screenshot.js \
  --cdp-url http://127.0.0.1:9222 \
  --screenshot /tmp/codex-browser-control.png
```

The native host exposes a local `linuxDiagnostics` JSON-RPC request with
connection counts, pending requests, and rollout-watcher state. Absolute
rollout paths are redacted unless local debugging explicitly requests them.

When the screenshot probe cannot resolve a target, its error includes the
requested target order, candidate executable names, and the read-only
default-browser value it observed. Use those diagnostics to fix the selected
target or explicit executable override; do not change the system default
browser unless the user explicitly asks for that system-level change.

## Custom Models

Custom models use the same native Browser integration as official models. The
Desktop `custom-model-catalog` feature must pass dynamic tools through thread
start, fork, and resume, and the companion
[`codex-shim`](https://github.com/rabesss/codex-shim) must translate namespaced
tools without losing their native item type or namespace on the return path.
For flat MCP connector names such as `mcp__...__get_repo`, the shim must also
restore the Desktop `namespace` field, not only the leaf `name`.

This path does not require Agent Workspaces or a separate workspace-owned
browser runtime. The maintained workstation build uses the patched official
Browser/Chrome plugins and Linux Computer Use backend for both official and
custom-model sessions.

Current Linux builds also adapt the bundled Browser client's node REPL trust
check to the capability-based runtime shape used by current Codex CLI releases.
The client still requires privileged `createElicitation` and `fetch` methods;
it no longer rejects a valid runtime merely because the obsolete
`nodeRepl.config` marker is absent.

Restart Desktop after enabling `js_repl`, in-app Browser, or related app-server
features. Existing sessions retain the tool inventory they started with.

## Backend Constraints

These are current upstream backend constraints, not missing Linux packaging
patches:

- A click on a link with `target="_blank"` can open a browser tab that
  `openTabs()` and `browser.tabs.list()` do not expose. Read the `href` and use
  explicit navigation when the new tab must remain controllable.
- Locator behavior is backend-specific. In-app Browser locators re-resolve
  after reload in current builds. The extension backend can return
  `count() === 0` after navigation without a stale-element error. Re-snapshot
  after page changes and require an exact count of one before acting.
- The exposed Playwright subset has locators, navigation, evaluation,
  screenshots, DOM snapshots, and waits. It does not expose a general `page`,
  `keyboard`, `mouse`, or arbitrary forced-action API. Use only methods listed
  by `browser.documentation()` for the active build.
- `chrome://` pages cannot be claimed.
- Near-duplicate accessible names trigger strict locator failures. Scope to a
  parent or identify a stable selector through read-only evaluation.
- The request schema uses `contentType`, but the extension backend does not
  implement `browser.tabs.content`. Use a tab DOM snapshot or evaluation.
- Navigation performs an upstream site-status safety request. It can add
  several seconds of latency. Do not bypass or cache around that security
  decision in this port.
- In-app Browser does not currently provide a complete HTML5 drag-and-drop or
  file-upload path. Use the external Chrome backend for workflows that require
  a real file chooser.
- The in-app backend may log an unsupported `Target.setAutoAttach` CDP request
  during setup. It is non-blocking when tab navigation and locator actions
  continue to succeed. This is unrelated to model/tool-call `unsupported call`
  errors, which should be triaged through the Desktop dynamic-tool path and
  shim tool translation.
- A telemetry request can occasionally report a lost execution context while
  the Browser action itself succeeds. Treat it as non-blocking unless the
  requested action also failed.
- `agent.documentation.get(...)` is not part of the current Browser surface.
  Use `browser.documentation()` and capability-specific documentation.

## Agent Setup Prompt

```text
Set up Codex Desktop browser control for <browser name> on Linux.

Read AGENTS.md first. Do not change my system default browser unless I ask.
Use main and the existing feature framework. Chrome, Brave stable, and Chromium
use the core path. Brave Origin Nightly uses the brave-origin-browser-control
feature. For an unsupported browser, explain the required executable, profile,
extension, native-host, and test work before changing files.

Verify extension installation, native-host manifest sync, app launch, plugin
status, and a real Browser action. Do not store secrets or modify unrelated
browser profiles.
```

## Adding Another Browser

A new browser feature should:

- add native-host manifest locations;
- patch browser detection, extension checks, running-process checks, profile
  discovery, and launch behavior;
- preserve extension id and host metadata;
- leave the system default browser unchanged unless explicitly requested;
- include disabled-by-default, successful-staging, and upstream-drift tests.
