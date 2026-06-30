use crate::terminal::enrich_terminal_windows;
use crate::windowing::command_runner::{CommandRunner, RealCommandRunner};
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

pub const HYPRLAND_BACKEND: &str = "hyprland";
const DEFAULT_WORKSPACE_GROUP_SIZE: u32 = 10;

pub fn probe() -> BackendProbe {
    let runner = RealCommandRunner;
    probe_with_runner(&runner)
}

fn probe_with_runner(runner: &impl CommandRunner) -> BackendProbe {
    match hyprctl_output_with_runner(runner, &["clients", "-j"]) {
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
    let runner = RealCommandRunner;
    list_windows_with_runner(&runner)
}

fn list_windows_with_runner(runner: &impl CommandRunner) -> Result<Vec<WindowInfo>> {
    let output = hyprctl_output_with_runner(runner, &["clients", "-j"])
        .context("failed to run hyprctl clients -j")?;
    if !output.status.success() {
        bail!(
            "hyprctl clients -j failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    parse_hyprland_clients(&String::from_utf8_lossy(&output.stdout))
}

pub fn focused_window() -> Result<Option<WindowInfo>> {
    let runner = RealCommandRunner;
    focused_window_with_runner(&runner)
}

fn focused_window_with_runner(runner: &impl CommandRunner) -> Result<Option<WindowInfo>> {
    let output = hyprctl_output_with_runner(runner, &["activewindow", "-j"])
        .context("failed to run hyprctl activewindow -j")?;
    if !output.status.success() {
        bail!(
            "hyprctl activewindow -j failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    parse_hyprland_active_window(&String::from_utf8_lossy(&output.stdout))
}

pub fn topology_snapshot() -> Result<HyprlandTopologySnapshot> {
    let runner = RealCommandRunner;
    topology_snapshot_with_runner(&runner, workspace_group_size())
}

fn topology_snapshot_with_runner(
    runner: &impl CommandRunner,
    workspace_group_size: u32,
) -> Result<HyprlandTopologySnapshot> {
    let monitors_json = hyprctl_json_output_with_runner(runner, &["monitors", "all", "-j"])
        .context("failed to read Hyprland monitors")?;
    let workspaces_json = hyprctl_json_output_with_runner(runner, &["workspaces", "-j"])
        .context("failed to read Hyprland workspaces")?;
    let clients_json = hyprctl_json_output_with_runner(runner, &["clients", "-j"])
        .context("failed to read Hyprland clients")?;
    let active_window_json = hyprctl_json_output_with_runner(runner, &["activewindow", "-j"])
        .context("failed to read Hyprland active window")?;
    let active_workspace_json = hyprctl_json_output_with_runner(runner, &["activeworkspace", "-j"])
        .context("failed to read Hyprland active workspace")?;

    parse_hyprland_topology(
        &monitors_json,
        &workspaces_json,
        &clients_json,
        &active_window_json,
        &active_workspace_json,
        workspace_group_size,
    )
}

pub(crate) fn parse_hyprland_topology(
    monitors_json: &str,
    workspaces_json: &str,
    clients_json: &str,
    active_window_json: &str,
    active_workspace_json: &str,
    workspace_group_size: u32,
) -> Result<HyprlandTopologySnapshot> {
    let monitor_inputs: Vec<HyprlandMonitorInput> = serde_json::from_str(monitors_json)
        .context("failed to parse hyprctl monitors -j output")?;
    let workspace_inputs: Vec<HyprlandWorkspaceInput> = serde_json::from_str(workspaces_json)
        .context("failed to parse hyprctl workspaces -j output")?;
    let client_inputs: Vec<HyprlandClient> =
        serde_json::from_str(clients_json).context("failed to parse hyprctl clients -j output")?;
    let active_window_input: serde_json::Value = serde_json::from_str(active_window_json)
        .context("failed to parse hyprctl activewindow -j output")?;
    let active_workspace_input: serde_json::Value = serde_json::from_str(active_workspace_json)
        .context("failed to parse hyprctl activeworkspace -j output")?;

    let active_workspace_id = active_workspace_input
        .get("id")
        .and_then(serde_json::Value::as_i64)
        .and_then(|value| i32::try_from(value).ok());
    let active_window = active_window_input
        .get("address")
        .and_then(serde_json::Value::as_str)
        .and_then(|address| normalize_hyprland_address(address).ok());

    let monitors = monitor_inputs
        .into_iter()
        .map(HyprlandTopologyMonitor::from)
        .collect::<Vec<_>>();
    let visible_workspace_ids = visible_workspace_ids(&monitors);
    let workspaces = workspace_inputs
        .into_iter()
        .map(|workspace| {
            HyprlandTopologyWorkspace::from_input(
                workspace,
                active_workspace_id,
                &visible_workspace_ids,
                workspace_group_size,
            )
        })
        .collect::<Vec<_>>();
    let clients = client_inputs
        .into_iter()
        .filter_map(|client| {
            HyprlandTopologyClient::from_input(client, &monitors, &visible_workspace_ids)
        })
        .collect::<Result<Vec<_>>>()?;

    let active_monitor = monitors
        .iter()
        .find(|monitor| monitor.focused)
        .map(|monitor| monitor.name.clone())
        .or_else(|| {
            active_window.as_ref().and_then(|active_window| {
                clients
                    .iter()
                    .find(|client| client.address == *active_window)
                    .and_then(|client| client.monitor_name.clone())
            })
        });

    Ok(HyprlandTopologySnapshot {
        backend: HYPRLAND_BACKEND.to_string(),
        coordinate_space: "hyprland-global-logical".to_string(),
        workspace_group_size,
        monitors,
        workspaces,
        clients,
        active_monitor,
        active_workspace_id,
        active_window,
    })
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

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HyprlandTopologySnapshot {
    pub backend: String,
    pub coordinate_space: String,
    pub workspace_group_size: u32,
    pub monitors: Vec<HyprlandTopologyMonitor>,
    pub workspaces: Vec<HyprlandTopologyWorkspace>,
    pub clients: Vec<HyprlandTopologyClient>,
    pub active_monitor: Option<String>,
    pub active_workspace_id: Option<i32>,
    pub active_window: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HyprlandTopologyMonitor {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub physical_width: Option<u32>,
    pub physical_height: Option<u32>,
    pub scale: f64,
    pub transform: i32,
    pub reserved: Option<[i32; 4]>,
    pub active_workspace_id: Option<i32>,
    pub special_workspace_id: Option<i32>,
    pub focused: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HyprlandTopologyWorkspace {
    pub id: i32,
    pub name: String,
    pub monitor: Option<String>,
    pub visible: bool,
    pub active: bool,
    pub group_index: Option<i32>,
    pub group_slot: Option<i32>,
    pub is_special: bool,
    pub windows_count: u32,
    pub has_fullscreen: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HyprlandTopologyClient {
    pub address: String,
    pub stable_id: Option<String>,
    pub title: Option<String>,
    pub app_id: Option<String>,
    pub pid: Option<u32>,
    pub workspace_id: Option<i32>,
    pub monitor_id: Option<i32>,
    pub monitor_name: Option<String>,
    pub geometry: Option<WindowBounds>,
    pub mapped: bool,
    pub visible: bool,
    pub accepts_input: bool,
    pub floating: bool,
    pub fullscreen: bool,
    pub pinned: bool,
    pub grouped: bool,
    pub hidden: bool,
    pub action_ready: bool,
}

impl From<HyprlandMonitorInput> for HyprlandTopologyMonitor {
    fn from(monitor: HyprlandMonitorInput) -> Self {
        Self {
            id: monitor.id,
            name: monitor.name,
            description: monitor.description,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            physical_width: monitor.physical_width,
            physical_height: monitor.physical_height,
            scale: monitor.scale.unwrap_or(1.0),
            transform: monitor.transform.unwrap_or(0),
            reserved: monitor.reserved,
            active_workspace_id: monitor.active_workspace.and_then(|workspace| workspace.id),
            special_workspace_id: monitor.special_workspace.and_then(|workspace| workspace.id),
            focused: monitor.focused.unwrap_or(false),
            disabled: monitor.disabled.unwrap_or(false),
        }
    }
}

impl HyprlandTopologyWorkspace {
    fn from_input(
        workspace: HyprlandWorkspaceInput,
        active_workspace_id: Option<i32>,
        visible_workspace_ids: &[i32],
        workspace_group_size: u32,
    ) -> Self {
        let is_special = workspace_is_special(workspace.id, &workspace.name);
        let (group_index, group_slot) = workspace_group(workspace.id, workspace_group_size);
        Self {
            id: workspace.id,
            name: workspace.name,
            monitor: workspace.monitor,
            visible: visible_workspace_ids.contains(&workspace.id),
            active: active_workspace_id == Some(workspace.id),
            group_index,
            group_slot,
            is_special,
            windows_count: workspace.windows.unwrap_or(0),
            has_fullscreen: workspace.has_fullscreen.unwrap_or(false),
        }
    }
}

impl HyprlandTopologyClient {
    fn from_input(
        client: HyprlandClient,
        monitors: &[HyprlandTopologyMonitor],
        visible_workspace_ids: &[i32],
    ) -> Option<Result<Self>> {
        let address = match normalize_hyprland_address(&client.address) {
            Ok(address) => address,
            Err(error) => return Some(Err(error)),
        };
        let mapped = client.mapped.unwrap_or(true);
        if !mapped {
            return None;
        }

        let hidden = client.hidden.unwrap_or(false);
        let compositor_visible = client.visible.unwrap_or(true);
        let accepts_input = client.accepts_input.unwrap_or(true);
        let workspace_id = client.workspace.as_ref().and_then(|workspace| workspace.id);
        let pinned = client.pinned.unwrap_or(false);
        let workspace_visible = workspace_id
            .map(|id| visible_workspace_ids.contains(&id))
            .unwrap_or(false);
        let visible = compositor_visible && !hidden && (pinned || workspace_visible);
        let geometry = client_geometry(&client);
        let monitor_id = client.monitor.or_else(|| {
            geometry
                .as_ref()
                .and_then(|bounds| monitor_for_bounds(bounds, monitors).map(|monitor| monitor.id))
        });
        let monitor_name = monitor_id.and_then(|id| {
            monitors
                .iter()
                .find(|monitor| monitor.id == id)
                .map(|monitor| monitor.name.clone())
        });
        let overlaps_monitor = geometry
            .as_ref()
            .is_some_and(|bounds| monitor_for_bounds(bounds, monitors).is_some());
        let action_ready =
            mapped && visible && accepts_input && monitor_name.is_some() && overlaps_monitor;

        Some(Ok(Self {
            address,
            stable_id: client.stable_id,
            title: client.title,
            app_id: client.class_name,
            pid: client.pid.and_then(|pid| u32::try_from(pid).ok()),
            workspace_id,
            monitor_id,
            monitor_name,
            geometry,
            mapped,
            visible,
            accepts_input,
            floating: client.floating.unwrap_or(false),
            fullscreen: client.fullscreen.unwrap_or(0) != 0,
            pinned,
            grouped: client
                .grouped
                .as_ref()
                .is_some_and(|group| !group.is_empty()),
            hidden,
            action_ready,
        }))
    }
}

fn visible_workspace_ids(monitors: &[HyprlandTopologyMonitor]) -> Vec<i32> {
    let mut ids = Vec::new();
    for monitor in monitors {
        if let Some(id) = monitor.active_workspace_id {
            push_unique_i32(&mut ids, id);
        }
        if let Some(id) = monitor.special_workspace_id.filter(|id| *id != 0) {
            push_unique_i32(&mut ids, id);
        }
    }
    ids
}

fn push_unique_i32(values: &mut Vec<i32>, value: i32) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn workspace_group(id: i32, group_size: u32) -> (Option<i32>, Option<i32>) {
    if id <= 0 || group_size == 0 {
        return (None, None);
    }
    let zero_based = id - 1;
    let group_size = i32::try_from(group_size).unwrap_or(DEFAULT_WORKSPACE_GROUP_SIZE as i32);
    (
        Some(zero_based / group_size),
        Some((zero_based % group_size) + 1),
    )
}

fn workspace_is_special(id: i32, name: &str) -> bool {
    id < 0 || name.starts_with("special:")
}

fn workspace_group_size() -> u32 {
    std::env::var("CODEX_COMPUTER_USE_WORKSPACE_GROUP_SIZE")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_WORKSPACE_GROUP_SIZE)
}

fn client_geometry(client: &HyprlandClient) -> Option<WindowBounds> {
    client.size.map(|[width, height]| WindowBounds {
        x: client.at.map(|[x, _]| x),
        y: client.at.map(|[_, y]| y),
        width,
        height,
    })
}

fn monitor_for_bounds<'a>(
    bounds: &WindowBounds,
    monitors: &'a [HyprlandTopologyMonitor],
) -> Option<&'a HyprlandTopologyMonitor> {
    let x = bounds.x?;
    let y = bounds.y?;
    let right = x.saturating_add(i32::try_from(bounds.width).ok()?);
    let bottom = y.saturating_add(i32::try_from(bounds.height).ok()?);
    monitors.iter().find(|monitor| {
        if monitor.disabled {
            return false;
        }
        let (monitor_width, monitor_height) = monitor_logical_size(monitor);
        let monitor_right = monitor.x.saturating_add(monitor_width);
        let monitor_bottom = monitor.y.saturating_add(monitor_height);
        x < monitor_right && right > monitor.x && y < monitor_bottom && bottom > monitor.y
    })
}

fn monitor_logical_size(monitor: &HyprlandTopologyMonitor) -> (i32, i32) {
    let (width, height) = if monitor_transform_rotates(monitor.transform) {
        (monitor.height, monitor.width)
    } else {
        (monitor.width, monitor.height)
    };
    (
        scaled_logical_extent(width, monitor.scale),
        scaled_logical_extent(height, monitor.scale),
    )
}

fn monitor_transform_rotates(transform: i32) -> bool {
    matches!(transform.rem_euclid(4), 1 | 3)
}

fn scaled_logical_extent(value: u32, scale: f64) -> i32 {
    if !scale.is_finite() || scale <= 0.0 {
        return i32::try_from(value).unwrap_or(i32::MAX);
    }
    let logical = (f64::from(value) / scale).ceil();
    if logical >= f64::from(i32::MAX) {
        i32::MAX
    } else {
        logical.max(0.0) as i32
    }
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let runner = RealCommandRunner;
    activate_window_with_runner(&runner, window_id)
}

fn activate_window_with_runner(runner: &impl CommandRunner, window_id: u64) -> Result<()> {
    let address = format!("address:0x{window_id:x}");
    let lua_dispatch = hyprland_lua_focus_window_dispatch(&address);
    let modern = hyprctl_output_with_runner(runner, &["dispatch", &lua_dispatch])
        .with_context(|| format!("failed to run hyprctl dispatch {lua_dispatch}"))?;
    if hyprctl_dispatch_succeeded(&modern) {
        return Ok(());
    }

    let legacy = hyprctl_output_with_runner(runner, &["dispatch", "focuswindow", &address])
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

fn hyprctl_output_with_runner(
    runner: &impl CommandRunner,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    let has_env_signature = hyprland_env_signature_present();
    let inferred_signature = if has_env_signature {
        None
    } else {
        infer_hyprland_instance_signature()
    };
    hyprctl_output_with_runner_and_signature(
        runner,
        args,
        inferred_signature.as_deref(),
        has_env_signature,
    )
}

fn hyprctl_json_output_with_runner(runner: &impl CommandRunner, args: &[&str]) -> Result<String> {
    let output = hyprctl_output_with_runner(runner, args)
        .with_context(|| format!("failed to run hyprctl {}", args.join(" ")))?;
    if !output.status.success() {
        bail!(
            "hyprctl {} failed: {}",
            args.join(" "),
            hyprctl_output_detail(&output)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn hyprctl_output_with_runner_and_signature(
    runner: &impl CommandRunner,
    args: &[&str],
    inferred_signature: Option<&str>,
    has_env_signature: bool,
) -> std::io::Result<std::process::Output> {
    let mut command = hyprctl_command(args, inferred_signature, has_env_signature);
    runner.output(&mut command)
}

fn hyprctl_command(
    args: &[&str],
    inferred_signature: Option<&str>,
    has_env_signature: bool,
) -> Command {
    let mut command = Command::new("hyprctl");
    if !has_env_signature {
        if let Some(signature) = inferred_signature {
            command.args(["-i", signature]);
        }
    }
    command.args(args);
    command
}

fn hyprland_env_signature_present() -> bool {
    std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
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
    use crate::windowing::command_runner::tests::{output_with_status, FakeCommandRunner};
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
    fn hyprctl_uses_inferred_instance_signature_when_env_signature_is_absent() {
        let runner = FakeCommandRunner::new(vec![output_with_status(0, "[]", "")]);

        hyprctl_output_with_runner_and_signature(
            &runner,
            &["clients", "-j"],
            Some("inferred-signature"),
            false,
        )
        .unwrap();

        let invocations = runner.invocations();
        assert_eq!(invocations.len(), 1);
        assert!(invocations[0].program_is("hyprctl"));
        assert_eq!(
            invocations[0].args,
            vec!["-i", "inferred-signature", "clients", "-j"]
        );
    }

    #[test]
    fn hyprctl_keeps_env_instance_signature_authoritative() {
        let runner = FakeCommandRunner::new(vec![output_with_status(0, "[]", "")]);

        hyprctl_output_with_runner_and_signature(
            &runner,
            &["clients", "-j"],
            Some("inferred-signature"),
            true,
        )
        .unwrap();

        let invocations = runner.invocations();
        assert_eq!(invocations.len(), 1);
        assert!(invocations[0].program_is("hyprctl"));
        assert_eq!(invocations[0].args, vec!["clients", "-j"]);
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

    #[test]
    fn monitor_matching_uses_scaled_and_rotated_logical_bounds() {
        let monitors = vec![
            HyprlandTopologyMonitor {
                id: 1,
                name: "SCALED".to_string(),
                description: None,
                x: 0,
                y: 0,
                width: 3000,
                height: 2000,
                physical_width: None,
                physical_height: None,
                scale: 2.0,
                transform: 0,
                reserved: None,
                active_workspace_id: Some(1),
                special_workspace_id: None,
                focused: false,
                disabled: false,
            },
            HyprlandTopologyMonitor {
                id: 2,
                name: "ROTATED".to_string(),
                description: None,
                x: 1600,
                y: 0,
                width: 1200,
                height: 1920,
                physical_width: None,
                physical_height: None,
                scale: 1.5,
                transform: 1,
                reserved: None,
                active_workspace_id: Some(2),
                special_workspace_id: None,
                focused: true,
                disabled: false,
            },
        ];
        let bounds = WindowBounds {
            x: Some(1700),
            y: Some(700),
            width: 50,
            height: 50,
        };

        let monitor = monitor_for_bounds(&bounds, &monitors).unwrap();

        assert_eq!(monitor.name, "ROTATED");
    }

    #[test]
    fn parses_topology_with_multi_monitor_workspace_and_client_state() {
        let monitors = r#"[
          {
            "id": 0,
            "name": "LEFT",
            "description": "Left Display",
            "width": 1920,
            "height": 1080,
            "physicalWidth": 500,
            "physicalHeight": 300,
            "x": -1920,
            "y": 0,
            "scale": 1.25,
            "transform": 0,
            "reserved": [0, 32, 0, 0],
            "activeWorkspace": {"id": 1, "name": "1"},
            "specialWorkspace": {"id": -99, "name": "special:scratch"},
            "focused": false,
            "disabled": false
          },
          {
            "id": 1,
            "name": "RIGHT",
            "description": "Right Display",
            "width": 2560,
            "height": 1440,
            "physicalWidth": 600,
            "physicalHeight": 340,
            "x": 0,
            "y": 0,
            "scale": 1.0,
            "transform": 2,
            "reserved": [0, 40, 0, 0],
            "activeWorkspace": {"id": 11, "name": "11"},
            "specialWorkspace": {"id": 0, "name": ""},
            "focused": true,
            "disabled": false
          }
        ]"#;
        let workspaces = r#"[
          {"id": 1, "name": "1", "monitor": "LEFT", "windows": 1, "hasfullscreen": false},
          {"id": 2, "name": "2", "monitor": "LEFT", "windows": 2, "hasfullscreen": false},
          {"id": 11, "name": "11", "monitor": "RIGHT", "windows": 1, "hasfullscreen": true},
          {"id": -99, "name": "special:scratch", "monitor": "LEFT", "windows": 1, "hasfullscreen": false}
        ]"#;
        let clients = r#"[
          {
            "address": "0x1",
            "mapped": true,
            "hidden": false,
            "visible": true,
            "acceptsInput": true,
            "at": [-1900, 20],
            "size": [800, 600],
            "workspace": {"id": 1, "name": "1"},
            "monitor": 0,
            "class": "terminal",
            "title": "Terminal",
            "pid": 101,
            "xwayland": false,
            "floating": false,
            "fullscreen": 0,
            "pinned": false,
            "grouped": [],
            "focusHistoryID": 4,
            "stableId": "stable-1"
          },
          {
            "address": "0x2",
            "mapped": true,
            "hidden": false,
            "visible": true,
            "acceptsInput": true,
            "at": [10, 40],
            "size": [1200, 800],
            "workspace": {"id": 11, "name": "11"},
            "monitor": 1,
            "class": "browser",
            "title": "Browser",
            "pid": 202,
            "xwayland": false,
            "floating": false,
            "fullscreen": 2,
            "pinned": false,
            "grouped": ["0xabc"],
            "focusHistoryID": 0,
            "stableId": "stable-2"
          },
          {
            "address": "0x3",
            "mapped": true,
            "hidden": false,
            "visible": true,
            "acceptsInput": true,
            "at": [-1800, 40],
            "size": [600, 400],
            "workspace": {"id": 2, "name": "2"},
            "monitor": 0,
            "class": "hidden-workspace",
            "title": "Hidden Workspace",
            "pid": 303,
            "xwayland": false,
            "floating": false,
            "fullscreen": 0,
            "pinned": false,
            "grouped": [],
            "focusHistoryID": 6,
            "stableId": "stable-3"
          },
          {
            "address": "0x4",
            "mapped": true,
            "hidden": false,
            "visible": true,
            "acceptsInput": true,
            "at": [100, 100],
            "size": [500, 500],
            "workspace": {"id": 2, "name": "2"},
            "monitor": 1,
            "class": "pinned",
            "title": "Pinned",
            "pid": 404,
            "xwayland": false,
            "floating": true,
            "fullscreen": 0,
            "pinned": true,
            "grouped": [],
            "focusHistoryID": 5,
            "stableId": "stable-4"
          },
          {
            "address": "0x5",
            "mapped": true,
            "hidden": false,
            "visible": true,
            "acceptsInput": true,
            "at": [-1700, 60],
            "size": [400, 300],
            "workspace": {"id": -99, "name": "special:scratch"},
            "monitor": 0,
            "class": "scratch",
            "title": "Scratch",
            "pid": 505,
            "xwayland": false,
            "floating": true,
            "fullscreen": 0,
            "pinned": false,
            "grouped": [],
            "focusHistoryID": 7,
            "stableId": "stable-5"
          },
          {
            "address": "0x6",
            "mapped": false,
            "hidden": false,
            "visible": false,
            "acceptsInput": true,
            "at": [20, 20],
            "size": [300, 200],
            "workspace": {"id": 1, "name": "1"},
            "monitor": 0,
            "class": "unmapped",
            "title": "Unmapped",
            "pid": 606,
            "xwayland": false,
            "floating": false,
            "fullscreen": 0,
            "pinned": false,
            "grouped": [],
            "focusHistoryID": 8,
            "stableId": "stable-6"
          },
          {
            "address": "0x7",
            "mapped": true,
            "hidden": true,
            "visible": true,
            "acceptsInput": true,
            "at": [-1600, 80],
            "size": [300, 200],
            "workspace": {"id": 1, "name": "1"},
            "monitor": 0,
            "class": "hidden",
            "title": "Hidden",
            "pid": 707,
            "xwayland": false,
            "floating": false,
            "fullscreen": 0,
            "pinned": false,
            "grouped": [],
            "focusHistoryID": 9,
            "stableId": "stable-7"
          }
        ]"#;

        let topology = parse_hyprland_topology(
            monitors,
            workspaces,
            clients,
            r#"{"address": "0x2"}"#,
            r#"{"id": 11, "name": "11"}"#,
            10,
        )
        .unwrap();

        assert_eq!(topology.coordinate_space, "hyprland-global-logical");
        assert_eq!(topology.active_monitor.as_deref(), Some("RIGHT"));
        assert_eq!(topology.active_workspace_id, Some(11));
        assert_eq!(topology.active_window.as_deref(), Some("0x2"));

        let left = topology
            .monitors
            .iter()
            .find(|monitor| monitor.name == "LEFT")
            .unwrap();
        assert_eq!(left.x, -1920);
        assert_eq!(left.scale, 1.25);
        let right = topology
            .monitors
            .iter()
            .find(|monitor| monitor.name == "RIGHT")
            .unwrap();
        assert_eq!(right.transform, 2);

        let workspace_11 = topology
            .workspaces
            .iter()
            .find(|workspace| workspace.id == 11)
            .unwrap();
        assert!(workspace_11.visible);
        assert!(workspace_11.active);
        assert_eq!(workspace_11.group_index, Some(1));
        assert_eq!(workspace_11.group_slot, Some(1));

        let special = topology
            .workspaces
            .iter()
            .find(|workspace| workspace.id == -99)
            .unwrap();
        assert!(special.is_special);
        assert!(special.visible);
        assert_eq!(special.group_index, None);

        let inactive = topology
            .clients
            .iter()
            .find(|client| client.address == "0x3")
            .unwrap();
        assert!(!inactive.visible);
        assert!(!inactive.action_ready);

        let browser = topology
            .clients
            .iter()
            .find(|client| client.address == "0x2")
            .unwrap();
        assert!(browser.fullscreen);
        assert!(browser.grouped);
        assert!(browser.action_ready);

        let pinned = topology
            .clients
            .iter()
            .find(|client| client.address == "0x4")
            .unwrap();
        assert!(pinned.pinned);
        assert!(pinned.visible);
        assert!(pinned.action_ready);

        let scratch = topology
            .clients
            .iter()
            .find(|client| client.address == "0x5")
            .unwrap();
        assert!(scratch.visible);
        assert!(scratch.action_ready);

        assert!(topology
            .clients
            .iter()
            .all(|client| client.address != "0x6"));

        let hidden = topology
            .clients
            .iter()
            .find(|client| client.address == "0x7")
            .unwrap();
        assert!(hidden.hidden);
        assert!(!hidden.action_ready);
    }
}

#[derive(Debug, Clone, Deserialize)]
struct HyprlandClient {
    address: String,
    mapped: Option<bool>,
    hidden: Option<bool>,
    visible: Option<bool>,
    #[serde(rename = "acceptsInput")]
    accepts_input: Option<bool>,
    at: Option<[i32; 2]>,
    size: Option<[u32; 2]>,
    workspace: Option<HyprlandWorkspace>,
    monitor: Option<i32>,
    #[serde(rename = "class")]
    class_name: Option<String>,
    title: Option<String>,
    pid: Option<i64>,
    xwayland: Option<bool>,
    floating: Option<bool>,
    fullscreen: Option<i32>,
    pinned: Option<bool>,
    grouped: Option<Vec<String>>,
    #[serde(rename = "focusHistoryID")]
    focus_history_id: Option<i32>,
    #[serde(rename = "stableId")]
    stable_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct HyprlandWorkspace {
    id: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
struct HyprlandMonitorInput {
    id: i32,
    name: String,
    description: Option<String>,
    width: u32,
    height: u32,
    #[serde(rename = "physicalWidth")]
    physical_width: Option<u32>,
    #[serde(rename = "physicalHeight")]
    physical_height: Option<u32>,
    x: i32,
    y: i32,
    scale: Option<f64>,
    transform: Option<i32>,
    reserved: Option<[i32; 4]>,
    #[serde(rename = "activeWorkspace")]
    active_workspace: Option<HyprlandWorkspace>,
    #[serde(rename = "specialWorkspace")]
    special_workspace: Option<HyprlandWorkspace>,
    focused: Option<bool>,
    disabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct HyprlandWorkspaceInput {
    id: i32,
    name: String,
    monitor: Option<String>,
    windows: Option<u32>,
    #[serde(rename = "hasfullscreen")]
    has_fullscreen: Option<bool>,
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
