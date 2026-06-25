use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

pub const HYPRLAND_BACKEND: &str = "hyprland";

pub fn probe() -> BackendProbe {
    match hyprctl_output(&["clients", "-j"]) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let ok = matches!(
                serde_json::from_str::<serde_json::Value>(&stdout),
                Ok(serde_json::Value::Array(_))
            );
            BackendProbe {
                id: HYPRLAND_BACKEND,
                ok,
                can_list_windows: ok,
                can_focus_apps: ok,
                can_focus_windows: ok,
                detail: if ok {
                    "hyprctl clients -j returned a JSON array".to_string()
                } else {
                    "hyprctl clients -j did not return a JSON array".to_string()
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            BackendProbe {
                id: HYPRLAND_BACKEND,
                ok: false,
                can_list_windows: false,
                can_focus_apps: false,
                can_focus_windows: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => BackendProbe {
            id: HYPRLAND_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: error.to_string(),
        },
    }
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    let output = hyprctl_output(&["clients", "-j"]).context("failed to run hyprctl clients -j")?;
    if !output.status.success() {
        bail!(
            "hyprctl clients -j failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    parse_hyprland_clients(&String::from_utf8_lossy(&output.stdout))
}

pub fn focused_window() -> Result<Option<WindowInfo>> {
    let output =
        hyprctl_output(&["activewindow", "-j"]).context("failed to run hyprctl activewindow -j")?;
    if !output.status.success() {
        bail!(
            "hyprctl activewindow -j failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    parse_hyprland_active_window(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn parse_hyprland_clients(json: &str) -> Result<Vec<WindowInfo>> {
    let clients: Vec<HyprlandClient> =
        serde_json::from_str(json).context("failed to parse hyprctl clients -j output")?;

    let mut windows = clients
        .into_iter()
        .filter(|client| client.mapped.unwrap_or(true))
        .map(WindowInfo::try_from)
        .collect::<Result<Vec<_>>>()?;
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub(crate) fn parse_hyprland_active_window(json: &str) -> Result<Option<WindowInfo>> {
    let value: serde_json::Value =
        serde_json::from_str(json).context("failed to parse hyprctl activewindow -j output")?;
    if value.as_object().is_none_or(|object| object.is_empty()) {
        return Ok(None);
    }

    let client: HyprlandClient =
        serde_json::from_value(value).context("failed to parse active Hyprland window")?;
    if client.address.trim().is_empty() {
        return Ok(None);
    }

    let mut window = WindowInfo::try_from(client)?;
    window.focused = true;
    Ok(Some(window))
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let address = format!("address:0x{window_id:x}");
    let lua_dispatch = hyprland_lua_focus_window_dispatch(&address);
    let modern = hyprctl_output(&["dispatch", &lua_dispatch])
        .with_context(|| format!("failed to run hyprctl dispatch {lua_dispatch}"))?;
    if hyprctl_dispatch_succeeded(&modern) {
        return Ok(());
    }

    let legacy = hyprctl_output(&["dispatch", "focuswindow", &address])
        .with_context(|| format!("failed to run hyprctl dispatch focuswindow {address}"))?;
    if hyprctl_dispatch_succeeded(&legacy) {
        return Ok(());
    }

    bail!(
        "Hyprland window activation failed for {address}; lua dispatch: {}; legacy dispatch: {}",
        hyprctl_output_detail(&modern),
        hyprctl_output_detail(&legacy),
    );
}

fn hyprctl_output(args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut command = Command::new("hyprctl");
    let has_signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    if !has_signature {
        if let Some(signature) = infer_hyprland_instance_signature() {
            command.args(["-i", &signature]);
        }
    }
    command.args(args).output()
}

fn infer_hyprland_instance_signature() -> Option<String> {
    let runtime = xdg_runtime_dir()?;
    let hypr_dir = runtime.join("hypr");
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let candidates = fs::read_dir(hypr_dir)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let signature = path.file_name()?.to_string_lossy().into_owned();
            hyprland_instance_candidate(&path, signature, wayland_display.as_deref())
        })
        .collect::<Vec<_>>();

    select_hyprland_instance(candidates).map(|candidate| candidate.signature)
}

fn hyprland_instance_candidate(
    path: &Path,
    signature: String,
    wayland_display: Option<&str>,
) -> Option<HyprlandInstanceCandidate> {
    if !path
        .join(".socket.sock")
        .metadata()
        .map(|metadata| metadata.file_type().is_socket())
        .unwrap_or(false)
    {
        return None;
    }

    let lock = fs::read_to_string(path.join("hyprland.lock")).ok()?;
    let mut lines = lock.lines();
    let pid = lines.next()?.trim();
    if pid.is_empty() || !Path::new("/proc").join(pid).exists() {
        return None;
    }
    let lock_wayland_display = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let wayland_display_matches =
        wayland_display.is_some() && lock_wayland_display == wayland_display;
    let modified = path
        .join(".socket.sock")
        .metadata()
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);

    Some(HyprlandInstanceCandidate {
        signature,
        wayland_display_matches,
        modified,
    })
}

fn select_hyprland_instance(
    candidates: Vec<HyprlandInstanceCandidate>,
) -> Option<HyprlandInstanceCandidate> {
    candidates
        .into_iter()
        .max_by_key(|candidate| (candidate.wayland_display_matches, candidate.modified))
}

fn xdg_runtime_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(value));
    }
    let uid = fs::metadata("/proc/self").ok()?.uid();
    Some(PathBuf::from(format!("/run/user/{uid}")))
}

fn hyprland_lua_focus_window_dispatch(address: &str) -> String {
    format!(r#"hl.dsp.focus({{ window = "{address}" }})"#)
}

fn hyprctl_dispatch_succeeded(output: &std::process::Output) -> bool {
    output.status.success()
        && !hyprctl_stream_has_error(&output.stdout)
        && !hyprctl_stream_has_error(&output.stderr)
}

fn hyprctl_stream_has_error(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    text.lines().map(str::trim_start).any(|line| {
        let line = line.to_ascii_lowercase();
        line.starts_with("error:") || line.starts_with("warning:")
    })
}

fn hyprctl_output_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    output.status.to_string()
}

#[derive(Debug)]
struct HyprlandInstanceCandidate {
    signature: String,
    wayland_display_matches: bool,
    modified: SystemTime,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};
    use std::time::Duration;

    #[test]
    fn selects_wayland_matching_hyprland_instance_before_newer_nonmatch() {
        let older_match = HyprlandInstanceCandidate {
            signature: "match".to_string(),
            wayland_display_matches: true,
            modified: SystemTime::UNIX_EPOCH,
        };
        let newer_nonmatch = HyprlandInstanceCandidate {
            signature: "nonmatch".to_string(),
            wayland_display_matches: false,
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
        };

        let selected = select_hyprland_instance(vec![older_match, newer_nonmatch]).unwrap();

        assert_eq!(selected.signature, "match");
    }

    #[test]
    fn selects_newest_hyprland_instance_when_wayland_match_is_tied() {
        let older = HyprlandInstanceCandidate {
            signature: "older".to_string(),
            wayland_display_matches: false,
            modified: SystemTime::UNIX_EPOCH,
        };
        let newer = HyprlandInstanceCandidate {
            signature: "newer".to_string(),
            wayland_display_matches: false,
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
        };

        let selected = select_hyprland_instance(vec![older, newer]).unwrap();

        assert_eq!(selected.signature, "newer");
    }

    #[test]
    fn parses_active_hyprland_window_with_native_address() {
        let active_json = r#"{
          "address": "0X559952B6DB60",
          "mapped": true,
          "hidden": false,
          "at": [6, 51],
          "size": [2548, 1383],
          "workspace": {"id": 4, "name": "4"},
          "class": "trae",
          "title": "Trae",
          "pid": 2770830,
          "xwayland": false,
          "focusHistoryID": 7
        }"#;

        let window = parse_hyprland_active_window(active_json).unwrap().unwrap();

        assert_eq!(window.window_id, 0x559952b6db60);
        assert_eq!(window.backend_window_id.as_deref(), Some("0x559952b6db60"));
        assert!(window.focused);
        assert_eq!(window.bounds.as_ref().unwrap().x, Some(6));
        assert_eq!(window.bounds.as_ref().unwrap().height, 1383);
    }

    #[test]
    fn empty_active_hyprland_window_returns_none() {
        assert!(parse_hyprland_active_window("{}").unwrap().is_none());
    }

    #[test]
    fn renders_lua_focus_window_dispatch() {
        assert_eq!(
            hyprland_lua_focus_window_dispatch("address:0x559952b6db60"),
            r#"hl.dsp.focus({ window = "address:0x559952b6db60" })"#
        );
    }

    #[test]
    fn treats_hyprctl_error_output_as_failed_dispatch() {
        let output = output_with_status(
            0,
            "error: [string \"return hl.dispatch(focuswindow address:0x1)\"]:1: ')' expected\n",
            "",
        );

        assert!(!hyprctl_dispatch_succeeded(&output));
        assert!(hyprctl_output_detail(&output).starts_with("error:"));
    }

    #[test]
    fn treats_hyprctl_warning_output_as_failed_dispatch() {
        let output = output_with_status(0, "warning: =[C]:-1: hl.focus: window not found\n", "");

        assert!(!hyprctl_dispatch_succeeded(&output));
        assert!(hyprctl_output_detail(&output).starts_with("warning:"));
    }

    #[test]
    fn accepts_successful_hyprctl_dispatch_output() {
        let output = output_with_status(0, "ok\n", "");

        assert!(hyprctl_dispatch_succeeded(&output));
    }

    fn output_with_status(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct HyprlandClient {
    address: String,
    mapped: Option<bool>,
    hidden: Option<bool>,
    at: Option<[i32; 2]>,
    size: Option<[u32; 2]>,
    workspace: Option<HyprlandWorkspace>,
    #[serde(rename = "class")]
    class_name: Option<String>,
    title: Option<String>,
    pid: Option<i64>,
    xwayland: Option<bool>,
    #[serde(rename = "focusHistoryID")]
    focus_history_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct HyprlandWorkspace {
    id: Option<i32>,
}

impl TryFrom<HyprlandClient> for WindowInfo {
    type Error = anyhow::Error;

    fn try_from(client: HyprlandClient) -> Result<Self> {
        let backend_window_id = normalize_hyprland_address(&client.address)?;
        let window_id = parse_hyprland_address(&backend_window_id)?;
        let bounds = client.size.map(|[width, height]| WindowBounds {
            x: client.at.map(|[x, _]| x),
            y: client.at.map(|[_, y]| y),
            width,
            height,
        });
        let client_type = client.xwayland.map(|xwayland| {
            if xwayland {
                "x11".to_string()
            } else {
                "wayland".to_string()
            }
        });

        Ok(WindowInfo {
            window_id,
            backend_window_id: Some(backend_window_id),
            title: client.title,
            app_id: client.class_name.clone(),
            wm_class: client.class_name,
            pid: client.pid.and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace: client.workspace.and_then(|workspace| workspace.id),
            focused: client.focus_history_id == Some(0),
            hidden: client.hidden.unwrap_or(false),
            client_type,
            backend: HYPRLAND_BACKEND.to_string(),
            terminal: None,
        })
    }
}

fn normalize_hyprland_address(address: &str) -> Result<String> {
    let trimmed = address.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .context("Hyprland window address did not start with 0x")?;
    let parsed = u64::from_str_radix(hex, 16)
        .with_context(|| format!("failed to parse Hyprland window address {address}"))?;
    Ok(format!("0x{parsed:x}"))
}

fn parse_hyprland_address(address: &str) -> Result<u64> {
    let normalized = normalize_hyprland_address(address)?;
    let hex = normalized.trim_start_matches("0x");
    u64::from_str_radix(hex, 16)
        .with_context(|| format!("failed to parse Hyprland window address {address}"))
}
