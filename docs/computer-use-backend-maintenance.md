# Computer Use Backend Maintenance

This is the long-term maintenance plan for the owned Linux Computer Use
backend. It is maintainer-facing and public-safe: keep examples generic, avoid
local machine paths, and do not add private setup notes.

## Backend Contract

The shipped contract has three layers:

- Plugin metadata:
  `plugins/openai-bundled/plugins/computer-use/.codex-plugin/plugin.json`
  and `.mcp.json` keep the public plugin name, interface copy, MCP server name,
  command, and default prompts. Bump the plugin version when tool schemas,
  user-visible setup behavior, or backend capability semantics change.
- MCP backend:
  `computer-use-linux` owns the `codex-computer-use-linux mcp` server, doctor
  output, setup commands, app/window listing, screenshots, accessibility trees,
  and input tools. Keep tool names and response fields stable unless there is a
  coordinated Desktop-side migration.
- Window backend descriptors:
  `BackendDescriptor` entries own the stable backend id, failure label,
  list-note text, missing-dependency hint, and exact-focus capability. Backend
  ids become persisted diagnostics and test selectors, so rename only with a
  compatibility plan.

Descriptor and doctor output must stay free of host-specific paths. If a check
must mention a path from the live session, redact or keep it in a local-only
detail field rather than in static docs or plugin metadata.

## Session Eligibility

Window backends should be eligible before they are probed. The registry derives
eligibility from session environment such as `XDG_CURRENT_DESKTOP`,
`XDG_SESSION_DESKTOP`, `DESKTOP_SESSION`, `XDG_SESSION_TYPE`,
`WAYLAND_DISPLAY`, `DISPLAY`, `SWAYSOCK`, `I3SOCK`, and compositor-specific
hints.

Rules for maintainers:

- Probe only the likely backend set for known sessions.
- Keep `CODEX_COMPUTER_USE_PROBE_ALL_BACKENDS=1` as the debug escape hatch.
- Keep `CODEX_COMPUTER_USE_WINDOW_BACKENDS=...` as an ordered forced-probe
  override for local diagnosis and CI fixtures.
- Unknown desktops may fall back to the full backend list, but skipped backend
  probes should be explicit in `doctor` so users can see why a backend did not
  run.
- Backend probes must be read-only, short-lived, and safe to run repeatedly.

Adding a backend means adding all of these together: a descriptor, a session
eligibility rule, a read-only probe, list/focus implementations, doctor
capability mapping, fixture coverage, and packaging dependency notes.

## Compositor Boundaries

Use each compositor's own public or session-local API. Do not treat a
neighboring compositor as compatible unless the protocol and failure mode are
explicitly tested.

| Backend | Allowed API surface | Boundary |
| --- | --- | --- |
| GNOME Shell extension | Bundled extension plus session DBus | Exact window focus belongs to the extension backend. Introspect remains app-level focus only. |
| GNOME Shell Introspect | `org.gnome.Shell.Introspect` and app activation | Must fail closed for `window_id`, title, PID, or terminal-exact targets. |
| KWin/Plasma | Session DBus scripting through KWin | Scripts must be temporary and unloaded after use. |
| Hyprland | `hyprctl` JSON, verified focus, and `grim -g` for targeted capture | Targeted screenshots must verify the focused native address before capture. |
| Sway | `swaymsg` IPC with vetted Sway sockets | Clear inherited i3/Sway socket env and pass only a validated Sway socket. |
| COSMIC | Bundled COSMIC Wayland helper | Keep protocol details inside the helper so the main MCP server stays portable. |
| i3/X11 | `i3-msg`, X11 display state, and `xprop` for best-effort PID hydration | Do not let stale `I3SOCK` classify known Wayland desktops as i3. |

Generic wlroots support should be added only when a stable, testable protocol
can provide list, focus, and screenshot targeting semantics comparable to the
compositor-specific adapters.

## Fixtures And Mocks

Prefer deterministic parser and command-construction tests over live-desktop
unit tests. The live compositor remains a smoke-test target, not a requirement
for every contributor.

Fixture expectations:

- Store sanitized compositor JSON, DBus-like maps, and command replies under a
  fixture directory or as small inline constants.
- Strip real usernames, window titles, workspace names, PIDs, paths, and app
  data from fixtures.
- Mock command runners for `hyprctl`, `swaymsg`, `i3-msg`, KWin scripts,
  portal calls, and helper binaries before adding new live shell calls.
- Cover session eligibility with synthetic environment structs instead of
  mutating the real process environment in broad tests.
