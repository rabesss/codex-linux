#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
profile_config="${CODEX_DESKTOP_CONTROL_FEATURES_CONFIG:-$repo_dir/profiles/workstation/features.json}"

cd "$repo_dir"

fail=0

check_absent() {
  local label="$1"
  local pattern="$2"
  shift 2
  if rg -n "$pattern" "$@" >/tmp/codex-desktop-control-policy-rg.txt; then
    echo "FAIL: $label" >&2
    cat /tmp/codex-desktop-control-policy-rg.txt >&2
    fail=1
  else
    echo "OK: $label"
  fi
}

check_absent \
  "third-party X11 Computer Use plugin surface is absent" \
  'AlekseiSeleznev|codex-computer-use-x11|x11-ewmh-computer-use' \
  . \
  --glob '!scripts/workstation/verify-policy.sh' \
  --glob '!scripts/workstation/verify-browser-control.sh' \
  --glob '!node_modules/**' \
  --glob '!target/**' \
  --glob '!codex-app/**' \
  --glob '!dist*/**' \
  --glob '!*.lock'

check_absent \
  "browser-control code does not change the system default browser" \
  'xdg-settings[[:space:]]+set[[:space:]]+default-web-browser|xdg-mime[[:space:]]+default.*(x-scheme-handler/(http|https)|text/html)' \
  docs \
  linux-features \
  packaging \
  scripts \
  --glob '!scripts/workstation/verify-policy.sh' \
  --glob '!node_modules/**' \
  --glob '!target/**' \
  --glob '!codex-app/**' \
  --glob '!dist*/**'

if [ -e linux-features/features.json ]; then
  echo "FAIL: linux-features/features.json must stay uncommitted; use profiles/workstation/features.json" >&2
  fail=1
else
  echo "OK: no broad local linux-features/features.json"
fi

echo "Enabled workstation profile features:"
CODEX_LINUX_FEATURES_CONFIG="$profile_config" node scripts/lib/linux-features.js --enabled

enabled_features="$(CODEX_LINUX_FEATURES_CONFIG="$profile_config" node scripts/lib/linux-features.js --enabled)"

if printf '%s\n' "$enabled_features" | rg -n 'agent-workspace|appshots|copilot-reasoning-effort|conversation-mode|read-aloud|read-aloud-mcp|remote-control-ui|remote-mobile-control|zed-opener|example-feature' >/tmp/codex-desktop-control-policy-features.txt; then
  echo "FAIL: policy-disabled feature enabled in profile" >&2
  cat /tmp/codex-desktop-control-policy-features.txt >&2
  fail=1
else
  echo "OK: removed optional features are not enabled"
fi

if printf '%s\n' "$enabled_features" | rg -qx 'brave-origin-browser-control'; then
  echo "OK: Brave Origin browser-control feature is enabled"
else
  echo "FAIL: Brave Origin browser-control feature must be enabled in the workstation profile" >&2
  fail=1
fi

if printf '%s\n' "$enabled_features" | rg -qx 'custom-model-catalog'; then
  echo "OK: custom model catalog feature is enabled"
else
  echo "FAIL: custom model catalog feature must be enabled in the workstation profile" >&2
  fail=1
fi

exit "$fail"
