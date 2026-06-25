#!/bin/bash
# shellcheck shell=bash

CODEX_BUNDLED_CODEX_CLI_VERSION="${CODEX_BUNDLED_CODEX_CLI_VERSION:-0.141.0}"
CODEX_BUNDLED_CODEX_CLI_PACKAGE="${CODEX_BUNDLED_CODEX_CLI_PACKAGE:-@openai/codex@$CODEX_BUNDLED_CODEX_CLI_VERSION}"
CODEX_BUNDLED_CODEX_CLI_FETCH_RETRIES="${CODEX_BUNDLED_CODEX_CLI_FETCH_RETRIES:-5}"
CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_FACTOR="${CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_FACTOR:-2}"
CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_MINTIMEOUT="${CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_MINTIMEOUT:-10000}"
CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_MAXTIMEOUT="${CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_MAXTIMEOUT:-120000}"

managed_codex_cli_package_ready() {
    local package_root="$1"
    [ -f "$package_root/node_modules/@openai/codex/bin/codex.js" ]
}

copy_managed_codex_cli_source() {
    local source_root="$1"
    local package_root="$2"

    [ -d "$source_root/node_modules/@openai/codex" ] || error "Bundled Codex CLI source is missing @openai/codex: $source_root"
    mkdir -p "$package_root"
    cp -R "$source_root/." "$package_root/"
    chmod -R u+w "$package_root"
}

write_managed_codex_cli_launcher() {
    local package_root="$1"
    local launcher_path="$2"
    local launcher_dir

    launcher_dir="$(dirname "$launcher_path")"
    mkdir -p "$launcher_dir"
    cat > "$launcher_path" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$SCRIPT_DIR/../node-runtime/bin/node"
CODEX_JS="$SCRIPT_DIR/../codex-cli/node_modules/@openai/codex/bin/codex.js"

if [ ! -x "$NODE_BIN" ]; then
    echo "Bundled Codex CLI is missing managed Node.js runtime: $NODE_BIN" >&2
    exit 127
fi
if [ ! -f "$CODEX_JS" ]; then
    echo "Bundled Codex CLI package is missing: $CODEX_JS" >&2
    exit 127
fi

exec "$NODE_BIN" "$CODEX_JS" "$@"
SCRIPT
    chmod 0755 "$launcher_path"
}

validate_managed_codex_cli() {
    local launcher_path="$1"
    local probe

    [ -x "$launcher_path" ] || return 1
    probe="$("$launcher_path" --version 2>/dev/null || true)"
    case "$probe" in
        codex-cli\ *|codex\ *)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

ensure_managed_codex_cli() {
    local package_root="$1"
    local launcher_path="$2"
    local npm_bin

    if validate_managed_codex_cli "$launcher_path"; then
        info "Managed Codex CLI ready: $launcher_path"
        return 0
    fi

    [ -n "${CODEX_MANAGED_NODE_RUNTIME_DIR:-}" ] || error "Managed Node.js runtime must be prepared before staging Codex CLI"
    mkdir -p "$package_root"
    if ! managed_codex_cli_package_ready "$package_root"; then
        if [ -n "${CODEX_BUNDLED_CODEX_CLI_SOURCE:-}" ]; then
            info "Copying bundled Codex CLI package source: $CODEX_BUNDLED_CODEX_CLI_SOURCE"
            copy_managed_codex_cli_source "$CODEX_BUNDLED_CODEX_CLI_SOURCE" "$package_root"
        else
            npm_bin="$CODEX_MANAGED_NODE_RUNTIME_DIR/bin/npm"
            [ -x "$npm_bin" ] || error "Managed Node.js runtime is missing npm: $npm_bin"

            info "Installing bundled Codex CLI package: $CODEX_BUNDLED_CODEX_CLI_PACKAGE"
            "$npm_bin" install \
                --prefix "$package_root" \
                --omit=dev \
                --no-audit \
                --no-fund \
                "--fetch-retries=$CODEX_BUNDLED_CODEX_CLI_FETCH_RETRIES" \
                "--fetch-retry-factor=$CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_FACTOR" \
                "--fetch-retry-mintimeout=$CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_MINTIMEOUT" \
                "--fetch-retry-maxtimeout=$CODEX_BUNDLED_CODEX_CLI_FETCH_RETRY_MAXTIMEOUT" \
                "$CODEX_BUNDLED_CODEX_CLI_PACKAGE"
        fi
    fi

    write_managed_codex_cli_launcher "$package_root" "$launcher_path"
    validate_managed_codex_cli "$launcher_path" || error "Bundled Codex CLI failed validation: $launcher_path"
    info "Managed Codex CLI ready: $launcher_path"
}