- Keep one fixture per behavior: empty list fallback, malformed output,
  successful focus, failed focus, hidden/minimized windows, and terminal
  metadata enrichment.

## Acceptance Gates

Use the lightest gate that proves the changed surface.

Docs-only changes:

- `git diff --check`
- markdown structure review of changed docs
- `scripts/workstation/verify-policy.sh` when available

Backend or metadata changes:

- `cargo fmt --check`
- `cargo test -p codex-computer-use-linux`
- focused tests for the touched parser, eligibility rule, or descriptor
- plugin metadata sanity check for `.codex-plugin/plugin.json` and `.mcp.json`
- package staging check that both `codex-computer-use-linux` and
  `codex-computer-use-cosmic` are copied with executable mode

Compositor acceptance:

- `doctor` reports a clear preferred backend and actionable missing hints.
- `list_windows` returns stable `WindowInfo` with backend id, title/app ids when
  available, bounds when available, and hidden/focused state.
- Exact-focus targets fail closed when the backend cannot prove exact focus.
- Targeted screenshots never relabel full-screen or active-window pixels as a
  requested target.
- Input after a targeted screenshot translates from window-local to global
  coordinates only after target re-verification.

## Packaging Dependency Map

Keep dependency notes grouped first by compositor, then by distro. Package
names vary by release, so docs should describe the required capability and list
known package names without hard-coding unsupported distros into the backend.

Common dependencies:

| Capability | Debian/Ubuntu | Fedora | Arch/Manjaro | openSUSE |
| --- | --- | --- | --- | --- |
| Accessibility tree | `at-spi2-core` | `at-spi2-core` | `at-spi2-core` | `at-spi2-core` |
| Portal base | `xdg-desktop-portal` | `xdg-desktop-portal` | `xdg-desktop-portal` | `xdg-desktop-portal` |
| Fallback input | `ydotool` or `ydotoold` | `ydotool` | `ydotool` | `ydotool` |

Compositor-specific dependencies:

| Compositor | Required capability | Debian/Ubuntu | Fedora | Arch/Manjaro | openSUSE |
| --- | --- | --- | --- | --- | --- |
| GNOME | Shell session, Introspect DBus, portal backend | `gnome-shell`, `xdg-desktop-portal-gnome` | `gnome-shell`, `xdg-desktop-portal-gnome` | `gnome-shell`, `xdg-desktop-portal-gnome` | `gnome-shell`, `xdg-desktop-portal-gnome` |
| KWin/Plasma | KWin scripting and KDE portal | `kwin-wayland`, `plasma-desktop`, `xdg-desktop-portal-kde` | `kwin`, `plasma-desktop`, `xdg-desktop-portal-kde` | `kwin`, `plasma-desktop`, `xdg-desktop-portal-kde` | `kwin6`, `plasma6-desktop`, `xdg-desktop-portal-kde` |
| Hyprland | `hyprctl`, Hyprland portal, targeted `grim` capture | `hyprland`, `xdg-desktop-portal-hyprland`, `grim` where packaged | `hyprland`, `xdg-desktop-portal-hyprland`, `grim` where packaged | `hyprland`, `xdg-desktop-portal-hyprland`, `grim` | `hyprland`, `xdg-desktop-portal-hyprland`, `grim` where packaged |
| Sway | `swaymsg`, Sway IPC, wlroots portal | `sway`, `xdg-desktop-portal-wlr`, `grim` | `sway`, `xdg-desktop-portal-wlr`, `grim` | `sway`, `xdg-desktop-portal-wlr`, `grim` | `sway`, `xdg-desktop-portal-wlr`, `grim` |
| COSMIC | COSMIC session plus bundled helper access | `cosmic-session` where packaged | `cosmic-session` where packaged | `cosmic-session` where packaged | `cosmic-session` where packaged |
| i3/X11 | i3 IPC and X11 property lookup | `i3-wm`, `x11-utils` | `i3`, `xorg-x11-utils` | `i3-wm`, `xorg-xprop` | `i3`, `xprop` |

When adding a new package requirement, update both the user-facing setup doc
and this maintenance map in the same change.

## Backend Order

Long-term backend ownership should proceed in this order:

1. GNOME: extension plus Introspect.
2. KWin/Plasma.
3. wlroots family: Hyprland, then Sway, then generic wlroots only after a
   stable protocol and fixtures exist.
4. COSMIC.
5. i3/X11.

Runtime probing still remains session-specific. Do not reorder the runtime
backend registry merely to match roadmap priority; reorder only when the
current session could legitimately expose more than one compatible backend and
the new order is covered by tests.
