use crate::diagnostics::hydrate_session_bus_env;
use crate::windowing::types::WindowBounds;
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt, fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;
use zbus::{
    message::{Message, Type as MessageType},
    zvariant::{OwnedObjectPath, OwnedValue, Value},
    MatchRule, MessageStream, Proxy,
};

const PORTAL_REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const PORTAL_REQUEST_PATH_NAMESPACE: &str = "/org/freedesktop/portal/desktop/request";

pub const DEFAULT_SCREENSHOT_MAX_DIMENSION: u32 = 1920;
pub const DEFAULT_SCREENSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const ABSOLUTE_SCREENSHOT_MAX_DIMENSION: u32 = 4096;
pub const ABSOLUTE_SCREENSHOT_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_SCREENSHOT_JPEG_QUALITY: u8 = 80;
pub const MIN_SCREENSHOT_JPEG_QUALITY: u8 = 1;
pub const MAX_SCREENSHOT_JPEG_QUALITY: u8 = 95;
const MIN_SCREENSHOT_MAX_BYTES: usize = 1024;

#[derive(Debug, Clone)]
pub struct RawScreenshotCapture {
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub source: String,
    pub backend: String,
    pub width: u32,
    pub height: u32,
    pub visual_confidence: VisualConfidence,
    pub failure_chain: Vec<ScreenshotAttempt>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ScreenshotCapture {
    pub mime_type: String,
    pub data_url: String,
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub coordinate_width: u32,
    pub coordinate_height: u32,
    pub scale: f32,
    pub resized: bool,
    pub bytes: usize,
    pub original_bytes: usize,
    pub max_bytes: usize,
    pub format: ScreenshotOutputFormat,
    pub quality: Option<u8>,
    pub screenshot_backend: String,
    pub visual_confidence: VisualConfidence,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failure_chain: Vec<ScreenshotAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate_space: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cropped_to_window: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_backend_window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_monitor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_verified: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VisualConfidence {
    Full,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
pub struct ScreenshotAttempt {
    pub backend: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct ScreenshotFailure {
    pub attempts: Vec<ScreenshotAttempt>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ScreenshotPayloadOptions {
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_bytes: Option<usize>,
    pub scale: Option<f32>,
    pub format: Option<ScreenshotOutputFormat>,
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScreenshotOutputFormat {
    Png,
    Jpeg,
}

impl ScreenshotOutputFormat {
    fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ResolvedScreenshotPayloadOptions {
    max_width: u32,
    max_height: u32,
    max_bytes: usize,
    scale: f32,
    format: ScreenshotOutputFormat,
    quality: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScreenshotCleanup {
    DeletePath(PathBuf),
    Preserve,
}

impl ScreenshotPayloadOptions {
    fn resolve(self) -> ResolvedScreenshotPayloadOptions {
        let max_width = self
            .max_width
            .unwrap_or(DEFAULT_SCREENSHOT_MAX_DIMENSION)
            .clamp(1, ABSOLUTE_SCREENSHOT_MAX_DIMENSION);
        let max_height = self
            .max_height
            .unwrap_or(DEFAULT_SCREENSHOT_MAX_DIMENSION)
            .clamp(1, ABSOLUTE_SCREENSHOT_MAX_DIMENSION);
        let max_bytes = self
            .max_bytes
            .unwrap_or(DEFAULT_SCREENSHOT_MAX_BYTES)
            .clamp(MIN_SCREENSHOT_MAX_BYTES, ABSOLUTE_SCREENSHOT_MAX_BYTES);
        let scale = self
            .scale
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0)
            .min(1.0);
        let format = self.format.unwrap_or(ScreenshotOutputFormat::Png);
        let quality = self
            .quality
            .unwrap_or(DEFAULT_SCREENSHOT_JPEG_QUALITY)
            .clamp(MIN_SCREENSHOT_JPEG_QUALITY, MAX_SCREENSHOT_JPEG_QUALITY);

        ResolvedScreenshotPayloadOptions {
            max_width,
            max_height,
            max_bytes,
            scale,
            format,
            quality,
        }
    }
}

const SCREENSHOT_BACKEND_ENV: &str = "COMPUTER_USE_LINUX_SCREENSHOT_BACKEND";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScreenshotBackend {
    GnomeShell,
    HyprlandGrim,
    Portal,
    GnomeScreenshot,
}

impl ScreenshotBackend {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gnome-shell" | "gnome_shell" | "shell" => Some(Self::GnomeShell),
            "grim" | "hyprland-grim" | "hyprland_grim" => Some(Self::HyprlandGrim),
            "portal" | "xdg-portal" | "xdg_portal" => Some(Self::Portal),
            "gnome-screenshot" | "gnome_screenshot" => Some(Self::GnomeScreenshot),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::GnomeShell => "gnome-shell",
            Self::HyprlandGrim => "hyprland-grim",
            Self::Portal => "xdg-desktop-portal",
            Self::GnomeScreenshot => "gnome-screenshot",
        }
    }

    async fn capture(self) -> Result<RawScreenshotCapture> {
        match self {
            Self::GnomeShell => capture_with_gnome_shell().await,
            Self::HyprlandGrim => capture_with_hyprland_grim_raw().await,
            Self::Portal => capture_with_portal().await,
            Self::GnomeScreenshot => capture_with_gnome_screenshot().await,
        }
    }
}

pub async fn capture_screenshot_raw() -> Result<RawScreenshotCapture> {
    capture_screenshot_raw_traced()
        .await
        .map_err(|failure| anyhow!(failure.to_string()))
}

pub async fn capture_screenshot_raw_traced(
) -> std::result::Result<RawScreenshotCapture, ScreenshotFailure> {
    hydrate_session_bus_env();

    let backends = match forced_backend() {
        Ok(Some(forced)) => vec![forced],
        Ok(None) => default_screenshot_backends(),
        Err(error) => {
            return Err(ScreenshotFailure {
                attempts: vec![ScreenshotAttempt {
                    backend: "forced-backend".to_string(),
                    ok: false,
                    detail: error.to_string(),
                }],
            });
        }
    };

    let mut attempts = Vec::new();
    for backend in backends {
        match backend.capture().await {
            Ok(mut capture) => {
                capture.source = backend.id().to_string();
                capture.backend = backend.id().to_string();
                capture.visual_confidence = VisualConfidence::Full;
                capture.failure_chain = attempts;
                return Ok(capture);
            }
            Err(error) => attempts.push(ScreenshotAttempt {
                backend: backend.id().to_string(),
                ok: false,
                detail: format!("{error:#}"),
            }),
        }
    }

    Err(ScreenshotFailure { attempts })
}

fn default_screenshot_backends() -> Vec<ScreenshotBackend> {
    let mut backends = Vec::new();
    if is_hyprland_session() {
        backends.push(ScreenshotBackend::HyprlandGrim);
    }
    backends.push(ScreenshotBackend::GnomeShell);
    backends.push(ScreenshotBackend::Portal);
    backends.push(ScreenshotBackend::GnomeScreenshot);
    backends
}

fn is_hyprland_session() -> bool {
    [
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
    ]
    .iter()
    .filter_map(|key| std::env::var(key).ok())
    .any(|value| value.to_ascii_lowercase().contains("hyprland"))
        || std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
}

impl fmt::Display for ScreenshotFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.attempts.is_empty() {
            return write!(f, "screenshot capture failed without any backend attempts");
        }
        write!(
            f,
            "{}",
            self.attempts
                .iter()
                .map(|attempt| format!("{} failed: {}", attempt.backend, attempt.detail))
                .collect::<Vec<_>>()
                .join("; ")
        )
    }
}

fn forced_backend() -> Result<Option<ScreenshotBackend>> {
    match std::env::var(SCREENSHOT_BACKEND_ENV) {
        Ok(value) if !value.trim().is_empty() => {
            ScreenshotBackend::parse(&value).map(Some).ok_or_else(|| {
                anyhow!(
                    "{SCREENSHOT_BACKEND_ENV}={value:?} is not a recognized backend \
                     (expected gnome-shell, hyprland-grim, portal, or gnome-screenshot)"
                )
            })
        }
        _ => Ok(None),
    }
}

pub async fn capture_screenshot() -> Result<ScreenshotCapture> {
    let raw = capture_screenshot_raw().await?;
    prepare_screenshot_payload(raw, ScreenshotPayloadOptions::default())
}

pub async fn capture_with_hyprland_grim_raw() -> Result<RawScreenshotCapture> {
    capture_with_grim_geometry(None, "hyprland-grim").await
}

pub async fn capture_region_with_grim_raw(bounds: &WindowBounds) -> Result<RawScreenshotCapture> {
    capture_region_with_grim_raw_named(bounds, "hyprland-grim-window").await
}

pub async fn capture_region_with_grim_raw_named(
    bounds: &WindowBounds,
    source: &str,
) -> Result<RawScreenshotCapture> {
    let (x, y, width, height) = window_region(bounds)?;
    let geometry = grim_geometry(x, y, width, height);
    capture_with_grim_geometry(Some(geometry), source).await
}

async fn capture_with_grim_geometry(
    geometry: Option<String>,
    source: &str,
) -> Result<RawScreenshotCapture> {
    let path = temp_png_path("hyprland-grim-window");
    let mut command = StdCommand::new("grim");
    if let Some(geometry) = geometry.as_deref() {
        command.args(["-g", geometry]);
    }
    let output = command
        .arg(&path)
        .output()
        .with_context(|| match geometry.as_deref() {
            Some(geometry) => format!("failed to run grim -g {geometry}"),
            None => "failed to run grim".to_string(),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = match (stderr.is_empty(), stdout.is_empty()) {
            (false, false) => format!("stderr: {stderr}; stdout: {stdout}"),
            (false, true) => stderr,
            (true, false) => stdout,
            (true, true) => format!("exit status {}", output.status),
        };
        let _ = fs::remove_file(&path);
        let command = geometry
            .as_deref()
            .map(|geometry| format!("grim -g {geometry}"))
            .unwrap_or_else(|| "grim".to_string());
        bail!("{command} failed: {detail}");
    }

    let mut capture =
        read_png_as_capture(path.clone(), source, ScreenshotCleanup::DeletePath(path)).await?;
    capture.backend = "hyprland-grim".to_string();
    Ok(capture)
}

pub fn prepare_screenshot_payload(
    raw: RawScreenshotCapture,
    options: ScreenshotPayloadOptions,
) -> Result<ScreenshotCapture> {
    if raw.bytes.is_empty() {
        bail!("screenshot file was empty");
    }
    if raw.mime_type != "image/png" {
        bail!(
            "screenshot payload source was {}, expected image/png",
            raw.mime_type
        );
    }
    let (coordinate_width, coordinate_height) = png_dimensions(&raw.bytes)?;
    let original_bytes = raw.bytes.len();
    let options = options.resolve();
    let (target_width, target_height) =
        target_dimensions(coordinate_width, coordinate_height, options);

    let screenshot_backend = raw.backend.clone();
    let visual_confidence = raw.visual_confidence;
    let failure_chain = raw.failure_chain.clone();

    let (bytes, width, height) = if options.format == ScreenshotOutputFormat::Png
        && target_width == coordinate_width
        && target_height == coordinate_height
        && original_bytes <= options.max_bytes
    {
        (raw.bytes, coordinate_width, coordinate_height)
    } else {
        encode_screenshot_to_fit_bytes(
            &raw.bytes,
            coordinate_width,
            coordinate_height,
            target_width,
            target_height,
            options,
        )?
    };

    let encoded = STANDARD.encode(&bytes);
    let scale = if coordinate_width == 0 {
        1.0
    } else {
        width as f32 / coordinate_width as f32
    };

    Ok(ScreenshotCapture {
        mime_type: options.format.mime_type().to_string(),
        data_url: format!("data:{};base64,{encoded}", options.format.mime_type()),
        source: raw.source,
        width,
        height,
        coordinate_width,
        coordinate_height,
        scale,
        resized: width != coordinate_width || height != coordinate_height,
        bytes: bytes.len(),
        original_bytes,
        max_bytes: options.max_bytes,
        format: options.format,
        quality: (options.format == ScreenshotOutputFormat::Jpeg).then_some(options.quality),
        screenshot_backend,
        visual_confidence,
        failure_chain,
        origin_x: None,
        origin_y: None,
        coordinate_space: None,
        cropped_to_window: None,
        target_window_id: None,
        target_backend_window_id: None,
        target_monitor: None,
        focus_verified: None,
    })
}

async fn capture_with_gnome_shell() -> Result<RawScreenshotCapture> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        "org.gnome.Shell.Screenshot",
        "/org/gnome/Shell/Screenshot",
        "org.gnome.Shell.Screenshot",
    )
    .await
    .context("failed to create GNOME Shell screenshot proxy")?;
    let path = temp_png_path("gnome-shell");
    let filename = path
        .to_str()
        .context("temporary screenshot path is not valid UTF-8")?;
    let result = proxy.call("Screenshot", &(false, false, filename)).await;
    let (success, filename_used): (bool, String) = match result {
        Ok(result) => result,
        Err(error) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("GNOME Shell Screenshot call failed");
        }
    };

    if !success {
        cleanup_gnome_requested_path(&path);
        bail!("GNOME Shell reported screenshot failure");
    }

    read_png_as_capture(
        PathBuf::from(filename_used),
        "gnome-shell",
        ScreenshotCleanup::DeletePath(path),
    )
    .await
}

async fn capture_with_portal() -> Result<RawScreenshotCapture> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let token = request_token();
    // Some portals rewrite the request handle, so subscribe before calling Screenshot
    // and filter by the returned handle instead of subscribing after the call.
    let mut response_stream = portal_response_stream(&connection).await?;

