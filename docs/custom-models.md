# Custom Models

Custom-model support is an opt-in Desktop integration built around a shared
provider/model catalog. This repository owns Desktop UI and thread lifecycle
behavior. Catalog sources can be direct providers, local OpenAI-compatible
servers, or the optional
[`codex-shim`](https://github.com/rabesss/codex-shim) adapter for CLIProxyAPI
and local-adapter routing.

Official OpenAI/Codex rows must remain on `model_provider = "openai"` and must
not pass through local proxies or adapters.

## Data Flow

```text
custom catalog JSON or codex-shim /api/models
  -> Desktop custom-model-catalog feature
  -> per-thread model_catalog_json loads native Codex model metadata
  -> selected custom thread uses the row's model_provider
  -> configured [model_providers.<id>] endpoint
```

Each custom row carries its own `model_provider`. Desktop injects only the
provider config for the selected row. A direct provider row can use a normal
Codex `[model_providers.<id>]` entry, while a CLIProxyAPI row continues to use
the optional `codex_shim` provider.

OpenAI Codex has a separate `--oss` path for local Ollama and LM Studio
providers. That mode remains useful for direct local-provider testing and can
coexist with catalog-driven local rows. This integration keeps Desktop official
rows on `model_provider = "openai"` and routes only selected custom rows
through their declared non-default provider. See OpenAI's
[OSS mode documentation](https://developers.openai.com/codex/config-advanced#oss-mode-local-providers)
for the local Ollama/LM Studio flow.

## Choose A Path

All custom-model paths use the same Desktop catalog contract. Choose the
provider path per row; do not change the global Codex default away from
`openai`.

| Path | Use it when | Required pieces |
|---|---|---|
| Direct provider | The upstream provider already has an OpenAI-compatible Responses or Chat endpoint. | `custom-model-catalog` Desktop build, a catalog row with `model_provider`, and a matching `[model_providers.<id>]` entry using `env_key`, `env_http_headers`, or command-backed `auth`. |
| Local provider | You run a local OpenAI-compatible server such as LM Studio or Ollama and want it in the Desktop picker. | `custom-model-catalog` Desktop build, a local catalog row, and a local `[model_providers.<id>]` entry. For CLI-only local testing, Codex `--oss` remains a separate path and does not require this Desktop catalog. |
| Shim / CLIProxyAPI adapter | You need codex-shim discovery, protocol translation, tool-call repair, CLIProxyAPI routing, or shim-maintained context metadata. | Current codex-shim, a `codex_shim` provider entry, and either a shim catalog file or loopback catalog URL. |

Direct and local provider rows do not require codex-shim. Shim-backed rows
remain supported, but CLIProxyAPI is not a public prerequisite for custom
models.

## Setup

1. Install the maintained custom-model Desktop profile:

   ```bash
   make install-custom-models
   ```

   To build a native package without installing it:

   ```bash
   make package-custom-models
   ```

   The profile lives at `profiles/custom-models/features.json`. It enables the
   custom catalog and updater features without applying workstation-specific
   browser overrides.

   Advanced users can instead enable the Desktop feature manually in
   `linux-features/features.json`:

   ```json
   {
     "enabled": [
       "custom-model-catalog"
     ]
   }
   ```

2. Rebuild and install Desktop if you chose the manual feature-file path:

   ```bash
   make install-native
   ```

3. Provide a catalog that follows
   [the shared schema](custom-model-catalog.schema.json). Desktop reads
   catalog rows, in priority order, from:

   - `CODEX_CUSTOM_MODEL_CATALOG_JSON`, when set;
   - `$CODEX_HOME/custom-models.json`;
   - `$XDG_CONFIG_HOME/codex-desktop/custom-models.json`;
   - `CODEX_SHIM_MODEL_CATALOG_JSON`, when set, or the optional shim
     compatibility path at
     `$XDG_STATE_HOME/codex-shim/custom_model_catalog.json`;
   - optional loopback HTTP sources from `CODEX_CUSTOM_MODEL_CATALOG_URLS`
     and `CODEX_SHIM_MODEL_CATALOG_URL`.

   Examples live under
   [`docs/examples/custom-model-catalog`](examples/custom-model-catalog/):
   direct provider, local provider, plain shim, and CLIProxyAPI-through-shim.
   Validate a catalog before restarting Desktop:

   ```bash
   node scripts/validate-custom-model-catalog.js "$CODEX_HOME/custom-models.json"
   ```

   The validator checks the provider-aware catalog contract, duplicate visible
   rows, unsupported modalities, malformed context metadata, and plaintext
   credential-shaped fields.

4. Keep a durable, non-default provider entry for each provider used by saved
   custom threads. For direct providers, use `env_key`, `env_http_headers`, or
   command-backed `auth` rather than plaintext keys. Static `http_headers`
   should be limited to non-credential metadata headers such as provider title
   or referrer hints:

   ```toml
   model_provider = "openai"

   [model_providers.openrouter]
   name = "OpenRouter"
   base_url = "https://openrouter.ai/api/v1"
   wire_api = "responses"
   env_key = "OPENROUTER_API_KEY"
   env_http_headers = { "Authorization" = "OPENROUTER_AUTHORIZATION_HEADER" }
   http_headers = { "HTTP-Referer" = "https://example.invalid", "X-Title" = "Codex Desktop Linux" }
   ```

   For the optional shim path:

   ```toml
   model_provider = "openai"

   [model_providers.codex_shim]
   name = "Codex Shim"
   base_url = "http://127.0.0.1:8765/v1"
   wire_api = "responses"
   experimental_bearer_token = "dummy"
   request_max_retries = 3
   stream_max_retries = 3
   stream_idle_timeout_ms = 600000
   ```

   The loopback shim does not use the dummy bearer value as a provider secret.
   Actual upstream credentials remain in CLIProxyAPI or a credential manager.

5. Restart Desktop after changing Codex feature flags, catalog paths, or
   provider definitions.
   Already-running app-server sessions do not gain newly exposed Browser tools.

## Selector Behavior For Users

A clean user who installs the normal Desktop package sees the official
OpenAI/Codex model groups only. They do not need the shim, CLIProxyAPI, or a
custom provider block for that flow.

A user who wants custom models needs these pieces:

- a Desktop build with `custom-model-catalog` enabled, usually through
  `make install-custom-models`;
- a readable catalog from `CODEX_CUSTOM_MODEL_CATALOG_JSON`,
  `$CODEX_HOME/custom-models.json`,
  `$XDG_CONFIG_HOME/codex-desktop/custom-models.json`, or the optional shim
  compatibility source;
- durable non-default `[model_providers.<id>]` entries for saved custom
  threads;
- upstream route credentials held by environment variables, a credential
  manager, CLIProxyAPI, or another protected credential mechanism, not in the
  Desktop repository or catalog JSON.

The top-level `model_provider` should remain `openai`. Duplicate-looking
custom rows are not caused by a global provider setting. They mean the catalog
or Desktop build is stale enough to emit multiple visible rows for the same
`provider_display_name` plus `display_name` pair. Current builds de-duplicate
that visible provider/model pair while preserving route-stable slugs behind the
row for saved threads and per-model overrides.

## Desktop Ownership

The `custom-model-catalog` feature patches four Desktop responsibilities:

- make custom catalog rows visible in the normal model picker;
- merge a shared custom catalog into `model/list`;
- route only accepted catalog slugs through their declared provider;
- preserve model, provider, provider config, native model catalog, and dynamic
  tools across thread start, fork, and resume.

That last requirement is important for `/goal`. Goal creation can fork the
active thread. Older builds could drop `modelProvider` during that fork, causing
the child thread to stop sending requests to the shim and continue failing
after Desktop restarted. Current builds preserve the row's provider on the
child thread and refresh resume-time dynamic tools. They also disable the first-party
automatic title request for custom slugs, preventing official-account quota
errors from being attached to otherwise successful custom turns.

Custom-model browser support uses the same official Browser/Chrome plugin
surface and maintained Linux Computer Use backend as official OpenAI/Codex
threads. It does not depend on Agent Workspaces, a hidden workspace browser, or
the `agent-workspace-linux` runtime.

The same provider identity also matters when continuing an existing thread
after changing the selected model. Current builds detect official-to-custom and
custom-to-official provider boundary changes, discard the stale stream owner for
that thread, and ask Desktop to resume the conversation with the provider that
matches the newly selected row. Without that resume step, a thread can keep
sending turns to the provider that owned the previous model selection.

## Optional Shim Ownership

The optional shim is one catalog/provider source. It remains responsible for
CLIProxyAPI-backed rows:

- discovers CLIProxyAPI models and serves Desktop catalog metadata;
- translates `/v1/responses`, `/v1/responses/compact`, and streaming events;
- translates image and tool-result payloads for OpenAI-chat and
  Anthropic-compatible providers;
- flattens Desktop namespace tools into callable upstream function names;
- restores native Responses item `type`, `namespace`, and child `name` fields
  on returned tool calls so Codex can dispatch Browser and other namespaced
  tools;
- normalizes stale CommandCode rows to the local CLIProxyAPI route;
- avoids advertising native hosted tools such as `web_search` or
  `computer_use` as fake BYOK functions unless a real executor exists;
- enforces credential and capability availability at request time.

Use matching current Desktop and shim builds when testing Browser tools through
the shim path. Updating only one side can leave the picker working while tool
dispatch or thread forks still fail.

## Model Contract

The shared Desktop catalog is an object with `version`, optional `providers`,
and `models`; see [the JSON schema](custom-model-catalog.schema.json). A model
row uses this minimum shape:

```json
{
  "slug": "provider-model-id",
  "model": "upstream-model-id",
  "model_provider": "provider_id",
  "display_name": "Provider Model",
  "provider_display_name": "Provider"
}
```

Public model ids and route labels should be stable and must not contain user
names, machine paths, credential hints, or account identifiers. Provider blocks
should use `env_key`, `env_http_headers`, or command-backed `auth` instead of
plaintext secrets. Static `http_headers` are accepted only for non-credential
metadata headers; credential headers such as `Authorization`, cookies, API keys,
tokens, or bearer values belong in protected indirections. Capability overrides
should contain only metadata such as image/tool/reasoning support and context
limits.

Desktop-facing labels are intentionally split:

- `display_name` is the clean model label shown as the primary picker name.
- `provider_display_name` carries route provenance such as
  `CLIProxyAPI / CommandCode`.
- `slug` stays route-stable, even when it contains a legacy route prefix such
  as `cursor-`, because saved threads and per-model overrides depend on it.
  The prefix is not a routing signal; Desktop routes a slug as custom only
  after it appears in an accepted catalog source.

Do not encode transient local service names, account names, or internal relay
labels into `display_name`.

The visible catalog should contain at most one row for the same
`provider_display_name` plus `display_name` pair. If two routes intentionally
share a clean label under the same provider, keep that distinction in the
route-stable slug or provider metadata instead of showing duplicate picker
rows.

The Desktop model submenu groups rows by `provider_display_name` when more
than one provider is present. Provider grouping is therefore a UI affordance
driven by catalog metadata; it is not a reason to reintroduce
`provider / model` prefixes into `display_name`.

Some upstream dropdown code normalizes model rows before rendering and may
strip custom fields such as `provider_display_name`. To keep grouping stable in
that path, Desktop also recovers the provider group from the catalog
description shape `<display_name> via <provider_display_name>.`. Keep that
description contract when adding catalog rows or changing shim label logic.

## Context Windows And Compaction

Desktop displays the context footer from the selected custom catalog row. Codex
core needs the same metadata at app-server startup; current
Codex treats `model_catalog_json` as startup-only and ignores it as a per-thread
override. When `custom-model-catalog` is enabled, Desktop stages a
feature-local `codex-cli-wrapper` and the launcher activates it only for the
Desktop-launched Codex process. For `codex app-server`, the wrapper writes a
merged catalog from Codex's cached official models plus the custom catalog, then
starts app-server with `-c model_catalog_json=<merged>`. If either catalog is
missing, the wrapper passes through without injecting a static catalog so
official model metadata is not replaced by a custom-only list.
The renderer reads the configured custom catalog from the Desktop webview
server at `/codex-linux/custom-model-catalog.json` so provider ids and provider
configs remain available even when app-server has already supplied the visible
custom model row. The renderer does not query the shim directly. If a shim or
another local adapter should be queried live, provide its loopback catalog URL
through `CODEX_CUSTOM_MODEL_CATALOG_URLS` or `CODEX_SHIM_MODEL_CATALOG_URL`.

This is required: picker metadata alone does not change runtime context
accounting or compaction behavior. The important fields are:

- `context_window` / `max_context_window`: the model's usable context window;
- `auto_compact_token_limit`: when Desktop should compact a custom thread;
- `truncation_policy.limit`: the maximum token budget Desktop keeps after
  truncation;
- `default_reasoning_level` plus non-empty `supported_reasoning_levels`: required
  by the current Codex app-server model catalog parser;
- capability booleans such as image, reasoning, and verified tool support.

The public catalog may omit app-server compatibility defaults such as reasoning
levels, shell type, visibility, supported plans, and base instructions. The
Desktop wrapper fills conservative defaults when writing its generated merged
catalog, while preserving any explicit values supplied by the catalog source.

The optional shim preserves live CLIProxyAPI metadata when it is available and
fills known long-context fallbacks for maintained rows such as GLM 5.2 and MiniMax M3.
For those rows, current shim builds advertise a 1,000,000 token context window
and use an 82 percent default auto-compact threshold. The threshold can be
changed before regenerating the catalog:

```bash
CODEX_SHIM_AUTO_COMPACT_RATIO=0.75 codex-shim desktop write-models
```

After changing shim code, credentials, provider metadata, catalog JSON, or
compaction ratios, regenerate the Desktop catalog if using shim and restart
Desktop so the picker and composer footer reload the catalog.
The wrapper does not mutate global `~/.codex/config.toml`, and normal shell
`codex` usage is not wrapped. If Codex's official `models_cache.json` has not
been populated yet, open/run normal Codex once, then restart Desktop.

## Validation

After any Desktop update:

```bash
node --test linux-features/custom-model-catalog/test.js
scripts/workstation/verify-policy.sh
scripts/workstation/verify-custom-model-mcp-routing.sh codex-app
```

After any shim update, also run the shim tests:

```bash
python3 -m pip install -e ".[dev]"
python3 -m pytest -q
```

Then verify through Desktop:

1. Official rows still use direct `openai` routing.
2. Custom rows load from the catalog and show route/capability metadata.
3. A new custom thread completes a text turn.
4. Forking the custom thread, including through `/goal`, keeps the row's
   `model_provider`, completes the goal, and can call `update_goal` without
   stopping later custom-provider requests.
5. Continuing an existing custom thread after a custom-row model switch still
   sends the next turn through the selected row's provider.
6. Switching an existing thread between a custom row and an official row forces
   provider resume rather than reusing the old stream owner.
7. A custom model with tool support can call the native Browser integration.
8. The context footer and the session's `model_context_window` match the custom
   catalog's effective context window for maintained long-context rows. Codex
   reports the effective window after `effective_context_window_percent` is
   applied, so a 1,000,000-token catalog row normally appears as 950,000.
9. Restarting Desktop does not break the saved custom thread.

## Current Constraints

- Custom rows are unavailable when none of the configured, user, optional
  shim, or configured loopback URL catalog sources are readable.
- If custom rows show `CLIProxyAPI / Cursor ...` as the primary model label,
  update `codex-shim`, regenerate the Desktop catalog, restart the shim
  service, and restart Desktop. Current shim builds reserve that information
  for provider metadata and keep primary labels route-neutral.
- If the same custom model appears twice under the same provider, regenerate
  the active catalog and inspect it for duplicate
  `(provider_display_name, display_name)` rows. If the row comes from the shim,
  update both repositories; current shim builds collapse those duplicates
  before Desktop merges the catalog.
- If grouping is wrong, inspect the row's `provider_display_name` in the custom
  catalog; Desktop groups from that field and falls back to the generated
  `<display_name> via <provider_display_name>.` description when the renderer
  receives normalized rows.
- Saved custom threads need the durable `[model_providers.<id>]` definition
  for the selected row after restart even though new-thread routing is
  session-scoped.
- A provider must actually support tool calling; catalog metadata cannot make a
  text-only route execute tools.
- Context footer and runtime compaction behavior are only as fresh as the
  custom catalog and the merged app-server startup catalog. Regenerate the shim
  catalog if using shim after changing provider metadata or ratio environment
  variables, then restart Desktop so the feature wrapper rebuilds the merged
  catalog.
- `web_search` and `computer_use` are native hosted tools. Use an official
  row for hosted web search, or expose a real executable MCP/function fallback
  for custom models.
- Browser backend limitations are independent of model routing. See
  [Browser Control](browser-control.md#backend-constraints).
- Plugins cannot replace the internal model picker or thread start/fork/resume
  payloads. Those changes remain update-checked Desktop bundle patches.
