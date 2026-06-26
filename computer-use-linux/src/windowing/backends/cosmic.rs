use crate::cosmic_helper;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::WindowInfo;
use anyhow::{bail, Context, Result};

pub const COSMIC_WAYLAND_BACKEND: &str = "cosmic-wayland";

pub fn probe() -> BackendProbe {
    match cosmic_helper::probe() {
        Ok(probe) => BackendProbe {
            id: COSMIC_WAYLAND_BACKEND,
            ok: probe.ok,
            can_list_windows: probe.can_list_windows,
            can_focus_apps: probe.can_activate_windows,
            can_focus_windows: probe.can_activate_windows,
            detail: probe.detail,
        },
        Err(error) => BackendProbe {
            id: COSMIC_WAYLAND_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: error.to_string(),
        },
    }
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    let json = cosmic_helper::list_windows_json()?;
    let mut windows = parse_cosmic_windows_json(&json)?;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub fn focused_window() -> Result<Option<WindowInfo>> {
    let json = cosmic_helper::focused_window_json()?;
    parse_cosmic_focused_window_json(&json)
}

fn parse_cosmic_windows_json(json: &str) -> Result<Vec<WindowInfo>> {
    let mut windows: Vec<WindowInfo> =
        serde_json::from_str(json).context("COSMIC helper returned invalid list-windows JSON")?;
    for window in &mut windows {
        normalize_cosmic_backend(window);
    }
    windows.sort_by_key(|window| window.window_id);
    Ok(windows)
}

fn parse_cosmic_focused_window_json(json: &str) -> Result<Option<WindowInfo>> {
    let mut window: Option<WindowInfo> =
        serde_json::from_str(json).context("COSMIC helper returned invalid focused-window JSON")?;
    if let Some(window) = window.as_mut() {
        normalize_cosmic_backend(window);
    }
    Ok(window)
}

fn normalize_cosmic_backend(window: &mut WindowInfo) {
    window.backend = COSMIC_WAYLAND_BACKEND.to_string();
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let activation = cosmic_helper::activate_window(window_id)?;
    if activation.ok {
        Ok(())
    } else {
        bail!("COSMIC helper refused activation: {}", activation.detail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_windows_json_and_normalizes_backend() {
        let json = r#"[
          {
            "window_id": 42,
            "backend_window_id": "cosmic-42",
            "title": "Codex",
            "app_id": "com.openai.codex",
            "wm_class": null,
            "pid": 8123,
            "bounds": {"x": 20, "y": 40, "width": 1200, "height": 800},
            "workspace": 3,
            "focused": true,
            "hidden": false,
            "client_type": "wayland",
            "backend": "helper-raw"
          },
          {
            "window_id": 7,
            "title": "Hidden dialog",
            "app_id": "org.example.Dialog",
            "wm_class": null,
            "pid": null,
            "bounds": {"x": null, "y": null, "width": 640, "height": 480},
            "workspace": null,
            "focused": false,
            "hidden": true,
            "client_type": "wayland",
            "backend": "cosmic-helper"
          }
        ]"#;

        let windows = parse_cosmic_windows_json(json).unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window_id, 7);
        assert_eq!(windows[0].title.as_deref(), Some("Hidden dialog"));
        assert!(windows[0].hidden);
        assert_eq!(windows[0].backend, COSMIC_WAYLAND_BACKEND);
        assert_eq!(windows[1].window_id, 42);
        assert_eq!(windows[1].backend_window_id.as_deref(), Some("cosmic-42"));
        assert_eq!(windows[1].bounds.as_ref().unwrap().x, Some(20));
        assert!(windows[1].focused);
        assert_eq!(windows[1].backend, COSMIC_WAYLAND_BACKEND);
    }

    #[test]
    fn parses_focused_window_json_and_normalizes_backend() {
        let json = r#"{
          "window_id": 99,
          "title": "Focused",
          "app_id": "org.example.Focused",
          "wm_class": "Focused",
          "pid": 9001,
          "bounds": {"x": 1, "y": 2, "width": 300, "height": 200},
          "workspace": 1,
          "focused": true,
          "hidden": false,
          "client_type": "wayland",
          "backend": "raw-cosmic"
        }"#;

        let window = parse_cosmic_focused_window_json(json).unwrap().unwrap();

        assert_eq!(window.window_id, 99);
        assert_eq!(window.title.as_deref(), Some("Focused"));
        assert_eq!(window.pid, Some(9001));
        assert_eq!(window.backend, COSMIC_WAYLAND_BACKEND);
    }

    #[test]
    fn parses_focused_window_null_response() {
        assert!(parse_cosmic_focused_window_json("null").unwrap().is_none());
    }

    #[test]
    fn rejects_malformed_list_windows_json() {
        let error = parse_cosmic_windows_json("{not json").unwrap_err();

        assert!(error
            .to_string()
            .contains("COSMIC helper returned invalid list-windows JSON"));
    }
}