    let portal_proxy = Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
    )
    .await
    .context("failed to create XDG portal screenshot proxy")?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    options.insert("interactive", Value::from(false));
    let handle: OwnedObjectPath = portal_proxy
        .call("Screenshot", &("", options))
        .await
        .context("XDG portal Screenshot call failed")?;

    let (response_code, results) = tokio::time::timeout(
        Duration::from_secs(20),
        wait_for_portal_response(&mut response_stream, handle.as_str()),
    )
    .await
    .context("timed out waiting for XDG portal screenshot response")??;

    if response_code != 0 {
        bail!("XDG portal screenshot was denied or cancelled with response code {response_code}");
    }

    let uri_value = results
        .get("uri")
        .context("XDG portal screenshot response did not include a uri")?;
    let uri: String = uri_value
        .try_clone()
        .context("failed to clone XDG portal screenshot uri")?
        .try_into()
        .context("XDG portal screenshot uri was not a string")?;
    let path = file_uri_to_path(&uri)?;

    read_png_as_capture(path, "xdg-desktop-portal", ScreenshotCleanup::Preserve).await
}

const GNOME_SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(20);

async fn capture_with_gnome_screenshot() -> Result<RawScreenshotCapture> {
    let path = temp_png_path("gnome-screenshot");
    let filename = path
        .to_str()
        .context("temporary screenshot path is not valid UTF-8")?;

    let mut child = match Command::new("gnome-screenshot")
        .args(["-f", filename])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("failed to spawn gnome-screenshot");
        }
    };

    let status = match tokio::time::timeout(GNOME_SCREENSHOT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("failed to wait for gnome-screenshot");
        }
        Err(_) => {
            let _ = child.kill().await;
            cleanup_gnome_requested_path(&path);
            bail!("gnome-screenshot timed out");
        }
    };

    if !status.success() {
        cleanup_gnome_requested_path(&path);
        bail!("gnome-screenshot exited with {status}");
    }

    read_png_as_capture(
        path.clone(),
        "gnome-screenshot",
        ScreenshotCleanup::DeletePath(path),
    )
    .await
}

