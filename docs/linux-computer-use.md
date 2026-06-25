# Linux Computer Use

Linux Computer Use is an opt-in UI surface backed by a native Rust MCP backend,
`codex-computer-use-linux`. The backend is bundled and registered by default;
the in-app Computer Use controls are disabled until you opt in.

It supports:

- app listing and accessibility trees through AT-SPI
- screenshots through GNOME Shell DBus, XDG Desktop Portal, or Hyprland `grim`
  region capture for verified targeted windows
- window listing and focusing on GNOME, KWin/Plasma, Sway IPC, Hyprland,
  COSMIC, and i3
- keyboard, text, click, scroll, and drag input through `/dev/uinput`, XDG
  RemoteDesktop portal, or `ydotool`

## Runtime Dependencies

Install `ydotool` when you need the fallback input path:

```bash
# Debian / Ubuntu
sudo apt install ydotool
sudo apt install ydotoold   # on Ubuntu releases that split the daemon

# Fedora
sudo dnf install ydotool

# Arch / Manjaro
sudo pacman -S ydotool

# openSUSE
sudo zypper install ydotool
```

The preferred coordinate input path opens `/dev/uinput` directly. The XDG
RemoteDesktop portal can also provide input on desktops that expose it.

For `ydotool`, run a daemon and make sure your user can access the socket:

```bash
sudo systemctl enable --now ydotoold
sudo usermod -a -G input "$USER"
```

Then log out and back in.

Some distros name the unit `ydotool.service` instead of `ydotoold.service`, and
some install `/usr/bin/ydotoold` without a service unit. If the system unit path
is awkward, a user-session service that binds `%t/.ydotool_socket` is also
valid.

Portal packages are needed when your desktop relies on XDG Desktop Portal input
or screenshots:

- KDE Plasma: `xdg-desktop-portal-kde`
- sway/wlroots: `xdg-desktop-portal-wlr`
- Hyprland: `xdg-desktop-portal-hyprland`
- GNOME: usually available by default

Hyprland targeted window screenshots also use `grim` when available:

```bash
# Debian / Ubuntu
sudo apt install grim

# Fedora
sudo dnf install grim

# Arch / Manjaro
sudo pacman -S grim

# openSUSE
sudo zypper install grim
```

Sway targeting uses `swaymsg` and the Sway IPC socket. `swaymsg` normally
discovers the socket from `SWAYSOCK`, with `I3SOCK` as Sway's i3-compatible
fallback. The backend only passes vetted Sway sockets to `swaymsg`; when the app
process inherited an unrelated i3 socket, it is cleared so Sway detection fails
closed instead of misclassifying i3 as Sway. When `SWAYSOCK` is absent from the
app process, the backend also checks `sway --get-socketpath` in Sway sessions
and recent `$XDG_RUNTIME_DIR/sway-ipc.*.sock` sockets.

```bash
# Debian / Ubuntu
sudo apt install sway

# Fedora
sudo dnf install sway

# Arch / Manjaro
sudo pacman -S sway

# openSUSE
sudo zypper install sway
```

## Backend Matrix

The Computer Use binary ships the supported backend adapters together, but it
does not probe every adapter on every launch. At runtime it builds an eligible
window-backend list from the current desktop/session environment:

- GNOME sessions probe the GNOME Shell extension and Introspect backends
- KDE/Plasma sessions probe KWin
- Sway sessions, `SWAYSOCK`, or Sway-shaped IPC sockets probe Sway IPC
- Hyprland sessions or `HYPRLAND_INSTANCE_SIGNATURE` probe Hyprland
- COSMIC sessions probe the bundled COSMIC helper
- i3 sessions, i3-shaped `I3SOCK`, or unknown X11 sessions probe i3

Unknown desktops fall back to the full backend list so new or unusual
environments do not lose window targeting accidentally. For debugging, set
`CODEX_COMPUTER_USE_PROBE_ALL_BACKENDS=1` to probe every backend, or set
`CODEX_COMPUTER_USE_WINDOW_BACKENDS=hyprland,sway` with a comma-separated list
of backend ids to force a specific order.

Maintainers adding or changing backend adapters should use
[Computer Use Backend Maintenance](computer-use-backend-maintenance.md).

| Desktop/compositor | Window list | Exact focus | Targeted screenshot path | Notes |
| --- | --- | --- | --- | --- |
| GNOME Shell extension | yes | yes | full screenshot, then verified crop | Run `setup_window_targeting` when GNOME Introspect cannot focus exact windows. |
| GNOME Shell Introspect | yes | app only | full screenshot, then crop only for app-level targets | Exact `window_id`, `title`, and terminal targets fail closed without the extension. |
| KDE/Plasma KWin | yes | yes | full screenshot, then verified crop | Uses temporary KWin DBus scripting and unloads the script after each query. |
| Sway IPC | yes | yes | full screenshot, then verified crop | Uses `swaymsg -t get_tree` and focuses by `con_id`; generic wlroots compositors need their own backend unless they expose Sway-compatible IPC. |
| Hyprland | yes | yes | `grim -g` region capture for verified target windows | Uses `hyprctl` and exact focused-window address verification. |
| COSMIC | yes | yes | full screenshot, then verified crop | Uses the bundled COSMIC Wayland helper. |
| i3/X11 | yes | yes | full screenshot, then verified crop | Uses `i3-msg` IPC and `xprop` for best-effort PID hydration. |

## Targeted Window Safety

When a screenshot targets a window on Hyprland, the backend focuses the target
with `hyprctl`, verifies the focused native window address with a fresh
compositor query, then captures the exact window region with `grim -g`. If that
verified region capture fails, the targeted screenshot fails closed. It does not
silently return full-screen or active-window pixels while labeling them as the
requested target.

For Hyprland 0.55+ Lua configs, the backend activates windows through
`hl.dsp.focus({ window = "address:0x..." })`; older `focuswindow` dispatch is
kept as a compatibility fallback for pre-Lua Hyprland.

Targeted window screenshots return crop metadata:

- `origin_x` and `origin_y`: the global desktop origin of the crop
- `coordinate_space`: `window-local` for a cropped window image, `global` for a
  full-screen image
- `target_window_id` and `target_backend_window_id`: the resolved compositor
  target
- `focus_verified`: whether exact target-window focus was verified before
  capture

Explicit click, scroll, and drag coordinates are interpreted in the coordinate
space of the latest screenshot. For a cropped targeted screenshot, the backend
translates those window-local pixels back to global desktop coordinates and
re-verifies the cached target window before sending pointer input. AT-SPI
element-index actions keep using their global accessibility bounds.

## Verify Readiness

Once Computer Use is visible in the Codex UI, ask Codex:

> Check whether Linux Computer Use is ready

You can also run the backend directly:

```bash
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux doctor
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux setup
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux apps
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux windows
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux screenshot
```

## Enable The In-App UI

Ad hoc, for one build:

```bash
CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1 make build-app
```

Persistent, including future auto-updater rebuilds:

```bash
mkdir -p ~/.config/codex-desktop
echo '{"codex-linux-computer-use-ui-enabled": true}' > ~/.config/codex-desktop/settings.json
```

To opt back out, unset the env var and remove the settings flag or set it to
`false`.

Nix:

```bash
nix run github:rabesss/codex-linux#codex-desktop-computer-use-ui
```

## Side-By-Side Dev Variant

```bash
make build-dev-app
make run-dev-app
```

Override the dev identity with `DEV_APP_ID`, `DEV_APP_NAME`, and
`CODEX_WEBVIEW_PORT` if needed.
