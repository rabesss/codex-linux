use crate::terminal::enrich_terminal_windows;
use crate::windowing::command_runner::{CommandRunner, RealCommandRunner};
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{env, fs, os::unix::fs::FileTypeExt, path::PathBuf, process::Command};

pub const I3_BACKEND: &str = "i3";

pub fn probe() -> BackendProbe {
    let runner = RealCommandRunner;
    probe_with_runner_and_socket(&runner, i3_socket_path())
}

fn probe_with_runner_and_socket(
    runner: &impl CommandRunner,
    socket_path: Option<PathBuf>,
) -> BackendProbe {
    let mut command = i3_msg_command_with_socket(socket_path);
    command.args(["-t", "get_tree"]);
    match runner.output(&mut command) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let ok = matches!(
                serde_json::from_str::<serde_json::Value>(&stdout),
                Ok(serde_json::Value::Object(_))
            );
            BackendProbe {
                id: I3_BACKEND,
                ok,
                can_list_windows: ok,
                can_focus_apps: ok,
                can_focus_windows: ok,
                detail: if ok {
                    "i3-msg get_tree returned a JSON tree".to_string()
                } else {
                    "i3-msg get_tree did not return a JSON object".to_string()
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            BackendProbe {
                id: I3_BACKEND,
                ok: false,
                can_list_windows: false,
                can_focus_apps: false,
                can_focus_windows: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => BackendProbe {
            id: I3_BACKEND,
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
    list_windows_with_runner_and_socket(&runner, i3_socket_path())
}

fn list_windows_with_runner_and_socket(
    runner: &impl CommandRunner,
    socket_path: Option<PathBuf>,
) -> Result<Vec<WindowInfo>> {
    let mut command = i3_msg_command_with_socket(socket_path);
    command.args(["-t", "get_tree"]);
    let output = runner
        .output(&mut command)
        .context("failed to run i3-msg -t get_tree")?;
    if !output.status.success() {
        bail!(
            "i3-msg -t get_tree failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut windows = parse_i3_tree(&String::from_utf8_lossy(&output.stdout))?;
    hydrate_i3_window_pids_with_runner(&mut windows, runner);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub(crate) fn parse_i3_tree(json: &str) -> Result<Vec<WindowInfo>> {
    let root: I3Node =
        serde_json::from_str(json).context("failed to parse i3-msg get_tree output")?;
    let mut windows = Vec::new();
    collect_i3_windows(&root, None, false, &mut windows);
    windows.sort_by_key(|window| window.window_id);
    Ok(windows)
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let runner = RealCommandRunner;
    activate_window_with_runner_and_socket(&runner, i3_socket_path(), window_id)
}

fn activate_window_with_runner_and_socket(
    runner: &impl CommandRunner,
    socket_path: Option<PathBuf>,
    window_id: u64,
) -> Result<()> {
    let selector = format!(r#"[id="0x{window_id:x}"] focus"#);
    let mut command = i3_msg_command_with_socket(socket_path);
    command.arg(&selector);
    let output = runner
        .output(&mut command)
        .with_context(|| format!("failed to run i3-msg {selector}"))?;
    if !output.status.success() {
        bail!(
            "i3-msg {selector} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let replies: Vec<I3CommandReply> =
        serde_json::from_slice(&output.stdout).context("failed to parse i3-msg focus reply")?;
    if replies.iter().all(|reply| reply.success) {
        Ok(())
    } else {
        let details = replies
            .into_iter()
            .filter_map(|reply| reply.error)
            .collect::<Vec<_>>()
            .join("; ");
        bail!(
            "i3-msg {selector} did not focus the window: {}",
            if details.is_empty() {
                "unknown i3 failure"
            } else {
                details.as_str()
            }
        );
    }
}

fn collect_i3_windows(
    node: &I3Node,
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
        collect_i3_windows(child, current_workspace, current_in_dockarea, windows);
    }
    for child in &node.floating_nodes {
        collect_i3_windows(child, current_workspace, current_in_dockarea, windows);
    }
}

fn hydrate_i3_window_pids_with_runner(windows: &mut [WindowInfo], runner: &impl CommandRunner) {
    for window in windows {
        if window.pid.is_none() {
            window.pid = i3_window_pid_with_runner(runner, window.window_id);
        }
    }
}

fn i3_window_pid_with_runner(runner: &impl CommandRunner, window_id: u64) -> Option<u32> {
    let mut command = Command::new("xprop");
    command.args(["-id", &window_id.to_string(), "_NET_WM_PID"]);
    let output = runner.output(&mut command).ok()?;
    if !output.status.success() {
        return None;
    }
    parse_xprop_pid(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn parse_xprop_pid(output: &str) -> Option<u32> {
    output.split('=').nth(1)?.trim().parse::<u32>().ok()
}

fn i3_msg_command_with_socket(socket_path: Option<PathBuf>) -> Command {
    let mut command = Command::new("i3-msg");
    if let Some(socket_path) = socket_path {
        command.arg("-s").arg(socket_path);
    }
    command
}

fn i3_socket_path() -> Option<PathBuf> {
    if let Some(value) = env_var("I3SOCK") {
        return Some(PathBuf::from(value));
    }

    let socket_dir = xdg_runtime_dir()?.join("i3");
    let mut sockets = fs::read_dir(socket_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;
            if !file_name.starts_with("ipc-socket.") {
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

#[derive(Debug, Deserialize)]
struct I3CommandReply {
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct I3Node {
    #[serde(rename = "type")]
    node_type: Option<String>,
    name: Option<String>,
    window: Option<u64>,
    window_type: Option<String>,
    window_properties: Option<I3WindowProperties>,
    rect: Option<I3Rect>,
    geometry: Option<I3Rect>,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    nodes: Vec<I3Node>,
    #[serde(default)]
    floating_nodes: Vec<I3Node>,
    num: Option<i32>,
    scratchpad_state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct I3WindowProperties {
    class: Option<String>,
    instance: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct I3Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl I3Node {
    fn to_window_info(&self, workspace: Option<i32>, in_dockarea: bool) -> Option<WindowInfo> {
        if in_dockarea {
            return None;
        }
        let window_id = self.window?;
        if self.window_type.as_deref() == Some("dock") {
            return None;
        }

        let properties = self.window_properties.as_ref();
        let title = clean_string(
            properties
                .and_then(|properties| properties.title.as_deref())
                .or(self.name.as_deref()),
        );
        let wm_class = clean_string(
            properties
                .and_then(|properties| properties.class.as_deref())
                .or_else(|| properties.and_then(|properties| properties.instance.as_deref())),
        );
        let app_id = clean_string(
            properties
                .and_then(|properties| properties.instance.as_deref())
                .or(wm_class.as_deref()),
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
            backend_window_id: None,
            title,
            app_id,
            wm_class,
            pid: None,
            bounds,
            workspace,
            focused: self.focused,
            hidden: self.scratchpad_state.as_deref() == Some("fresh"),
            client_type: Some("x11".to_string()),
            backend: I3_BACKEND.to_string(),
            terminal: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windowing::command_runner::tests::{output_with_status, FakeCommandRunner};

    #[test]
    fn list_and_activate_commands_run_through_fake_runner() {
        let socket = PathBuf::from("/run/user/1000/i3/ipc-socket.42");
        let tree = r#"{
          "nodes": [{
            "type": "workspace",
            "num": 2,
            "nodes": [{
              "type": "con",
              "name": "Terminal",
              "window": 4194307,
              "window_properties": {
                "class": "XTerm",
                "instance": "xterm",
                "title": "Terminal"
              },
              "rect": {"x": 10, "y": 20, "width": 800, "height": 600}
            }]
          }]
        }"#;
        let runner = FakeCommandRunner::new(vec![
            output_with_status(0, tree, ""),
            output_with_status(0, "_NET_WM_PID(CARDINAL) = 1234\n", ""),
            output_with_status(0, r#"[{"success":true}]"#, ""),
        ]);

        let windows = list_windows_with_runner_and_socket(&runner, Some(socket.clone())).unwrap();
        activate_window_with_runner_and_socket(&runner, Some(socket), 0x400003).unwrap();

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].window_id, 0x400003);
        assert_eq!(windows[0].pid, Some(1234));

        let invocations = runner.invocations();
        assert_eq!(invocations.len(), 3);
        assert!(invocations[0].program_is("i3-msg"));
        assert_eq!(
            invocations[0].args,
            vec!["-s", "/run/user/1000/i3/ipc-socket.42", "-t", "get_tree"]
        );
        assert!(invocations[1].program_is("xprop"));
        assert_eq!(invocations[1].args, vec!["-id", "4194307", "_NET_WM_PID"]);
        assert!(invocations[2].program_is("i3-msg"));
        assert_eq!(
            invocations[2].args,
            vec![
                "-s",
                "/run/user/1000/i3/ipc-socket.42",
                r#"[id="0x400003"] focus"#
            ]
        );
    }

    #[test]
    fn activate_window_reports_i3_refusal() {
        let runner = FakeCommandRunner::new(vec![output_with_status(
            0,
            r#"[{"success":false,"error":"No matching window"}]"#,
            "",
        )]);

        let error = activate_window_with_runner_and_socket(&runner, None, 0x400003).unwrap_err();

        assert!(error
            .to_string()
            .contains("i3-msg [id=\"0x400003\"] focus did not focus the window"));
        assert!(error.to_string().contains("No matching window"));
        let invocations = runner.invocations();
        assert_eq!(invocations.len(), 1);
        assert!(invocations[0].program_is("i3-msg"));
        assert_eq!(invocations[0].args, vec![r#"[id="0x400003"] focus"#]);
    }
}
