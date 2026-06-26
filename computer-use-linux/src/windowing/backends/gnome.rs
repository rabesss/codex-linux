use crate::diagnostics::hydrate_session_bus_env;
use crate::identity;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::process::Command;
use zbus::{zvariant::OwnedValue, Proxy};

pub const GNOME_SHELL_INTROSPECT_BACKEND: &str = "gnome-shell-introspect";
pub const GNOME_SHELL_EXTENSION_BACKEND: &str = "gnome-shell-extension";
pub const GNOME_SHELL_EXTENSION_SERVICE: &str = identity::DBUS_SERVICE;
pub const GNOME_SHELL_EXTENSION_OBJECT_PATH: &str = identity::DBUS_OBJECT_PATH;

pub fn probe_extension() -> BackendProbe {
    let method = format!("{GNOME_SHELL_EXTENSION_SERVICE}.ListWindows");
    let check = gdbus_call_check(
        GNOME_SHELL_EXTENSION_SERVICE,
        GNOME_SHELL_EXTENSION_OBJECT_PATH,
        &method,
        &[],
    );
    BackendProbe {
        id: GNOME_SHELL_EXTENSION_BACKEND,
        ok: check.ok,
        can_list_windows: check.ok,
        can_focus_apps: check.ok,
        can_focus_windows: check.ok,
        detail: check.detail,
    }
}

pub fn probe_introspect() -> BackendProbe {
    let list = gdbus_call_check(
        "org.gnome.Shell",
        "/org/gnome/Shell/Introspect",
        "org.gnome.Shell.Introspect.GetWindows",
        &[],
    );
    let focus_apps = gdbus_introspect_contains(
        "org.gnome.Shell",
        "/org/gnome/Shell",
        "org.gnome.Shell",
        "FocusApp",
    );
    BackendProbe {
        id: GNOME_SHELL_INTROSPECT_BACKEND,
        ok: list.ok,
        can_list_windows: list.ok,
        can_focus_apps: focus_apps.ok,
        can_focus_windows: false,
        detail: list.detail,
    }
}

pub async fn list_introspect_windows() -> Result<Vec<WindowInfo>> {
    hydrate_session_bus_env();

    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        "org.gnome.Shell",
        "/org/gnome/Shell/Introspect",
        "org.gnome.Shell.Introspect",
    )
    .await
    .context("failed to create GNOME Shell introspection proxy")?;
    let windows: HashMap<u64, HashMap<String, OwnedValue>> = proxy
        .call("GetWindows", &())
        .await
        .context("GNOME Shell GetWindows call failed")?;

    let mut windows = windows
        .into_iter()
        .map(|(window_id, properties)| window_from_properties(window_id, &properties))
        .collect::<Vec<_>>();
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub async fn list_extension_windows() -> Result<Vec<WindowInfo>> {
    let json = call_extension_json("ListWindows").await?;
    let mut windows: Vec<WindowInfo> =
        serde_json::from_str(&json).context("Codex GNOME Shell extension returned invalid JSON")?;
    for window in &mut windows {
        window.backend = GNOME_SHELL_EXTENSION_BACKEND.to_string();
    }
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub(crate) async fn focus_app(app_id: &str) -> Result<()> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        "org.gnome.Shell",
        "/org/gnome/Shell",
        "org.gnome.Shell",
    )
    .await
    .context("failed to create GNOME Shell proxy")?;
    let _: () = proxy
        .call("FocusApp", &(app_id))
        .await
        .with_context(|| format!("GNOME Shell FocusApp failed for app_id {app_id}"))?;
    Ok(())
}

async fn call_extension_json(method: &str) -> Result<String> {
    hydrate_session_bus_env();

    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        GNOME_SHELL_EXTENSION_SERVICE,
        GNOME_SHELL_EXTENSION_OBJECT_PATH,
        GNOME_SHELL_EXTENSION_SERVICE,
    )
    .await
    .context("failed to create Codex GNOME Shell extension proxy")?;
    let json: String = proxy
        .call(method, &())
        .await
        .with_context(|| format!("Codex GNOME Shell extension {method} call failed"))?;
    Ok(json)
}

