#!/usr/bin/env python3
import ctypes
import ctypes.util
import functools
import http.server
import io
import json
import os
import signal
import sys
import urllib.error
import urllib.parse
import urllib.request


def _install_parent_death_signal():
    # Ensure the kernel terminates this process if the launcher (parent) exits
    # without invoking its cleanup trap (SIGKILL, OOM, crash). Without this,
    # the HTTP server can outlive the launcher and block its webview port,
    # which is fatal for multi-instance launches pinned to a single port.
    if sys.platform != "linux":
        return
    libc_name = ctypes.util.find_library("c") or "libc.so.6"
    try:
        libc = ctypes.CDLL(libc_name, use_errno=True)
    except OSError:
        return
    PR_SET_PDEATHSIG = 1
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
        return
    # The parent may have died between fork() and prctl(); in that case the
    # death signal never fires. Bail out now so the port is freed promptly.
    if os.getppid() == 1:
        os._exit(0)


_install_parent_death_signal()


port = int(sys.argv[1])
bind = "127.0.0.1"
if len(sys.argv) >= 4 and sys.argv[2] == "--bind":
    bind = sys.argv[3]

CUSTOM_MODEL_CATALOG_ROUTE = "/codex-linux/custom-model-catalog.json"
MAX_CUSTOM_MODEL_CATALOG_BYTES = 2 * 1024 * 1024
CUSTOM_MODEL_CATALOG_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _provider_string_value(value):
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _provider_positive_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str):
        try:
            parsed = int(value.strip())
        except ValueError:
            return None
        if parsed > 0:
            return parsed
    return None


def _provider_string_map(value):
    if not isinstance(value, dict):
        return None
    mapped = {}
    for key, item in value.items():
        header = _provider_string_value(key)
        env_name = _provider_string_value(item)
        if header and env_name:
            mapped[header] = env_name
    return mapped or None


def _safe_static_header_name(value):
    header = value.strip().lower()
    if header in {"authorization", "proxy-authorization", "cookie", "set-cookie"}:
        return False
    return not any(token in header for token in (
        "api-key",
        "apikey",
        "token",
        "secret",
        "credential",
        "password",
        "bearer",
    ))


def _safe_http_headers(value):
    if not isinstance(value, dict):
        return None
    mapped = {}
    for key, item in value.items():
        header = _provider_string_value(key)
        header_value = _provider_string_value(item)
        if header and header_value and _safe_static_header_name(header):
            mapped[header] = header_value
    return mapped or None


def _provider_auth_config(value):
    if not isinstance(value, dict):
        return None
    command = _provider_string_value(value.get("command"))
    if not command:
        return None
    return {"command": command}


def _provider_config(provider):
    if not isinstance(provider, dict):
        return None
    config = {}
    for field in ("name", "base_url", "wire_api", "env_key"):
        value = _provider_string_value(provider.get(field))
        if value:
            config[field] = value
    env_headers = _provider_string_map(provider.get("env_http_headers"))
    if env_headers:
        config["env_http_headers"] = env_headers
    headers = _safe_http_headers(provider.get("http_headers"))
    if headers:
        config["http_headers"] = headers
    auth = _provider_auth_config(provider.get("auth"))
    if auth:
        config["auth"] = auth
    if isinstance(provider.get("requires_openai_auth"), bool):
        config["requires_openai_auth"] = provider["requires_openai_auth"]
    for field in ("request_max_retries", "stream_max_retries", "stream_idle_timeout_ms"):
        value = _provider_positive_int(provider.get(field))
        if value is not None:
            config[field] = value
    return config or None


def _split_catalog_urls(raw):
    urls = []
    for line in raw.replace(",", "\n").splitlines():
        for item in line.split():
            if item:
                urls.append(item)
    return urls


def _loopback_catalog_url(url):
    try:
        parts = urllib.parse.urlsplit(url)
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == "http"
        and hostname in {"127.0.0.1", "localhost", "::1"}
        and port is not None
        and bool(parts.netloc)
        and bool(parts.path)
    )