async fn portal_response_stream(connection: &zbus::Connection) -> Result<MessageStream> {
    let response_rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .interface(PORTAL_REQUEST_INTERFACE)?
        .member("Response")?
        .path_namespace(PORTAL_REQUEST_PATH_NAMESPACE)?
        .build();

    MessageStream::for_match_rule(response_rule, connection, None)
        .await
        .context("failed to subscribe to XDG portal screenshot responses")
}

async fn wait_for_portal_response(
    response_stream: &mut MessageStream,
    request_path: &str,
) -> Result<(u32, HashMap<String, OwnedValue>)> {
    loop {
        let response = response_stream
            .next()
            .await
            .context("XDG portal screenshot response stream ended")?
            .context("XDG portal screenshot response stream failed")?;

        if !portal_response_matches_path(&response, request_path) {
            continue;
        }

        return response
            .body()
            .deserialize()
            .context("failed to decode XDG portal screenshot response");
    }
}

fn portal_response_matches_path(response: &Message, request_path: &str) -> bool {
    response
        .header()
        .path()
        .is_some_and(|path| path.as_str() == request_path)
}

async fn read_png_as_capture(
    path: PathBuf,
    source: &str,
    cleanup: ScreenshotCleanup,
) -> Result<RawScreenshotCapture> {
    let result = read_png_as_capture_inner(&path, source);
    if let ScreenshotCleanup::DeletePath(path) = cleanup {
        let _ = fs::remove_file(path);
    }
    result
}

