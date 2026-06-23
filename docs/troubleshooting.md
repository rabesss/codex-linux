# Troubleshooting

| Problem | Solution |
|---|---|
| `Error: write EPIPE` | Run `start.sh` directly instead of piping output |
| Blank window | Check whether the configured webview port is already in use: `ss -tlnp \| grep -E '5175\|5176'` |
| `ERR_CONNECTION_REFUSED` on the webview port | Ensure `python3` works and the configured port is free |
| Stuck on Codex logo splash | Check `~/.cache/codex-desktop/launcher.log`; another process may be serving the webview port |
| `CODEX_CLI_PATH` error | Reopen the app to retry automatic CLI install, or install manually with `npm i -g @openai/codex` / `npm i -g --prefix ~/.local @openai/codex` |
| `nix run` exits with no window or terminal output | Check `~/.cache/codex-desktop/launcher.log`; the Nix package still requires a user-provided `codex` CLI |
| `gh auth status` works in terminal but fails inside Codex Desktop | See [GitHub CLI auth in app-launched shells](github-cli-auth.md) |
| Electron hangs while CLI is outdated | Re-run the launcher and check `~/.cache/codex-desktop/launcher.log` plus `~/.local/state/codex-update-manager/service.log` |
| Update notification says manual install or no graphical authentication agent | Older updater builds guessed whether a Polkit agent existed and could be wrong. Update to current `main`, close Codex Desktop, and run `codex-update-manager install-ready`. Current builds try Polkit first and open a terminal authorization prompt only if needed. |
| Update is ready but no terminal or password prompt appears | Run `codex-update-manager status --json` and confirm the package path still exists. Then run `codex-update-manager install-ready` from a terminal; the package remains cached after a cancelled prompt. |
| Update says `install.sh failed during local rebuild` | Run `codex-update-manager status`. Current builds include the exact rebuild log path and preserve the working installed package. Update the wrapper checkout to current `main`, then run `codex-update-manager check-now`. |
| GPU / Vulkan / Wayland errors | Try `CODEX_LINUX_RENDERING_MODE=wayland-gpu ./codex-app/start.sh` |
| Window flickering | Try `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./codex-app/start.sh`, then `./codex-app/start.sh --disable-gpu` if needed |
| Sandbox errors | The launcher already sets `--no-sandbox` |
| Stale install / cached DMG | `make build-app-fresh` removes the generated app and cached DMG, then downloads current upstream |
| Computer Use plugin invisible in UI | Enable the Computer Use UI opt-in; upstream server/account rollout can still hide some controls |
| Computer Use `doctor` reports no input backend | Grant `/dev/uinput`, enable XDG RemoteDesktop portal, or start `ydotoold` / `ydotool.service` |
| Computer Use `doctor` reports `ydotool_socket: Permission denied` | Adjust the daemon socket so users in the `input` group can use it |
| `ConnectTimeoutError` for Electron headers | Re-run `make build-app`; the installer uses `https://artifacts.electronjs.org/headers/dist` by default |
| Computer Use AT-SPI tree empty | Run `codex-computer-use-linux setup`, then restart the target app |
| `codex-update-manager` keeps running after package removal | Run `systemctl --user disable --now codex-update-manager.service` and confirm `/opt/codex-desktop` is gone |
| Custom rows are missing from the model picker | Confirm `custom-model-catalog` was enabled at build time and one configured catalog source is readable: `CODEX_CUSTOM_MODEL_CATALOG_JSON`, `$CODEX_HOME/custom-models.json`, `$XDG_CONFIG_HOME/codex-desktop/custom-models.json`, the shim catalog file, or a configured loopback URL |
| A legacy-prefixed slug such as `cursor-*` or `opencode-*` stays on the default provider | Add that row to an accepted custom catalog source with the intended `model_provider`; prefixes alone are not routing signals |
| Custom rows show `CLIProxyAPI / Cursor ...` in the main model name | Update `codex-shim`, regenerate the Desktop catalog, restart `codex-shim.service`, and restart Desktop. Current shim builds keep route provenance in provider metadata, not the primary label. |
| The same custom model appears twice under the same provider | Regenerate the custom catalog, or update both repositories if using shim, and inspect the catalog for duplicate `(provider_display_name, display_name)` rows. Current builds collapse those visible duplicates before the selector renders. |
| Custom groups are absent but custom rows appear | Confirm each row has `provider_display_name` or the generated description shape `<display_name> via <provider_display_name>.`; Desktop uses the description fallback when upstream dropdown normalization strips custom fields. |
| A custom thread works until Desktop restarts | Keep the selected row's durable `[model_providers.<id>]` entry defined in Codex config while leaving top-level `model_provider = "openai"`. For shim rows, that provider id is usually `codex_shim`. |
| `/goal` or a forked custom thread stops reaching the shim | Rebuild from current `main`. Older builds could drop `modelProvider` during `thread/fork`; current builds preserve provider config and dynamic tools |
| An existing thread keeps sending to the old provider after a model switch | Rebuild from current `main`. Current builds force a provider resume when a thread crosses the official/custom provider boundary. For an already-stale thread, close and reopen Desktop after updating. |
| Custom model returns `unsupported call` for a Browser namespace tool | Rebuild from current `main` so Desktop exposes and forwards dynamic tools. If the row uses the shim, also update `codex-shim`; it must preserve native item `type`, restore flat/nested MCP `namespace` and `name`, and the selected row must advertise `supports_tools` only if the provider is verified tool-capable. |
| Custom model tries native `web_search` or `computer_use` as a normal function | Use an official row for hosted native web search/computer-use semantics, or expose a real executable MCP/function fallback for the custom model. Current shim builds do not fake these hosted tools as BYOK functions |
| CommandCode custom rows fail with `Unsupported model provider: commandcode` | Regenerate the shim model matrix. Current shim builds also normalize stale CommandCode rows to the local CLIProxyAPI route |
| Custom model context footer or compaction threshold is wrong | Regenerate the custom catalog, or update `codex-shim` and run `codex-shim desktop write-models` if using shim, then restart Desktop so the feature CLI wrapper rebuilds the merged app-server catalog. Check the active custom catalog source and `$XDG_STATE_HOME/codex-desktop/custom-model-catalog/merged-model-catalog.json` for `context_window` and `auto_compact_token_limit`. |
| Browser reports `Browser security unavailable outside node repl` | Rebuild from current `main`. Older bundled clients required an obsolete `nodeRepl.config` marker even when the current runtime exposed the required permission and fetch capabilities. |
| Browser click opens a tab Codex cannot see | The link likely uses `target="_blank"`; read its `href` and navigate the controlled tab explicitly |
| Browser locator count becomes zero after navigation | Take a new DOM snapshot and rebuild the locator; stale locators do not always throw |
| Browser navigation appears hung | Allow for the upstream site-status safety request; it can add several seconds before navigation completes |
| Browser logs unsupported `Target.setAutoAttach` but the action succeeds | This is a non-blocking in-app backend limitation. Treat it as a failure only when navigation or the requested locator action also fails. |
| First-run login accepts a fake API key or persists it to Codex auth state | Rebuild from current `main`. Current first-run validation rejects invalid keys before the wizard advances or writes auth state. |

## `/tmp` Mounted `noexec`

Some hardened systems mount `/tmp` with `noexec`, which can prevent the Rust
installer or bundled Node.js runtime from executing.

```bash
mkdir -p ~/tmp/codex-work ~/tmp/codex-cache

export TMPDIR=~/tmp/codex-work
export XDG_CACHE_HOME=~/tmp/codex-cache

# run install steps in this shell
```

## Useful Logs

The app also exposes the same readiness summary from
**Settings > Linux desktop > Installed readiness** when the Linux desktop
settings page is available.

```bash
codex-desktop-doctor
codex-desktop-doctor --json
sed -n '1,160p' ~/.cache/codex-desktop/launcher.log
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
codex-update-manager status --json
systemctl --user status codex-update-manager.service
```

For custom-model routing also check:

```bash
node scripts/validate-custom-model-catalog.js "${CODEX_HOME:-$HOME/.codex}/custom-models.json"
codex-shim status                         # only for shim-backed rows
curl -s http://127.0.0.1:8765/health      # only for shim-backed rows
curl -s http://127.0.0.1:8765/api/models  # only for shim-backed rows
```

See [Custom models](custom-models.md) and
[Browser Control](browser-control.md#backend-constraints) for the full
cross-repository contract and current Browser API limitations.