def _custom_model_catalog_paths():
    codex_home = os.environ.get("CODEX_HOME", os.path.join(os.path.expanduser("~"), ".codex"))
    config_home = os.environ.get("XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config"))
    state_home = os.environ.get(
        "XDG_STATE_HOME",
        os.path.join(os.path.expanduser("~"), ".local", "state"),
    )
    configured = os.environ.get("CODEX_CUSTOM_MODEL_CATALOG_JSON")
    shim_catalog = os.environ.get(
        "CODEX_SHIM_MODEL_CATALOG_JSON",
        os.path.join(state_home, "codex-shim", "custom_model_catalog.json"),
    )
    candidates = [
        configured,
        os.path.join(codex_home, "custom-models.json"),
        os.path.join(config_home, "codex-desktop", "custom-models.json"),
        shim_catalog,
    ]
    paths = []
    seen_paths = set()
    for candidate in candidates:
        if not candidate:
            continue
        path = os.path.abspath(os.path.expanduser(candidate))
        if path in seen_paths or not os.path.isfile(path) or not os.access(path, os.R_OK):
            continue
        paths.append(path)
        seen_paths.add(path)
    return paths


def _custom_model_catalog_urls():
    candidates = []
    configured = os.environ.get("CODEX_CUSTOM_MODEL_CATALOG_URLS")
    if configured:
        candidates.extend(_split_catalog_urls(configured))
    shim_url = os.environ.get("CODEX_SHIM_MODEL_CATALOG_URL")
    if shim_url:
        candidates.append(shim_url)
    urls = []
    seen_urls = set()
    for candidate in candidates:
        url = candidate.strip()
        if not url or url in seen_urls or not _loopback_catalog_url(url):
            continue
        urls.append(url)
        seen_urls.add(url)
    return urls


def _read_custom_model_catalog(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return [], {}
    return _catalog_models_and_providers(data)


def _read_custom_model_catalog_url(url):
    try:
        with CUSTOM_MODEL_CATALOG_OPENER.open(url, timeout=1.0) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                return [], {}
            payload = response.read(MAX_CUSTOM_MODEL_CATALOG_BYTES + 1)
    except (OSError, TimeoutError, urllib.error.URLError):
        return [], {}
    if len(payload) > MAX_CUSTOM_MODEL_CATALOG_BYTES:
        return [], {}
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return [], {}
    return _catalog_models_and_providers(data)


def _catalog_models_and_providers(data):
    models = data.get("models") if isinstance(data, dict) else data
    providers = data.get("providers") if isinstance(data, dict) else {}
    if not isinstance(models, list):
        models = []
    if not isinstance(providers, dict):
        providers = {}
    sanitized_providers = {}
    for provider_id, provider in providers.items():
        provider_key = _provider_string_value(provider_id)
        config = _provider_config(provider)
        if provider_key and config:
            sanitized_providers[provider_key] = config
    return (
        [
            model
            for model in models
            if (
                isinstance(model, dict)
                and isinstance(model.get("slug"), str)
                and _model_has_explicit_provider(model)
            )
        ],
        sanitized_providers,
    )


def _model_has_explicit_provider(model):
    for key in ("model_provider", "modelProvider"):
        value = model.get(key)
        if isinstance(value, str) and value.strip():
            return True
    return False


def _custom_model_catalog_payload():
    providers = {}
    models = []
    seen_slugs = set()
    for path in _custom_model_catalog_paths():
        catalog_models, catalog_providers = _read_custom_model_catalog(path)
        for provider_id, provider in catalog_providers.items():
            providers.setdefault(provider_id, provider)
        for model in catalog_models:
            slug = model.get("slug")
            if slug in seen_slugs:
                continue
            models.append(model)
            seen_slugs.add(slug)
    for url in _custom_model_catalog_urls():
        catalog_models, catalog_providers = _read_custom_model_catalog_url(url)
        for provider_id, provider in catalog_providers.items():
            providers.setdefault(provider_id, provider)
        for model in catalog_models:
            slug = model.get("slug")
            if slug in seen_slugs:
                continue
            models.append(model)
            seen_slugs.add(slug)
    if not models:
        return None
    payload = {"version": 1, "models": models}
    if providers:
        payload["providers"] = providers
    return json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"


class CodexWebviewHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        route = urllib.parse.urlsplit(self.path).path
        if route == CUSTOM_MODEL_CATALOG_ROUTE:
            return self.send_custom_model_catalog_head()
        return super().send_head()

    def send_custom_model_catalog_head(self):
        payload = _custom_model_catalog_payload()
        if payload is None:
            self.send_error(404, "Custom model catalog not found")
            return None
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        return io.BytesIO(payload)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


handler = functools.partial(CodexWebviewHandler, directory=".")
with http.server.ThreadingHTTPServer((bind, port), handler) as httpd:
    httpd.serve_forever()