fn read_png_as_capture_inner(path: &Path, source: &str) -> Result<RawScreenshotCapture> {
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read screenshot file {}", path.display()))?;
    if bytes.is_empty() {
        bail!("screenshot file was empty: {}", path.display());
    }
    let (width, height) = png_dimensions(&bytes)?;
    Ok(RawScreenshotCapture {
        mime_type: "image/png".to_string(),
        bytes,
        source: source.to_string(),
        backend: source.to_string(),
        width,
        height,
        visual_confidence: VisualConfidence::Full,
        failure_chain: Vec::new(),
    })
}

fn target_dimensions(
    width: u32,
    height: u32,
    options: ResolvedScreenshotPayloadOptions,
) -> (u32, u32) {
    let width_scale = options.max_width as f64 / width as f64;
    let height_scale = options.max_height as f64 / height as f64;
    let scale = f64::from(options.scale)
        .min(width_scale)
        .min(height_scale)
        .min(1.0);

    let target_width = ((width as f64 * scale).round() as u32).clamp(1, width);
    let target_height = ((height as f64 * scale).round() as u32).clamp(1, height);
    (target_width, target_height)
}

fn encode_screenshot_to_fit_bytes(
    raw: &[u8],
    original_width: u32,
    original_height: u32,
    mut target_width: u32,
    mut target_height: u32,
    options: ResolvedScreenshotPayloadOptions,
) -> Result<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(raw, image::ImageFormat::Png)
        .context("failed to decode screenshot PNG for encoding")?;

    loop {
        let bytes = if options.format == ScreenshotOutputFormat::Png
            && target_width == original_width
            && target_height == original_height
        {
            raw.to_vec()
        } else {
            let output = if target_width == original_width && target_height == original_height {
                img.clone()
            } else {
                img.resize_exact(target_width, target_height, FilterType::Lanczos3)
            };
            encode_image(&output, options)?
        };

        if bytes.len() <= options.max_bytes {
            return Ok((bytes, target_width, target_height));
        }

        if target_width == 1 && target_height == 1 {
            bail!(
                "screenshot payload is {} bytes at 1x1, over max_bytes {}",
                bytes.len(),
                options.max_bytes
            );
        }

        (target_width, target_height) = next_dimensions_for_byte_cap(
            target_width,
            target_height,
            bytes.len(),
            options.max_bytes,
        );
    }
}

