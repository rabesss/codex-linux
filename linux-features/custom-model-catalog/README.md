# Custom Model Catalog

Disabled-by-default Linux feature for custom model catalog integration.

This feature owns Desktop bundle patch points that make custom model catalog
rows visible, merge local adapter rows into the model query, route selected
custom slugs through their declared provider config, and keep
local thread listing from being scoped to one upstream provider filter.
It also preserves custom model/provider state on thread start, fork, and resume
and forwards refreshed dynamic tools to resumed threads. When an existing
thread crosses the official/custom provider boundary after a model switch, the
patch forces a provider resume so the next turn is owned by the provider that
matches the newly selected row.
Persisted custom conversations still need their selected non-default
`[model_providers.<id>]` definition after a restart, either in user config or
via equivalent launcher `-c` provider overrides. Keep the top-level default
provider on `openai` for official traffic. The feature is intentionally small:
model metadata, route labels, provider ids, and capabilities still come from a
custom catalog source.

The companion adapter is maintained at
[`rabesss/codex-shim`](https://github.com/rabesss/codex-shim). It is optional:
CLIProxyAPI-backed custom routes pass through that adapter while direct and
local catalog rows can use their own Codex provider definitions. Official
OpenAI/Codex routing remains first-party and direct.
Use a current shim build when validating Browser/MCP tools: the Desktop side
preserves dynamic tools, while the shim preserves native tool item types and
restores flat or nested MCP namespace metadata on returned calls.
Context-window and compaction metadata also come from the custom catalog. If the
composer footer shows a stale or too-small context window for a custom row,
regenerate the catalog source and restart Desktop.
Current Codex treats `model_catalog_json` as a startup-only config key, so the
feature also stages a `codex-cli-wrapper` resource. The launcher activates that
wrapper only for the Desktop-launched Codex process. For `codex app-server`, the
wrapper builds a merged catalog from Codex's cached official models and custom
catalog rows from `CODEX_CUSTOM_MODEL_CATALOG_JSON`, `$CODEX_HOME/custom-models.json`,
`$XDG_CONFIG_HOME/codex-desktop/custom-models.json`, and the optional shim
compatibility catalog. It then starts app-server with
`-c model_catalog_json=<merged>`. If no official cache or no custom rows are
available, the wrapper passes through without injecting a static catalog. That
keeps official OpenAI/Codex traffic on the direct `openai` provider while
giving custom slugs native Codex model metadata for context-window,
auto-compaction, and truncation behavior when both inputs are available.
The wrapper also fills app-server compatibility defaults for compact custom
rows, including reasoning levels, shell type, visibility, supported plans, and
base instructions. Explicit catalog values win; missing legacy custom rows
default to `codex_shim`, while official cache rows default to `openai`.

Selector grouping is driven by catalog metadata, not by the global Codex
provider setting. A clean install without this feature shows only official
rows. With this feature enabled, the Desktop webview reads catalog rows, groups
them by `provider_display_name`, and expects the catalog source to de-duplicate
visible `(provider_display_name, display_name)` pairs while preserving
route-stable slugs for saved threads and overrides.
The webview reads the same configured, user, and optional shim catalog paths
through the app's own loopback server at
`/codex-linux/custom-model-catalog.json`; `http://127.0.0.1:8765/api/models` is
still queried as an optional live shim compatibility source.

Required patch points:

- `models-and-reasoning-efforts-*.js`: remove the provider allowlist gate so
  custom rows are visible and group model options by provider metadata.
- `model-queries-*.js`: merge rows from a shared custom catalog, register
  provider metadata from app-server-supplied rows, and keep
  `http://127.0.0.1:8765/api/models` as an optional shim compatibility source.
- `app-server-manager-signals-*.js`: apply each custom row's provider only for
  custom route slugs at start, fork, and resume; preserve provider/session config during
  `thread/fork`; refresh dynamic tools on resume; force provider resume after
  official/custom model switches; and clear local history provider filtering.
- `composer-*.js`: enrich model option tooltips with provider/capability
  details.
- Launcher/runtime resource: wrap only the Desktop app-server Codex invocation
  with a generated merged model catalog. Normal shell `codex` usage and global
  `~/.codex/config.toml` stay untouched.

Run the feature tests with:

```bash
node --test linux-features/custom-model-catalog/test.js
```

Run the workstation policy after changing this feature:

```bash
scripts/workstation/verify-policy.sh
```

Integration details and the `/goal` fork regression are documented in
[Custom models](../../docs/custom-models.md).
