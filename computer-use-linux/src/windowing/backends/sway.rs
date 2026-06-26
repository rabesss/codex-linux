use crate::terminal::enrich_terminal_windows;
use crate::windowing::command_runner::{CommandRunner, RealCommandRunner};
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{env, fs, os::unix::fs::FileTypeExt, path::PathBuf, process::Command};

pub const SWAY_BACKEND: &str = "sway";

pub fn probe() -> BackendProbe {
    let runner = RealCommandRunner;
    probe_with_runner_and_socket(&runner, sway_socket_path())
}

fn probe_with_runner_and_socket(
    runner: &impl CommandRunner,
    socket_path: Option<PathBuf>,
) -> BackendProbe {
    let mut command = swaymsg_command_with_socket(socket_path);
    command.args(["-t", "get_tree"]);
    match runner.output(&mut command) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let ok = matches!(
                serde_json::from_str::<serde_json::Value>(&stdout),
                Ok(serde_json::Value::Object(_))
            );
            BackendProbe {
                id: SWAY_BACKEND,
                ok,
                can_list_windows: ok,
                can_focus_apps: ok,
                can_focus_windows: ok,
                detail: if ok {
                    "swaymsg get_tree returned a JSON tree".to_string()
                } else {
                    "swaymsg get_tree did not return a JSON object".to_string()
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            BackendProbe {
                id: SWAY_BACKEND,
                ok: false,
                can_list_windows: false,
                can_focus_apps: false,
                can_focus_windows: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => BackendProbe {
            id: SWAY_BACKEND,
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
    list_windows_with_runner_and_socket(&runner, sway_socket_path())
}

fn list_windows_with_runner_and_socket(
    runner: &impl CommandRunner,
    socket_path: Option<PathBuf>,
) -> Result<Vec<WindowInfo>> {
    let mut command = swaymsg_command_with_socket(socket_path);
    command.args(["-t", "get_tree"]);
    let output = runner
        .output(&mut command)
        .context("failed to run swaymsg -t get_tree")?;
    if !output.status.success() {
        bail!(
            "swaymsg -t get_tree failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut windows = parse_sway_tree(&String::from_utf8_lossy(&output.stdout))?;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub(crate) fn parse_sway_tree(json: &str) -> Result<Vec<WindowInfo>> {
    let root: SwayNode =
        serde_json::from_str(json).context("failed to parse swaymsg get_tree output")?;
    let mut windows = Vec::new();
    collect_sway_windows(&root, None, false, &mut windows);
    windows.sort_by_key(|window| window.window_id);
    Ok(windows)
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let runner = RealCommandRunner;
    activate_window_with_runner_and_socket(&runner, sway_socket_path(), window_id)
}

fn activate_window_with_runner_and_socket(
    runner: &impl CommandRunner,
    socket_path: Option<PathBuf>,
    window_id: u64,
) -> Result<()> {
    let selector = format!(r#"[con_id="{window_id}"] focus"#);
    let mut command = swaymsg_command_with_socket(socket_path);
    command.arg(&selector);
    let output = runner
        .output(&mut command)
        .with_context(|| format!("failed to run swaymsg {selector}"))?;
    if !output.status.success() {
        bail!(
            "swaymsg {selector} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let replies: Vec<SwayCommandReply> =
        serde_json::from_slice(&output.stdout).context("failed to parse swaymsg focus reply")?;
    if replies.iter().all(|reply| reply.success) {
        Ok(())
    } else {
        let details = replies
            .into_iter()
            .filter_map(|reply| reply.error)
            .collect::<Vec<_>>()
            .join("; ");
        bail!(
            "swaymsg {selector} did not focus the window: {}",
            if details.is_empty() {
                "unknown Sway failure"
            } else {
                details.as_str()
            }
        );
    }
}

fn collect_sway_windows(
    node: &SwayNode,
    workspace: Option<i32>,
    in_dockarea: bool,
    windows: &mut Vec<WindowInfo>,
) {
    let node_type = node.node_type.as_deref();
    let current_workspace = if node_type == Some("workspace") {
        node.num
    } else {
        workspace
    };
    let current_in_dockarea = in_dockarea || node_type == Some("dockarea");

    if let Some(window) = node.to_window_info(current_workspace, current_in_dockarea) {
        windows.push(window);
    }

    for child in &node.nodes {
        collect_sway_windows(child, current_workspace, current_in_dockarea, windows);
    }
    for child in &node.floating_nodes {
        collect_sway_windows(child, current_workspace, current_in_dockarea, windows);
    }
}

fn swaymsg_command_with_socket(socket_path: Option<PathBuf>) -> Command {
    let mut command = Command::new("swaymsg");
    command.env_remove("I3SOCK");
    command.env_remove("SWAYSOCK");
    if let Some(socket_path) = socket_path {
        command.arg("--socket").arg(socket_path);
    }
    command
}

fn sway_socket_path() -> Option<PathBuf> {
    let sway_session = sway_session_hint();
    env_socket_path("SWAYSOCK")
        .or_else(|| {
            env_socket_path("I3SOCK")
                .filter(|path| sway_session || path_looks_like_sway_socket(path))
        })
        .or_else(recent_sway_socket_path)
        .or_else(|| sway_session.then(socket_path_from_sway).flatten())
}

fn env_socket_path(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env_var(name)?);
    path.metadata()
        .ok()
        .is_some_and(|metadata| metadata.file_type().is_socket())
        .then_some(path)
}

fn socket_path_from_sway() -> Option<PathBuf> {
    let output = Command::new("sway").arg("--get-socketpath").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn recent_sway_socket_path() -> Option<PathBuf> {
    let runtime = xdg_runtime_dir()?;
    let mut sockets = fs::read_dir(runtime)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;
            if !file_name.starts_with("sway-ipc.") || !file_name.ends_with(".sock") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            if !metadata.file_type().is_socket() {
                return None;
            }
            let modified = metadata.modified().ok();
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    sockets.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    sockets.into_iter().map(|(_, path)| path).next()
}

fn path_looks_like_sway_socket(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("sway-ipc.") && name.ends_with(".sock"))
}

fn sway_session_hint() -> bool {
    [
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
    ]
    .into_iter()
    .filter_map(env_var)
    .any(|value| value.to_ascii_lowercase().contains("sway"))
}

fn xdg_runtime_dir() -> Option<PathBuf> {
    env_var("XDG_RUNTIME_DIR").map(PathBuf::from)
}

fn env_var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clean_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "null")
        .map(ToOwned::to_owned)
}

fn sway_client_type(shell: Option<&str>) -> Option<String> {
    let shell = clean_string(shell)?;
    match shell.as_str() {
        "xwayland" => Some("x11".to_string()),
        "xdg_shell" | "wl_shell" => Some("wayland".to_string()),
        _ => Some(shell),
    }
}

#[derive(Debug, Deserialize)]
struct SwayCommandReply {
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwayNode {
    id: Option<u64>,
    #[serde(rename = "type")]
    node_type: Option<String>,
    name: Option<String>,
    app_id: Option<String>,
    pid: Option<u32>,
    window: Option<u64>,
    window_type: Option<String>,
    window_properties: Option<SwayWindowProperties>,
    rect: Option<SwayRect>,
    geometry: Option<SwayRect>,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    nodes: Vec<SwayNode>,
    #[serde(default)]
    floating_nodes: Vec<SwayNode>,
    num: Option<i32>,
    scratchpad_state: Option<String>,
    visible: Option<bool>,
    shell: Option<String>,
    foreign_toplevel_identifier: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwayWindowProperties {
    class: Option<String>,
    instance: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwayRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl SwayNode {
    fn to_window_info(&self, workspace: Option<i32>, in_dockarea: bool) -> Option<WindowInfo> {
        if in_dockarea || self.window_type.as_deref() == Some("dock") {
            return None;
        }
        if !self.is_window() {
            return None;
        }
        let window_id = self.id?;
        let properties = self.window_properties.as_ref();
        let title = clean_string(
            properties
                .and_then(|properties| properties.title.as_deref())
                .or(self.name.as_deref()),
        );
        let app_id = clean_string(self.app_id.as_deref()).or_else(|| {
            clean_string(
                properties
                    .and_then(|properties| properties.instance.as_deref())
                    .or_else(|| properties.and_then(|properties| properties.class.as_deref())),
            )
        });
        let wm_class = clean_string(
            properties
                .and_then(|properties| properties.class.as_deref())
                .or_else(|| properties.and_then(|properties| properties.instance.as_deref())),
        );
        let rect = self.rect.as_ref().or(self.geometry.as_ref());
        let bounds = rect.map(|rect| WindowBounds {
            x: Some(rect.x),
            y: Some(rect.y),
            width: rect.width,
            height: rect.height,
        });

        Some(WindowInfo {
            window_id,
            backend_window_id: self
                .foreign_toplevel_identifier
                .as_deref()
                .and_then(|value| clean_string(Some(value)))
                .or_else(|| Some(format!("con_id:{window_id}"))),
            title,
            app_id,
            wm_class,
            pid: self.pid,
            bounds,
            workspace,
            focused: self.focused,
            hidden: self.visible == Some(false)
                || self.scratchpad_state.as_deref() == Some("fresh"),
            client_type: sway_client_type(self.shell.as_deref()),
            backend: SWAY_BACKEND.to_string(),
            terminal: None,
        })
    }

    fn is_window(&self) -> bool {
        matches!(
            self.node_type.as_deref(),
            Some("con") | Some("floating_con")
        ) && (self
            .app_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || self.pid.is_some()
            || self.window.is_some()
            || self.window_properties.is_some()
            || self
                .shell
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windowing::command_runner::tests::{output_with_status, FakeCommandRunner};
    use std::ffi::OsStr;

    #[test]
    fn list_command_clears_inherited_socket_env_while_passing_vetted_socket() {
        let runner = FakeCommandRunner::new(vec![output_with_status(0, r#"{"nodes":[]}"#, "")]);

        let windows = list_windows_with_runner_and_socket(
            &runner,
            Some(PathBuf::from("/run/user/1000/sway-ipc.1000.123.sock")),
        )
        .unwrap();

        assert!(windows.is_empty());
        let invocations = runner.invocations();
        assert_eq!(invocations.len(), 1);
        assert!(invocations[0].program_is("swaymsg"));
        assert_eq!(
            invocations[0].args,
            vec![
                "--socket",
                "/run/user/1000/sway-ipc.1000.123.sock",
                "-t",
                "get_tree"
            ]
        );
        assert!(invocations[0].removes_env("I3SOCK"));
        assert!(invocations[0].removes_env("SWAYSOCK"));
    }

    #[test]
    fn command_clears_inherited_i3_and_sway_socket_env() {
        let command = swaymsg_command_with_socket(None);

        assert!(command
            .get_envs()
            .any(|(key, value)| key == OsStr::new("I3SOCK") && value.is_none()));
        assert!(command
            .get_envs()
            .any(|(key, value)| key == OsStr::new("SWAYSOCK") && value.is_none()));
        assert!(command.get_args().next().is_none());
    }

    #[test]
    fn command_passes_vetted_socket_explicitly() {
        let command = swaymsg_command_with_socket(Some(PathBuf::from("/run/user/1000/sway.sock")));
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(args, vec!["--socket", "/run/user/1000/sway.sock"]);
        assert!(command
            .get_envs()
            .any(|(key, value)| key == OsStr::new("I3SOCK") && value.is_none()));
    }

    #[test]
    fn identifies_sway_socket_names() {
        assert!(path_looks_like_sway_socket(std::path::Path::new(
            "/run/user/1000/sway-ipc.1000.123.sock"
        )));
        assert!(!path_looks_like_sway_socket(std::path::Path::new(
            "/run/user/1000/i3/ipc-socket.123"
        )));
    }
}