fn encode_image(
    img: &image::DynamicImage,
    options: ResolvedScreenshotPayloadOptions,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    match options.format {
        ScreenshotOutputFormat::Png => {
            img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
                .context("failed to encode screenshot PNG")?;
        }
        ScreenshotOutputFormat::Jpeg => {
            let rgb = img.to_rgb8();
            JpegEncoder::new_with_quality(&mut out, options.quality)
                .encode_image(&rgb)
                .context("failed to encode screenshot JPEG")?;
        }
    }
    Ok(out)
}

fn next_dimensions_for_byte_cap(
    width: u32,
    height: u32,
    encoded_bytes: usize,
    max_bytes: usize,
) -> (u32, u32) {
    let shrink = ((max_bytes as f64 / encoded_bytes as f64).sqrt() * 0.9).clamp(0.1, 0.95);
    let mut next_width = ((width as f64 * shrink).floor() as u32).max(1);
    let mut next_height = ((height as f64 * shrink).floor() as u32).max(1);

    if next_width >= width && width > 1 {
        next_width = width - 1;
    }
    if next_height >= height && height > 1 {
        next_height = height - 1;
    }

    (next_width, next_height)
}

pub(crate) fn window_region(bounds: &WindowBounds) -> Result<(i32, i32, u32, u32)> {
    let x = bounds.x.context("target window bounds are missing x")?;
    let y = bounds.y.context("target window bounds are missing y")?;
    if bounds.width == 0 || bounds.height == 0 {
        bail!(
            "target window bounds have invalid size {}x{}",
            bounds.width,
            bounds.height
        );
    }
    Ok((x, y, bounds.width, bounds.height))
}