pub(crate) async fn activate_extension_window(window_id: u64) -> Result<()> {
    hydrate_session_bus_env();

    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        GNOME_SHELL_EXTENSION_SERVICE,
        GNOME_SHELL_EXTENSION_OBJECT_PATH,
        GNOME_SHELL_EXTENSION_SERVICE,
    )
    .await
    .context("failed to create Codex GNOME Shell extension proxy")?;
    let (ok, message): (bool, String) = proxy
        .call("ActivateWindow", &(window_id))
        .await
        .with_context(|| {
            format!("Codex GNOME Shell extension ActivateWindow failed for {window_id}")
        })?;
    if ok {
        Ok(())
    } else {
        bail!("Codex GNOME Shell extension refused activation: {message}");
    }
}

pub(crate) fn window_from_properties(
    window_id: u64,
    properties: &HashMap<String, OwnedValue>,
) -> WindowInfo {
    let width = get_u32(properties, "width");
    let height = get_u32(properties, "height");
    let bounds = width.zip(height).map(|(width, height)| WindowBounds {
        x: get_i32(properties, "x"),
        y: get_i32(properties, "y"),
        width,
        height,
    });

    WindowInfo {
        window_id,
        backend_window_id: None,
        title: get_string(properties, "title"),
        app_id: get_string(properties, "app-id"),
        wm_class: get_string(properties, "wm-class"),
        pid: get_u32(properties, "pid"),
        bounds,
        workspace: get_i32(properties, "workspace"),
        focused: get_bool(properties, "has-focus").unwrap_or(false),
        hidden: get_bool(properties, "is-hidden").unwrap_or(false),
        client_type: get_u32(properties, "client-type").map(client_type_name),
        backend: GNOME_SHELL_INTROSPECT_BACKEND.to_string(),
        terminal: None,
    }
}

fn get_string(properties: &HashMap<String, OwnedValue>, key: &str) -> Option<String> {
    properties
        .get(key)
        .and_then(|value| <&str>::try_from(value).ok())
        .map(ToOwned::to_owned)
}

fn get_bool(properties: &HashMap<String, OwnedValue>, key: &str) -> Option<bool> {
    properties
        .get(key)
        .and_then(|value| bool::try_from(value).ok())
}

fn get_u32(properties: &HashMap<String, OwnedValue>, key: &str) -> Option<u32> {
    properties
        .get(key)
        .and_then(|value| u32::try_from(value).ok())
}

fn get_i32(properties: &HashMap<String, OwnedValue>, key: &str) -> Option<i32> {
    properties.get(key).and_then(|value| {
        i32::try_from(value).ok().or_else(|| {
            u32::try_from(value)
                .ok()
                .and_then(|value| value.try_into().ok())
        })
    })
}

fn client_type_name(value: u32) -> String {
    match value {
        0 => "wayland",
        1 => "x11",
        _ => "unknown",
    }
    .to_string()
}

struct ProbeCheck {
    ok: bool,
    detail: String,
}

fn gdbus_call_check(
    destination: &str,
    object_path: &str,
    method: &str,
    args: &[&str],
) -> ProbeCheck {
    let mut command = Command::new("gdbus");
    command.args([
        "call",
        "--session",
        "--dest",
        destination,
        "--object-path",
        object_path,
        "--method",
        method,
    ]);
    command.args(args);
    run_probe_command(command)
}

