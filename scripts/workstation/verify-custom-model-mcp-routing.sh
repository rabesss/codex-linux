#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dev_app_dir="${1:-$repo_dir/codex-desktop-control-dev-app}"

if [[ ! -d "$dev_app_dir" ]]; then
  echo "verify-custom-model-mcp-routing: dev app not found at $dev_app_dir" >&2
  exit 1
fi

assets_dir="$dev_app_dir/content/webview/assets"
if [[ ! -d "$assets_dir" ]]; then
  assets_dir="$dev_app_dir/resources/app.asar.unpacked/webview/assets"
fi
signals_bundle="$(find "$assets_dir" -maxdepth 1 \( -name 'app-server-manager-signals-*.js' -o -name 'thread-context-inputs-*.js' \) -print -quit)"
model_query_bundle="$(rg -l 'codexLinuxCustomModelMergeListModels' "$assets_dir" --glob '*.js' | sed -n '1p' || true)"

tmp_asar_dir=""
cleanup() {
  [[ -z "$tmp_asar_dir" ]] || rm -rf "$tmp_asar_dir"
}
trap cleanup EXIT

if [[ -z "${signals_bundle:-}" || -z "${model_query_bundle:-}" ]] && [[ -f "$dev_app_dir/resources/app.asar" ]]; then
  tmp_asar_dir="$(mktemp -d)"
  npx --yes asar extract "$dev_app_dir/resources/app.asar" "$tmp_asar_dir"
  assets_dir="$tmp_asar_dir/webview/assets"
  signals_bundle="$(find "$assets_dir" -maxdepth 1 \( -name 'app-server-manager-signals-*.js' -o -name 'thread-context-inputs-*.js' \) -print -quit)"
  model_query_bundle="$(rg -l 'codexLinuxCustomModelMergeListModels' "$assets_dir" --glob '*.js' | sed -n '1p' || true)"
fi

if [[ -z "${signals_bundle:-}" ]]; then
  echo "verify-custom-model-mcp-routing: app-server manager or thread context bundle missing" >&2
  exit 1
fi
if [[ -z "${model_query_bundle:-}" ]]; then
  echo "verify-custom-model-mcp-routing: custom model query bundle missing" >&2
  exit 1
fi

echo "Checking $signals_bundle"
echo "Checking $model_query_bundle"

check_bundle_contains() {
  local bundle="$1"
  local pattern="$2"
  local label="$3"
  if ! rg -q "$pattern" "$bundle"; then
    echo "verify-custom-model-mcp-routing: missing $label in $bundle" >&2
    exit 1
  fi
}

check_bundle_absent() {
  local bundle="$1"
  local pattern="$2"
  local label="$3"
  if rg -q "$pattern" "$bundle"; then
    echo "verify-custom-model-mcp-routing: unexpected $label in $bundle" >&2
    exit 1
  fi
}

rg -q 'function codexLinuxCustomModelApplyRouting' "$signals_bundle"
rg -q 'codexLinuxCustomModelApplyRouting\(c,e\)' "$signals_bundle"
rg -q 'model_catalog_json' "$signals_bundle"
check_bundle_contains "$signals_bundle" 'function codexLinuxCustomModelProviderForSlug' "provider lookup helper"
check_bundle_contains "$signals_bundle" 'function codexLinuxCustomModelRouteModel' "turn-start route model selector"
check_bundle_contains "$signals_bundle" 'if\(r==null\)return e' "fail-closed missing-provider route"
check_bundle_absent "$signals_bundle" '\?\?`codex_shim`' "implicit codex_shim fallback"
check_bundle_absent "$signals_bundle" 'codexLinuxCustomModelApplyRouting\(\{threadId:.*\},[A-Za-z_$][A-Za-z0-9_$]*\?\?[A-Za-z_$][A-Za-z0-9_$]*\?\.settings\?\.model\)' "unsafe turn-start collaboration-mode fallback"
check_bundle_absent "$signals_bundle" 'globalThis\.__codexLinuxCustomModelSlugs.*\^\(cursor-' "legacy prefix-based custom slug registration"
rg -q 'updateThreadSettingsForNextTurn\([^)]*\)\{[A-Za-z_$][A-Za-z0-9_$]*=codexLinuxCustomModelApplyThreadSettings' "$signals_bundle"
rg -q 'codexLinuxCustomModelNeedsProviderResume\(this\.getConversation' "$signals_bundle"
rg -q 'sendRequest\(`thread/unsubscribe`.*resumeConversationForUnavailableOwner' "$signals_bundle"
rg -q '[A-Za-z_$][A-Za-z0-9_$]*=codexLinuxCustomModelApplyRouting\(\{threadId:.*\},codexLinuxCustomModelRouteModel\([A-Za-z_$][A-Za-z0-9_$]*,[A-Za-z_$][A-Za-z0-9_$]*\?\.settings\?\.model\)\),[A-Za-z_$][A-Za-z0-9_$]*=\{threadId:' "$signals_bundle"
rg -q 'codexLinuxCustomModelApplyRouting\(\{config:await .*buildThreadCodexConfig' "$signals_bundle"
rg -q 'sendRequest\(`thread/fork`.*modelProvider:' "$signals_bundle"
rg -q 'globalThis\.__codexLinuxCustomModelSlugs=new Set' "$model_query_bundle"
check_bundle_contains "$model_query_bundle" 'globalThis\.__codexLinuxCustomModelProviders=new Map' "custom slug provider map"
check_bundle_contains "$model_query_bundle" 'globalThis\.__codexLinuxCustomModelProviderConfigs=new Map' "custom provider config map"
check_bundle_contains "$model_query_bundle" 'function codexLinuxCustomModelProviderConfigs' "catalog provider config parser"
check_bundle_contains "$model_query_bundle" 'env_http_headers' "safe env header provider config propagation"
check_bundle_contains "$model_query_bundle" 'http_headers' "safe static header provider config propagation"
check_bundle_contains "$model_query_bundle" 'requires_openai_auth' "requires_openai_auth provider config propagation"
check_bundle_contains "$model_query_bundle" 'function codexLinuxCustomModelSafeStaticHeader' "static credential header filter"
check_bundle_absent "$model_query_bundle" 'globalThis\.__codexLinuxCustomModelSlugs.*\^\(cursor-' "legacy prefix-based custom slug registration"
rg -q 'providerDisplayName.*displayName.*s\.has' "$model_query_bundle"

if rg -q 'skipDynamicTools:!codexLinuxCustomModelCustomSlug' "$signals_bundle"; then
  echo "resume dynamic-tools patch: applied"
else
  echo "resume dynamic-tools patch: not present (optional upstream drift)"
fi

node "$repo_dir/linux-features/custom-model-catalog/test.js"
echo "verify-custom-model-mcp-routing: ok"