pub(crate) fn grim_geometry(x: i32, y: i32, width: u32, height: u32) -> String {
    format!("{x},{y} {width}x{height}")
}

fn cleanup_gnome_requested_path(path: &Path) {
    let _ = fs::remove_file(path);
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        bail!("screenshot file was not a valid PNG");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        bail!("screenshot PNG had invalid dimensions {width}x{height}");
    }
    Ok((width, height))
}

fn file_uri_to_path(uri: &str) -> Result<PathBuf> {
    let Some(rest) = uri.strip_prefix("file://") else {
        bail!("unsupported screenshot uri: {uri}");
    };
    Ok(PathBuf::from(percent_decode(rest)))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                    continue;
                }
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

fn temp_png_path(source: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "codex-computer-use-{source}-{}.png",
        unique_suffix()
    ))
}

fn request_token() -> String {
    format!("codex_{}", unique_suffix().replace('-', "_"))
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("codex-screenshot-test-{name}-{}", unique_suffix()))
    }

    fn valid_png(width: u32, height: u32) -> Vec<u8> {
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13_u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([24, 96, 160, 255]));
        encode_test_png(img)
    }

    fn noisy_png(width: u32, height: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(width, height);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            let r = ((x * 31 + y * 17) % 256) as u8;
            let g = ((x * 13 + y * 47) % 256) as u8;
            let b = ((x * 97 + y * 7) % 256) as u8;
            *pixel = image::Rgba([r, g, b, 255]);
        }
        encode_test_png(img)
    }

    fn encode_test_png(img: image::RgbaImage) -> Vec<u8> {
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn raw_capture(bytes: Vec<u8>) -> RawScreenshotCapture {
        let (width, height) = png_dimensions(&bytes).unwrap();
        RawScreenshotCapture {
            mime_type: "image/png".to_string(),
            bytes,
            source: "test".to_string(),
            backend: "test".to_string(),
            width,
            height,
            visual_confidence: VisualConfidence::Full,
            failure_chain: Vec::new(),
        }
    }

    #[test]
    fn decodes_file_uri_percent_escapes() {
        assert_eq!(
            file_uri_to_path("file:///tmp/Codex%20Screenshot.png").unwrap(),
            PathBuf::from("/tmp/Codex Screenshot.png")
        );
    }

    #[test]
    fn request_token_is_portal_safe() {
        let token = request_token();
        assert!(token.starts_with("codex_"));
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }

    #[test]
    fn parses_known_backend_names() {
        assert_eq!(
            ScreenshotBackend::parse("gnome-shell"),
            Some(ScreenshotBackend::GnomeShell)
        );
        assert_eq!(
            ScreenshotBackend::parse("hyprland_grim"),
            Some(ScreenshotBackend::HyprlandGrim)
        );
        assert_eq!(
            ScreenshotBackend::parse("  Portal "),
            Some(ScreenshotBackend::Portal)
        );
        assert_eq!(
            ScreenshotBackend::parse("GNOME_SCREENSHOT"),
            Some(ScreenshotBackend::GnomeScreenshot)
        );
        assert_eq!(ScreenshotBackend::parse("nonsense"), None);
    }

    #[test]
    fn prepares_default_payload_without_resize() {
        let capture = prepare_screenshot_payload(
            raw_capture(solid_png(16, 8)),
            ScreenshotPayloadOptions::default(),
        )
        .unwrap();

        assert_eq!(capture.mime_type, "image/png");
        assert_eq!(capture.width, 16);
        assert_eq!(capture.height, 8);
        assert_eq!(capture.coordinate_width, 16);
        assert_eq!(capture.coordinate_height, 8);
        assert_eq!(capture.scale, 1.0);
        assert!(!capture.resized);
        assert!(capture.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(capture.bytes, capture.original_bytes);
        assert_eq!(capture.screenshot_backend, "test");
        assert_eq!(capture.visual_confidence, VisualConfidence::Full);
        assert!(capture.failure_chain.is_empty());
    }

    #[test]
    fn prepares_payload_with_dimension_resize() {
        let capture = prepare_screenshot_payload(
            raw_capture(solid_png(400, 200)),
            ScreenshotPayloadOptions {
                max_width: Some(100),
                max_height: Some(100),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(capture.width, 100);
        assert_eq!(capture.height, 50);
        assert_eq!(capture.coordinate_width, 400);
        assert_eq!(capture.coordinate_height, 200);
        assert_eq!(capture.scale, 0.25);
        assert!(capture.resized);
    }

    #[test]
    fn prepares_jpeg_payload_under_byte_cap() {
        let capture = prepare_screenshot_payload(
            raw_capture(noisy_png(256, 256)),
            ScreenshotPayloadOptions {
                max_bytes: Some(4096),
                format: Some(ScreenshotOutputFormat::Jpeg),
                quality: Some(80),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(capture.mime_type, "image/jpeg");
        assert_eq!(capture.format, ScreenshotOutputFormat::Jpeg);
        assert_eq!(capture.quality, Some(80));
        assert!(capture.bytes <= 4096);
        assert!(capture.resized);
        assert!(capture.data_url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn reads_png_dimensions_from_ihdr() {
        let png = valid_png(3840, 1080);

        assert_eq!(png_dimensions(&png).unwrap(), (3840, 1080));
    }

    #[test]
    fn formats_grim_window_geometry() {
        assert_eq!(grim_geometry(6, 51, 2548, 1383), "6,51 2548x1383");
        assert_eq!(grim_geometry(-1920, 0, 1920, 1080), "-1920,0 1920x1080");
    }

    #[test]
    fn rejects_window_region_without_origin_or_size() {
        let missing_origin = WindowBounds {
            x: None,
            y: Some(0),
            width: 800,
            height: 600,
        };
        assert!(window_region(&missing_origin)
            .unwrap_err()
            .to_string()
            .contains("missing x"));

        let empty = WindowBounds {
            x: Some(0),
            y: Some(0),
            width: 0,
            height: 600,
        };
        assert!(window_region(&empty)
            .unwrap_err()
            .to_string()
            .contains("invalid size"));
    }

    #[tokio::test]
    async fn portal_capture_preserves_valid_returned_path() {
        let path = test_path("portal-valid");
        fs::write(&path, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            path.clone(),
            "xdg-desktop-portal",
            ScreenshotCleanup::Preserve,
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "xdg-desktop-portal");
        assert!(path.exists());
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn portal_capture_preserves_invalid_returned_path() {
        let path = test_path("portal-invalid");
        fs::write(&path, b"").unwrap();

        let error = read_png_as_capture(
            path.clone(),
            "xdg-desktop-portal",
            ScreenshotCleanup::Preserve,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("screenshot file was empty"));
        assert!(path.exists());
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn gnome_capture_deletes_backend_temp_path_on_success() {
        let path = test_path("gnome-valid");
        fs::write(&path, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            path.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(path.clone()),
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "gnome-shell");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn gnome_capture_deletes_backend_temp_path_on_parse_failure() {
        let path = test_path("gnome-invalid");
        fs::write(&path, b"").unwrap();

        let error = read_png_as_capture(
            path.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(path.clone()),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("screenshot file was empty"));
        assert!(!path.exists());
    }

    #[test]
    fn gnome_failure_cleanup_removes_requested_temp_path() {
        let path = test_path("gnome-pre-read-failure");
        fs::write(&path, b"partial").unwrap();

        cleanup_gnome_requested_path(&path);

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn gnome_deletes_requested_temp_path_and_preserves_unexpected_returned_path() {
        let requested = test_path("gnome-requested");
        let returned = test_path("gnome-returned");
        fs::write(&requested, b"partial").unwrap();
        fs::write(&returned, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            returned.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(requested.clone()),
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "gnome-shell");
        assert!(!requested.exists());
        assert!(returned.exists());
        let _ = fs::remove_file(returned);
    }
}