fn gdbus_introspect_contains(
    destination: &str,
    object_path: &str,
    interface: &str,
    member: &str,
) -> ProbeCheck {
    let check = run_probe_command({
        let mut command = Command::new("gdbus");
        command.args([
            "introspect",
            "--session",
            "--dest",
            destination,
            "--object-path",
            object_path,
        ]);
        command
    });
    if !check.ok {
        return check;
    }
    let needle = format!("{interface}.{member}");
    ProbeCheck {
        ok: check.detail.contains(&needle) || check.detail.contains(member),
        detail: if check.detail.contains(&needle) || check.detail.contains(member) {
            format!("{interface}.{member} is present")
        } else {
            format!("{interface}.{member} not found")
        },
    }
}

fn run_probe_command(mut command: Command) -> ProbeCheck {
    match command.output() {
        Ok(output) if output.status.success() => ProbeCheck {
            ok: true,
            detail: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        },
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            ProbeCheck {
                ok: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => ProbeCheck {
            ok: false,
            detail: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::Value;

    fn owned_value(value: Value<'_>) -> OwnedValue {
        OwnedValue::try_from(value).unwrap()
    }

    #[test]
    fn parses_introspect_properties_into_window_info() {
        let properties = HashMap::from([
            ("title".to_string(), owned_value(Value::from("Ghostty"))),
            (
                "app-id".to_string(),
                owned_value(Value::from("com.mitchellh.ghostty.desktop")),
            ),
            ("wm-class".to_string(), owned_value(Value::from("Ghostty"))),
            ("pid".to_string(), owned_value(Value::from(19313_u32))),
            ("x".to_string(), owned_value(Value::from(12_i32))),
            ("y".to_string(), owned_value(Value::from(34_i32))),
            ("width".to_string(), owned_value(Value::from(1200_u32))),
            ("height".to_string(), owned_value(Value::from(800_u32))),
            ("workspace".to_string(), owned_value(Value::from(2_i32))),
            ("has-focus".to_string(), owned_value(Value::from(true))),
            ("is-hidden".to_string(), owned_value(Value::from(false))),
            ("client-type".to_string(), owned_value(Value::from(1_u32))),
        ]);

        let window = window_from_properties(42, &properties);

        assert_eq!(window.window_id, 42);
        assert_eq!(window.title.as_deref(), Some("Ghostty"));
        assert_eq!(
            window.app_id.as_deref(),
            Some("com.mitchellh.ghostty.desktop")
        );
        assert_eq!(window.wm_class.as_deref(), Some("Ghostty"));
        assert_eq!(window.pid, Some(19313));
        let bounds = window.bounds.as_ref().unwrap();
        assert_eq!(bounds.x, Some(12));
        assert_eq!(bounds.y, Some(34));
        assert_eq!(bounds.width, 1200);
        assert_eq!(bounds.height, 800);
        assert_eq!(window.workspace, Some(2));
        assert!(window.focused);
        assert!(!window.hidden);
        assert_eq!(window.client_type.as_deref(), Some("x11"));
        assert_eq!(window.backend, GNOME_SHELL_INTROSPECT_BACKEND);
    }

    #[test]
    fn tolerates_malformed_introspect_properties() {
        let properties = HashMap::from([
            ("title".to_string(), owned_value(Value::from(123_u32))),
            ("pid".to_string(), owned_value(Value::from("not-a-pid"))),
            ("width".to_string(), owned_value(Value::from("wide"))),
            ("height".to_string(), owned_value(Value::from(800_u32))),
            ("has-focus".to_string(), owned_value(Value::from("true"))),
            ("is-hidden".to_string(), owned_value(Value::from("false"))),
            ("client-type".to_string(), owned_value(Value::from(99_u32))),
        ]);

        let window = window_from_properties(7, &properties);

        assert_eq!(window.window_id, 7);
        assert_eq!(window.title, None);
        assert_eq!(window.pid, None);
        assert!(window.bounds.is_none());
        assert!(!window.focused);
        assert!(!window.hidden);
        assert_eq!(window.client_type.as_deref(), Some("unknown"));
        assert_eq!(window.backend, GNOME_SHELL_INTROSPECT_BACKEND);
    }
}
