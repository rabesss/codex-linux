#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const vm = require("node:vm");
const {
  applyExtractedAppPatchDescriptors,
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  MODEL_QUERY_SHIM_HELPER_SOURCE,
  MODEL_QUERY_SHIM_PATCH,
  MODEL_TOOLTIP_HELPER_SOURCE,
  MODEL_TOOLTIP_PATCH,
  MODEL_PROVIDER_GROUP_HELPER_SOURCE,
  MODEL_PROVIDER_GROUP_PATCH,
  ROUTING_HELPER_SOURCE,
  ROUTING_PATCH,
  ROUTING_PATCH_VARIANTS,
  FORK_ROUTING_MARKER,
  RESUME_SKIP_DYNAMIC_TOOLS_REPLACEMENT,
  RESUME_DYNAMIC_TOOLS_PAYLOAD_PATCH,
  applyCustomModelForkRoutingPatch,
  applyCustomModelThreadSettingsRoutingPatch,
  applyCustomModelTurnStartRoutingPatch,
  applyCustomModelResumeDynamicToolsPatch,
  applyCustomModelResumeDynamicToolsPayloadPatch,
  applyCustomModelAttachmentMenuPatch,
  applyCustomModelComposerAttachmentPropPatch,
  applyCustomModelListMergePatch,
  applyCustomModelPickerVisibilityPatch,
  applyCustomModelProviderGroupPatch,
  applyCustomModelRecentThreadsPatch,
  applyCustomModelRoutingPatch,
  applyCustomModelTooltipPatch,
  descriptors,
} = require("./patch.js");

const execFile = promisify(childProcess.execFile);

function applyPatchTwice(patchFn, source) {
  const patched = patchFn(source);
  assert.notEqual(patched, source);
  assert.equal(patchFn(patched), patched);
  return patched;
}

function withTempFeatureConfig(enabled, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
    return fn(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withExtractedApp(files, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-assets-"));
  const assetsDir = path.join(tempDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(assetsDir, name), source);
  }
  try {
    return fn(tempDir, assetsDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeExecutable(filePath, body) {
  fs.writeFileSync(filePath, body);
  fs.chmodSync(filePath, 0o755);
}

async function reserveTcpPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForHttpJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}

async function startCatalogServer(catalog) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/api/models") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(catalog));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return {
    url: `http://127.0.0.1:${address.port}/api/models`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function extractWrapperCatalogPython() {
  const wrapper = fs.readFileSync(path.join(__dirname, "codex-cli-wrapper"), "utf8");
  const startNeedle = 'python3 - "$official_cache" "$output_path" "${custom_catalog_sources[@]}" <<\'PY\'\n';
  const endNeedle = "\nPY\n}";
  const start = wrapper.indexOf(startNeedle);
  assert.notEqual(start, -1);
  const end = wrapper.indexOf(endNeedle, start);
  assert.notEqual(end, -1);
  return wrapper.slice(start + startNeedle.length, end);
}

function pythonLoopbackCatalogResults({ source, stopNeedle, functionName, argv = [] }) {
  const stop = source.indexOf(stopNeedle);
  assert.notEqual(stop, -1);
  const urls = [
    "http://127.0.0.1:8765/api/models",
    "http://localhost:8765/api/models",
    "http://[::1]:8765/api/models",
    "http://127.0.0.1/api/models",
    "http://127.0.0.1:8765",
    "https://127.0.0.1:8765/api/models",
    "http://192.168.1.10:8765/api/models",
    "http://127.0.0.1:999999/api/models",
  ];
  const prefix = source.slice(0, stop);
  const script = [
    prefix,
    "import json as __json",
    `__urls = ${JSON.stringify(urls)}`,
    `print(__json.dumps({url: ${functionName}(url) for url in __urls}, sort_keys=True))`,
  ].join("\n");
  const result = childProcess.spawnSync("python3", ["-c", script, ...argv], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("catalog URL source helpers require loopback HTTP URLs with explicit ports", () => {
  const expected = {
    "http://127.0.0.1:8765/api/models": true,
    "http://localhost:8765/api/models": true,
    "http://[::1]:8765/api/models": true,
    "http://127.0.0.1/api/models": false,
    "http://127.0.0.1:8765": false,
    "https://127.0.0.1:8765/api/models": false,
    "http://192.168.1.10:8765/api/models": false,
    "http://127.0.0.1:999999/api/models": false,
  };
  const wrapperSource = extractWrapperCatalogPython();
  assert.deepEqual(
    pythonLoopbackCatalogResults({
      source: wrapperSource,
      stopNeedle: "def load_catalog(path):",
      functionName: "loopback_catalog_url",
      argv: ["official-cache.json", "merged-catalog.json"],
    }),
    expected,
  );
  const webviewSource = fs.readFileSync(path.join(__dirname, "..", "..", "launcher", "webview-server.py"), "utf8");
  assert.deepEqual(
    pythonLoopbackCatalogResults({
      source: webviewSource,
      stopNeedle: "def _custom_model_catalog_paths():",
      functionName: "_loopback_catalog_url",
      argv: ["0"],
    }),
    expected,
  );
});

function attachmentMenuBundleFixture() {
  return [
    "var ht=e(z(),1),gt=(0,Z.memo)(function(e){let t=(0,$.c)(98),{onAddImageDataUrls:n,onAddAppshotContext:r,onAppshotCaptureAnimationDuration:i,onAppshotCaptureSettled:a,onAppshotCaptureStarted:o,getAppshotCaptureAnimationDestinationFrame:s,getAttachmentGen:c,setFileAttachments:l,onAddLocalFileAttachments:u,conversationId:d,executionTargetCwd:h,executionTargetHostId:g,isAutoContextOn:_,setIsAutoContextOn:v,ideContextStatus:b,hasGoal:x,isGoalActionAvailable:S,onClearGoal:C,onOpenGoalEditor:w,supportsFileAttachments:T,supportsRemoteFileAttachments:E,disabled:O}=e,k=T===void 0?!0:T,A=E===void 0?!1:E,j=O===void 0?!1:O,M=f(y),N=ee();",
    "if(t[16]!==ge||t[17]!==j||t[18]!==g||t[19]!==c||t[20]!==N||t[21]!==n||t[22]!==u||t[23]!==L||t[24]!==M||t[25]!==H||t[26]!==l||t[27]!==G||t[28]!==k){Ce=async function(){",
    "let{images:i,others:a}=bt(t),o=[];",
    "let Fe;t[59]!==d||t[60]!==j||t[61]!==g||t[62]!==s||t[63]!==c||t[64]!==Ce||t[65]!==le||t[66]!==x||t[67]!==b||t[68]!==_||t[69]!==S||t[70]!==r||t[71]!==i||t[72]!==a||t[73]!==o||t[74]!==C||t[75]!==v||t[76]!==U||t[77]!==q||t[78]!==G||t[79]!==k?(Fe=(0,Q.jsx)(_t,{conversationId:d,disabled:j,getAttachmentGen:c,handleAddFiles:Ce,handleSelectAndClose:le,hasGoal:x,hostId:g,ideContextStatus:b,isAutoContextOn:_,isGoalActionAvailable:S,onAddAppshotContext:r,onClearGoal:C,onOpenRemoteFilePicker:Pe,getAppshotCaptureAnimationDestinationFrame:s,onAppshotCaptureAnimationDuration:i,onAppshotCaptureSettled:a,onAppshotCaptureStarted:o,setIsAutoContextOn:v,setIsDropdownOpen:U,shouldShowAppshotCapture:q,shouldOpenGoalEditorOnCloseRef:R,shouldShowRemoteFileAttachments:G,supportsFileAttachments:k,togglingSwitchRef:te}),t[59]=d,t[60]=j,t[61]=g,t[62]=s,t[63]=c,t[64]=Ce,t[65]=le,t[66]=x,t[67]=b,t[68]=_,t[69]=S,t[70]=r,t[71]=i,t[72]=a,t[73]=o,t[74]=C,t[75]=v,t[76]=U,t[77]=q,t[78]=G,t[79]=k,t[80]=Fe):Fe=t[80];",
    "function _t(e){let t=(0,$.c)(102),{conversationId:n,disabled:r,getAttachmentGen:i,handleAddFiles:a,handleSelectAndClose:o,hasGoal:s,hostId:c,ideContextStatus:l,isAutoContextOn:u,isGoalActionAvailable:d,onAddAppshotContext:f,onClearGoal:p,onOpenRemoteFilePicker:m,getAppshotCaptureAnimationDestinationFrame:h,onAppshotCaptureAnimationDuration:g,onAppshotCaptureSettled:_,onAppshotCaptureStarted:v,setIsAutoContextOn:y,setIsDropdownOpen:b,shouldShowAppshotCapture:x,shouldOpenGoalEditorOnCloseRef:S,shouldShowRemoteFileAttachments:C,supportsFileAttachments:w,togglingSwitchRef:T}=e,E=ee(),{activeMode:O}=te(n);",
    "let ce=se,le=w?dt:ue,W;",
    "let G;t[28]===w?G=t[29]:(G=w?(0,Q.jsx)(D,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(D,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`}),t[28]=w,t[29]=G);",
    "let q;t[34]!==r||t[35]!==h||t[36]!==i||t[37]!==o||t[38]!==c||t[39]!==f||t[40]!==g||t[41]!==_||t[42]!==v||t[43]!==x?(q=x&&h!=null?(0,Q.jsx)(ae,{electron:!0,children:(0,Q.jsx)(nt,",
  ].join("");
}

function modelDropdownBundleFixture() {
  return [
    "function E(e){let t=(0,w.c)(76),{align:r,disabled:a,model:s,models:c,onSelectComplete:h,onSelectModel:_,reasoningEffort:E,selectedServiceTier:k,selectedServiceTierIconKind:A}=e,Y;",
    "Y=c?.map(e=>(0,T.jsx)(ee,{modelOption:e,selectedModel:s,selectedReasoningEffort:E,selectedServiceTier:k,selectedServiceTierIconKind:A,onSelect:(e,t)=>{_(e,t),h?.()}},e.model)),",
    "t[48]=Y;return Y}",
  ].join("");
}

test("model picker visibility patch removes the upstream provider allowlist gate", () => {
  const source = "before function e(){let a=[],o=null,s=i&&e!==`amazonBedrock`;return s} after";
  const patched = applyPatchTwice(applyCustomModelPickerVisibilityPatch, source);

  assert.match(patched, /let a=\[\],o=null,s=!1;/);
  assert.doesNotMatch(patched, /i&&e!==`amazonBedrock`/);
});

test("model picker visibility patch supports the alternate model query chunk shape", () => {
  const source = "before let u=c.useHiddenModels&&o!==`amazonBedrock`,d; after";
  const patched = applyPatchTwice(applyCustomModelPickerVisibilityPatch, source);

  assert.match(patched, /let u=!1,d;/);
  assert.doesNotMatch(patched, /useHiddenModels&&o!==`amazonBedrock`/);
});

test("model picker visibility patch fails loudly when the upstream needle drifts", () => {
  assert.throws(
    () => applyCustomModelPickerVisibilityPatch("function changed(){return true}"),
    /model allowlist filter needle not found/,
  );
});

test("model picker visibility descriptor targets the Electron 42 filter chunk", () => {
  const descriptor = descriptors.find(({ id }) => id === "model-picker-visibility");
  assert.ok(descriptor);
  assert.match("model-list-filter-BOpqDcyc.js", descriptor.pattern);
  assert.equal(
    descriptor.apply(
      "function e(){let a=[],o=null,s=i&&e!==`amazonBedrock`;return s}",
    ),
    "function e(){let a=[],o=null,s=!1;return s}",
  );
});

test("feature CLI wrapper injects a merged model catalog only for app-server", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-wrapper-"));
  try {
    const realCodex = path.join(tempDir, "real-codex");
    const officialCache = path.join(tempDir, "models_cache.json");
    const customCatalog = path.join(tempDir, "custom_model_catalog.json");
    const codexHome = path.join(tempDir, "codex-home");
    const configHome = path.join(tempDir, "config-home");
    const stateHome = path.join(tempDir, "state-home");
    const appStateDir = path.join(tempDir, "state", "codex-desktop");
    const wrapper = path.join(__dirname, "codex-cli-wrapper");

    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(configHome, { recursive: true });
    fs.mkdirSync(stateHome, { recursive: true });
    writeExecutable(
      realCodex,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' \"$@\"",
      ].join("\n"),
    );
    fs.writeFileSync(
      officialCache,
      JSON.stringify({
        providers: {
          codex_shim: {
            name: "Codex Shim",
            base_url: "http://127.0.0.1:8765/v1",
            wire_api: "responses",
          },
        },
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
            context_window: 272000,
            max_context_window: 272000,
          },
        ],
      }),
    );
    fs.writeFileSync(
      customCatalog,
      JSON.stringify({
        providers: {
          openrouter: {
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            wire_api: "responses",
            env_key: "OPENROUTER_API_KEY",
            env_http_headers: {
              Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
            },
            http_headers: {
              "HTTP-Referer": "https://example.invalid",
              "X-Title": "Codex Desktop Linux",
              Authorization: "Bearer not-a-secret-but-unsafe-static-header",
            },
            auth: {
              command: "printenv OPENROUTER_API_KEY",
            },
            requires_openai_auth: false,
          },
          codex_shim: {
            name: "Codex Shim",
            base_url: "http://127.0.0.1:8765/v1",
            wire_api: "responses",
          },
        },
        models: [
          {
            slug: "gpt-5.5",
            display_name: "Captured GPT-5.5",
            visibility: "list",
            context_window: 1,
            max_context_window: 1,
          },
          {
            slug: "openrouter-qwen3-coder",
            model: "qwen/qwen3-coder",
            model_provider: "openrouter",
            display_name: "Qwen3 Coder",
            provider_display_name: "OpenRouter",
            visibility: "list",
            context_window: 262144,
            max_context_window: 262144,
            auto_compact_token_limit: 210000,
          },
          {
            slug: "shim-auto",
            model: "codex-auto",
            model_provider: "codex_shim",
            display_name: "Auto Router",
            provider_display_name: "Codex Shim Router",
            visibility: "list",
            context_window: 1000000,
            max_context_window: 1000000,
            auto_compact_token_limit: 165000,
          },
          {
            slug: "missing-provider-auto",
            model: "missing-provider-auto",
            display_name: "Missing Provider Auto",
            visibility: "list",
            context_window: 128000,
          },
        ],
      }),
    );

    const env = {
      ...process.env,
      CODEX_LINUX_FEATURE_WRAPPED_CODEX_CLI: realCodex,
      CODEX_CUSTOM_MODEL_OFFICIAL_CACHE_JSON: officialCache,
      CODEX_CUSTOM_MODEL_CATALOG_JSON: customCatalog,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      CODEX_LINUX_APP_STATE_DIR: appStateDir,
    };
    delete env.CODEX_SHIM_MODEL_CATALOG_JSON;
    const output = childProcess.execFileSync("bash", [wrapper, "app-server", "--socket", "x"], {
      encoding: "utf8",
      env,
    });
    const args = output.trim().split("\n");
    assert.equal(args[0], "-c");
    assert.match(args[1], /^model_catalog_json="/);
    assert.deepEqual(args.slice(2), ["app-server", "--socket", "x"]);

    const catalogPath = JSON.parse(args[1].slice("model_catalog_json=".length));
    const merged = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.deepEqual(
      merged.models.map((model) => model.slug).sort(),
      ["gpt-5.5", "openrouter-qwen3-coder", "shim-auto"],
    );
    assert.equal(merged.models.find((model) => model.slug === "gpt-5.5").display_name, "GPT-5.5");
    assert.equal(merged.models.find((model) => model.slug === "gpt-5.5").context_window, 272000);
    const directCustom = merged.models.find((model) => model.slug === "openrouter-qwen3-coder");
    assert.equal(directCustom.model_provider, "openrouter");
    assert.equal(directCustom.model, "qwen/qwen3-coder");
    assert.equal(directCustom.default_reasoning_level, "medium");
    assert.equal(directCustom.supported_reasoning_levels[1].effort, "medium");
    assert.equal(directCustom.shell_type, "shell_command");
    assert.equal(directCustom.supported_in_api, true);
    assert.equal(directCustom.base_instructions.includes("custom model provider"), true);
    const shimCustom = merged.models.find((model) => model.slug === "shim-auto");
    assert.equal(shimCustom.model_provider, "codex_shim");
    assert.equal(shimCustom.model, "codex-auto");
    assert.equal(merged.models.find((model) => model.slug === "missing-provider-auto"), undefined);
    assert.equal(merged.providers.codex_shim.base_url, "http://127.0.0.1:8765/v1");
    assert.equal(merged.providers.openrouter.base_url, "https://openrouter.ai/api/v1");
    assert.equal(merged.providers.openrouter.env_key, "OPENROUTER_API_KEY");
    assert.deepEqual(merged.providers.openrouter.env_http_headers, {
      Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
    });
    assert.deepEqual(merged.providers.openrouter.http_headers, {
      "HTTP-Referer": "https://example.invalid",
      "X-Title": "Codex Desktop Linux",
    });
    assert.deepEqual(merged.providers.openrouter.auth, {
      command: "printenv OPENROUTER_API_KEY",
    });
    assert.equal(merged.providers.openrouter.requires_openai_auth, false);

    const versionOutput = childProcess.execFileSync("bash", [wrapper, "--version"], {
      encoding: "utf8",
      env,
    });
    assert.deepEqual(versionOutput.trim().split("\n"), ["--version"]);

    const passthroughOutput = childProcess.execFileSync("bash", [wrapper, "app-server"], {
      encoding: "utf8",
      env: {
        ...env,
        CODEX_CUSTOM_MODEL_OFFICIAL_CACHE_JSON: path.join(tempDir, "missing-models-cache.json"),
      },
    });
    assert.deepEqual(passthroughOutput.trim().split("\n"), ["app-server"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("feature CLI wrapper merges default user and shim catalog sources", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-default-sources-"));
  try {
    const realCodex = path.join(tempDir, "real-codex");
    const codexHome = path.join(tempDir, "codex-home");
    const configHome = path.join(tempDir, "config-home");
    const stateHome = path.join(tempDir, "state-home");
    const appStateDir = path.join(tempDir, "app-state");
    const xdgCatalogDir = path.join(configHome, "codex-desktop");
    const shimCatalogDir = path.join(stateHome, "codex-shim");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(xdgCatalogDir, { recursive: true });
    fs.mkdirSync(shimCatalogDir, { recursive: true });
    writeExecutable(realCodex, ["#!/usr/bin/env bash", "set -euo pipefail", "printf '%s\\n' \"$@\""].join("\n"));
    fs.writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272000 }],
      }),
    );
    fs.writeFileSync(
      path.join(codexHome, "custom-models.json"),
      JSON.stringify({
        providers: { openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1" } },
        models: [
          { slug: "openrouter-qwen3-coder", model_provider: "openrouter", display_name: "Qwen3 Coder" },
          { slug: "missing-provider-user", display_name: "Missing Provider User" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(xdgCatalogDir, "custom-models.json"),
      JSON.stringify({
        providers: { local_lab: { name: "Local Lab", base_url: "http://127.0.0.1:11434/v1" } },
        models: [{ slug: "local-qwen", model_provider: "local_lab", display_name: "Local Qwen" }],
      }),
    );
    fs.writeFileSync(
      path.join(shimCatalogDir, "custom_model_catalog.json"),
      JSON.stringify({
        providers: { codex_shim: { name: "Codex Shim", base_url: "http://127.0.0.1:8765/v1" } },
        models: [{ slug: "shim-auto", model_provider: "codex_shim", display_name: "Auto Router" }],
      }),
    );

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      CODEX_LINUX_APP_STATE_DIR: appStateDir,
      CODEX_LINUX_FEATURE_WRAPPED_CODEX_CLI: realCodex,
    };
    delete env.CODEX_CUSTOM_MODEL_CATALOG_JSON;
    delete env.CODEX_SHIM_MODEL_CATALOG_JSON;
    delete env.CODEX_CUSTOM_MODEL_OFFICIAL_CACHE_JSON;
    const { stdout: output } = await execFile("bash", [path.join(__dirname, "codex-cli-wrapper"), "app-server"], {
      encoding: "utf8",
      env,
    });
    const args = output.trim().split("\n");
    const catalogPath = JSON.parse(args[1].slice("model_catalog_json=".length));
    const merged = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.deepEqual(
      merged.models.map((model) => `${model.slug}:${model.model_provider}`).sort(),
      [
        "gpt-5.5:openai",
        "local-qwen:local_lab",
        "openrouter-qwen3-coder:openrouter",
        "shim-auto:codex_shim",
      ],
    );
    assert.equal(merged.providers.openrouter.name, "OpenRouter");
    assert.equal(merged.providers.local_lab.name, "Local Lab");
    assert.equal(merged.providers.codex_shim.name, "Codex Shim");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("feature CLI wrapper merges configured loopback catalog URL sources", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-url-source-"));
  const catalogServer = await startCatalogServer({
    providers: { openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1" } },
    models: [{ slug: "openrouter-url-model", model_provider: "openrouter", display_name: "URL Model" }],
  });
  try {
    const realCodex = path.join(tempDir, "real-codex");
    const codexHome = path.join(tempDir, "codex-home");
    const configHome = path.join(tempDir, "config-home");
    const stateHome = path.join(tempDir, "state-home");
    const appStateDir = path.join(tempDir, "app-state");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(configHome, { recursive: true });
    fs.mkdirSync(stateHome, { recursive: true });
    writeExecutable(realCodex, ["#!/usr/bin/env bash", "set -euo pipefail", "printf '%s\\n' \"$@\""].join("\n"));
    fs.writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272000 }],
      }),
    );

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      CODEX_LINUX_APP_STATE_DIR: appStateDir,
      CODEX_CUSTOM_MODEL_CATALOG_URLS: `http://[::1\n${catalogServer.url}`,
      CODEX_LINUX_FEATURE_WRAPPED_CODEX_CLI: realCodex,
      HTTP_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
    };
    delete env.CODEX_CUSTOM_MODEL_CATALOG_JSON;
    delete env.CODEX_SHIM_MODEL_CATALOG_JSON;
    delete env.CODEX_SHIM_MODEL_CATALOG_URL;
    delete env.CODEX_CUSTOM_MODEL_OFFICIAL_CACHE_JSON;
    const { stdout: output } = await execFile("bash", [path.join(__dirname, "codex-cli-wrapper"), "app-server"], {
      encoding: "utf8",
      env,
    });
    const args = output.trim().split("\n");
    const catalogPath = JSON.parse(args[1].slice("model_catalog_json=".length));
    const merged = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.deepEqual(
      merged.models.map((model) => `${model.slug}:${model.model_provider}`).sort(),
      ["gpt-5.5:openai", "openrouter-url-model:openrouter"],
    );
    assert.equal(merged.providers.openrouter.name, "OpenRouter");
  } finally {
    await catalogServer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("webview catalog route merges default user and shim catalog sources", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-webview-sources-"));
  const port = await reserveTcpPort();
  let serverProcess;
  try {
    const codexHome = path.join(tempDir, "codex-home");
    const configHome = path.join(tempDir, "config-home");
    const stateHome = path.join(tempDir, "state-home");
    const xdgCatalogDir = path.join(configHome, "codex-desktop");
    const shimCatalogDir = path.join(stateHome, "codex-shim");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(xdgCatalogDir, { recursive: true });
    fs.mkdirSync(shimCatalogDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "custom-models.json"),
      JSON.stringify({
        providers: {
          openrouter: {
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            env_http_headers: {
              Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
            },
            http_headers: {
              "HTTP-Referer": "https://example.invalid",
              Authorization: "Bearer not-a-secret-but-unsafe-static-header",
            },
            auth: {
              command: "printenv OPENROUTER_API_KEY",
            },
            requires_openai_auth: false,
          },
        },
        models: [
          { slug: "openrouter-qwen3-coder", model_provider: "openrouter" },
          { slug: "missing-provider-webview" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(xdgCatalogDir, "custom-models.json"),
      JSON.stringify({
        providers: { local_lab: { name: "Local Lab" } },
        models: [{ slug: "local-qwen", model_provider: "local_lab" }],
      }),
    );
    fs.writeFileSync(
      path.join(shimCatalogDir, "custom_model_catalog.json"),
      JSON.stringify({
        providers: { codex_shim: { name: "Codex Shim" } },
        models: [{ slug: "shim-auto", model_provider: "codex_shim" }],
      }),
    );

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    };
    delete env.CODEX_CUSTOM_MODEL_CATALOG_JSON;
    delete env.CODEX_SHIM_MODEL_CATALOG_JSON;
    serverProcess = childProcess.spawn("python3", [path.join(__dirname, "..", "..", "launcher", "webview-server.py"), String(port), "--bind", "127.0.0.1"], {
      env,
      stdio: "ignore",
    });
    const catalog = await waitForHttpJson(`http://127.0.0.1:${port}/codex-linux/custom-model-catalog.json`);
    assert.deepEqual(
      catalog.models.map((model) => `${model.slug}:${model.model_provider}`).sort(),
      [
        "local-qwen:local_lab",
        "openrouter-qwen3-coder:openrouter",
        "shim-auto:codex_shim",
      ],
    );
    assert.deepEqual(Object.keys(catalog.providers).sort(), ["codex_shim", "local_lab", "openrouter"]);
    assert.deepEqual(catalog.providers.openrouter.env_http_headers, {
      Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
    });
    assert.deepEqual(catalog.providers.openrouter.http_headers, {
      "HTTP-Referer": "https://example.invalid",
    });
    assert.deepEqual(catalog.providers.openrouter.auth, {
      command: "printenv OPENROUTER_API_KEY",
    });
    assert.equal(catalog.providers.openrouter.requires_openai_auth, false);
  } finally {
    if (serverProcess) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("webview catalog route merges configured loopback catalog URL sources", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-webview-url-source-"));
  const port = await reserveTcpPort();
  const catalogServer = await startCatalogServer({
    providers: { local_lab: { name: "Local Lab", base_url: "http://127.0.0.1:11434/v1" } },
    models: [{ slug: "local-url-model", model_provider: "local_lab", display_name: "Local URL Model" }],
  });
  let serverProcess;
  try {
    const codexHome = path.join(tempDir, "codex-home");
    const configHome = path.join(tempDir, "config-home");
    const stateHome = path.join(tempDir, "state-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(configHome, { recursive: true });
    fs.mkdirSync(stateHome, { recursive: true });

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      CODEX_CUSTOM_MODEL_CATALOG_URLS: `http://[::1\n${catalogServer.url}`,
      HTTP_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
    };
    delete env.CODEX_CUSTOM_MODEL_CATALOG_JSON;
    delete env.CODEX_SHIM_MODEL_CATALOG_JSON;
    delete env.CODEX_SHIM_MODEL_CATALOG_URL;
    serverProcess = childProcess.spawn("python3", [path.join(__dirname, "..", "..", "launcher", "webview-server.py"), String(port), "--bind", "127.0.0.1"], {
      env,
      stdio: "ignore",
    });
    const catalog = await waitForHttpJson(`http://127.0.0.1:${port}/codex-linux/custom-model-catalog.json`);
    assert.deepEqual(
      catalog.models.map((model) => `${model.slug}:${model.model_provider}`),
      ["local-url-model:local_lab"],
    );
    assert.equal(catalog.providers.local_lab.name, "Local Lab");
  } finally {
    if (serverProcess) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
    }
    await catalogServer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared custom model catalog schema examples stay public-safe and provider-aware", () => {
  const schemaPath = path.join(__dirname, "..", "..", "docs", "custom-model-catalog.schema.json");
  const examplesDir = path.join(__dirname, "..", "..", "docs", "examples", "custom-model-catalog");
  const validatorPath = path.join(__dirname, "..", "..", "scripts", "validate-custom-model-catalog.js");
  const examples = [
    "direct-provider.json",
    "local-provider.json",
    "codex-shim.json",
    "cliproxyapi-shim.json",
  ];

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert.equal(schema.$id, "https://github.com/rabesss/codex-linux/schemas/custom-model-catalog.schema.json");
  assert.deepEqual(schema.required, ["version", "models"]);

  for (const example of examples) {
    const payload = JSON.parse(fs.readFileSync(path.join(examplesDir, example), "utf8"));
    assert.equal(payload.version, 1, example);
    assert.ok(Array.isArray(payload.models), example);
    assert.ok(payload.models.length > 0, example);
    const providers = payload.providers && typeof payload.providers === "object" ? payload.providers : {};
    for (const row of payload.models) {
      assert.equal(typeof row.slug, "string", example);
      assert.equal(typeof row.model, "string", example);
      assert.equal(typeof row.model_provider, "string", example);
      assert.equal(typeof row.display_name, "string", example);
      assert.equal(typeof row.provider_display_name, "string", example);
      if (row.model_provider !== "codex_shim") {
        assert.ok(providers[row.model_provider], `${example}:${row.model_provider}`);
      }
    }
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]/u, example);
    assert.doesNotMatch(serialized, /\/home\/ravish/u, example);
    assert.doesNotMatch(serialized, /api_key(_file|_credential)?/u, example);
  }

  const validRun = childProcess.spawnSync(
    process.execPath,
    [validatorPath, "--json", ...examples.map((example) => path.join(examplesDir, example))],
    { encoding: "utf8" },
  );
  assert.equal(validRun.status, 0, validRun.stderr || validRun.stdout);
  const validReport = JSON.parse(validRun.stdout);
  assert.equal(validReport.ok, true);
  assert.equal(validReport.catalogs.length, examples.length);
  assert.deepEqual(validReport.errors, []);
});

test("shared custom model catalog validator rejects unsafe or ambiguous rows", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-invalid-catalog-"));
  const validatorPath = path.join(__dirname, "..", "..", "scripts", "validate-custom-model-catalog.js");
  const catalogPath = path.join(tempDir, "invalid.json");
  try {
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        providers: {
          openrouter: {
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            wire_api: "responses",
            experimental_bearer_token: "s" + "k-not-a-real-token-but-key-shaped",
            http_headers: {
              Authorization: "Bearer not-a-secret-but-unsafe-static-header",
            },
          },
        },
        models: [
          {
            slug: "openrouter-qwen3-coder",
            model: "qwen/qwen3-coder",
            model_provider: "openrouter",
            display_name: "Qwen3 Coder",
            provider_display_name: "OpenRouter",
            context_window: 0,
            input_modalities: ["text", "audio"],
          },
          {
            slug: "openrouter-qwen3-coder",
            model: "qwen/qwen3-coder:free",
            model_provider: "openrouter",
            display_name: "Qwen3 Coder",
            provider_display_name: "OpenRouter",
          },
          {
            slug: "missing-provider",
            model: "vendor/model",
            model_provider: "external_provider",
            display_name: "Missing Provider",
            provider_display_name: "External Provider",
          },
        ],
      }),
    );
    const invalidRun = childProcess.spawnSync(process.execPath, [validatorPath, "--json", catalogPath], {
      encoding: "utf8",
    });
    assert.equal(invalidRun.status, 1);
    const invalidReport = JSON.parse(invalidRun.stdout);
    assert.equal(invalidReport.ok, false);
    assert.match(invalidReport.errors.join("\n"), /experimental_bearer_token/);
    assert.match(invalidReport.errors.join("\n"), /http_headers\.Authorization/);
    assert.match(invalidReport.errors.join("\n"), /duplicate slug/);
    assert.match(invalidReport.errors.join("\n"), /duplicate visible row/);
    assert.match(invalidReport.errors.join("\n"), /context_window/);
    assert.match(invalidReport.errors.join("\n"), /unsupported modality "audio"/);
    assert.match(invalidReport.warnings.join("\n"), /external_provider/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher discovers feature Codex CLI wrappers after preflight", () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, "..", "..", "launcher", "start.sh.template"),
    "utf8",
  );

  assert.match(launcher, /apply_feature_codex_cli_wrappers\(\)/);
  assert.ok(launcher.includes('"$CODEX_LINUX_FEATURES_DIR"/*/codex-cli-wrapper'));
  assert.match(launcher, /downstream_var=\"CODEX_LINUX_FEATURE_WRAPPED_CODEX_CLI_\$\{wrapper_env_suffix\}\"/);
});

test("launcher prefers packaged Codex CLI before user PATH wrappers", () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, "..", "..", "launcher", "start.sh.template"),
    "utf8",
  );
  const resourcesIndex = launcher.indexOf('"$SCRIPT_DIR/resources/bin/codex"');
  const pathIndex = launcher.indexOf("command -v codex");

  assert.notEqual(resourcesIndex, -1);
  assert.notEqual(pathIndex, -1);
  assert.ok(resourcesIndex < pathIndex);
});

test("feature CLI wrapper falls back to packaged Codex CLI in staged app layout", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-wrapper-packaged-"));
  try {
    const stagedWrapper = path.join(
      tempDir,
      "codex-app",
      ".codex-linux",
      "features",
      "custom-model-catalog",
      "codex-cli-wrapper",
    );
    const packagedCodex = path.join(tempDir, "codex-app", "resources", "bin", "codex");
    const badPathDir = path.join(tempDir, "bad-path");
    const badPathCodex = path.join(badPathDir, "codex");

    fs.mkdirSync(path.dirname(stagedWrapper), { recursive: true });
    fs.mkdirSync(path.dirname(packagedCodex), { recursive: true });
    fs.mkdirSync(badPathDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, "codex-cli-wrapper"), stagedWrapper);
    fs.chmodSync(stagedWrapper, 0o755);
    writeExecutable(packagedCodex, "#!/usr/bin/env bash\nprintf 'packaged:%s\\n' \"$*\"\n");
    writeExecutable(badPathCodex, "#!/usr/bin/env bash\nprintf 'bad-path:%s\\n' \"$*\"\n");

    const output = childProcess.execFileSync("bash", [stagedWrapper, "--version"], {
      encoding: "utf8",
      env: {
        HOME: path.join(tempDir, "isolated-home"),
        PATH: `${badPathDir}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: path.join(tempDir, "isolated-config"),
      },
    });

    assert.equal(output.trim(), "packaged:--version");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher composes multiple feature CLI wrappers without recursion", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-wrapper-chain-"));
  try {
    const launcher = fs.readFileSync(
      path.join(__dirname, "..", "..", "launcher", "start.sh.template"),
      "utf8",
    );
    const functionMatch = launcher.match(/apply_feature_codex_cli_wrappers\(\) \{[\s\S]*?\n\}/u);
    assert.ok(functionMatch);

    const realCodex = path.join(tempDir, "real-codex");
    const featuresDir = path.join(tempDir, "features");
    const firstWrapper = path.join(featuresDir, "first-feature", "codex-cli-wrapper");
    const secondWrapper = path.join(featuresDir, "second-feature", "codex-cli-wrapper");
    fs.mkdirSync(path.dirname(firstWrapper), { recursive: true });
    fs.mkdirSync(path.dirname(secondWrapper), { recursive: true });
    writeExecutable(realCodex, "#!/usr/bin/env bash\nprintf 'original\\n'\n");
    writeExecutable(
      firstWrapper,
      "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'first\\n'\nexec \"$CODEX_LINUX_FEATURE_WRAPPED_CODEX_CLI_FIRST_FEATURE\" \"$@\"\n",
    );
    writeExecutable(
      secondWrapper,
      "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'second\\n'\nexec \"$CODEX_LINUX_FEATURE_WRAPPED_CODEX_CLI_SECOND_FEATURE\" \"$@\"\n",
    );

    const harness = path.join(tempDir, "run-chain.sh");
    writeExecutable(
      harness,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "canonical_path() { readlink -f \"$1\"; }",
        functionMatch[0],
        `CODEX_CLI_PATH=${JSON.stringify(realCodex)}`,
        `CODEX_LINUX_FEATURES_DIR=${JSON.stringify(featuresDir)}`,
        "apply_feature_codex_cli_wrappers >/dev/null",
        "exec \"$CODEX_CLI_PATH\" app-server",
      ].join("\n"),
    );

    const output = childProcess.execFileSync("bash", [harness], { encoding: "utf8" });
    assert.deepEqual(output.trim().split("\n"), ["second", "first", "original"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("model query patch merges shim catalog rows into Desktop model list data", async () => {
  const sandbox = {
    fetch: async () => ({
      ok: true,
      json: async () => [
        {
          slug: "opencode-go-kimi-k2-6",
          display_name: "CLIProxyAPI / OpenCode Go / Kimi K2.6",
          provider_display_name: "CLIProxyAPI / OpenCode Go",
          model_provider: "codex_shim",
          model: "kimi-k2.6",
          input_modalities: ["text", "image"],
          supports_tools: true,
          supports_reasoning: true,
          supported_reasoning_efforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
          context_window: 262144,
          auto_compact_token_limit: 214958,
          truncation_policy: { mode: "tokens", limit: 180000 },
          model_catalog_json: "/tmp/codex-shim/custom_model_catalog.json",
        },
      ],
    }),
  };

  await vm.runInNewContext(
    [
      MODEL_QUERY_SHIM_HELPER_SOURCE,
      "(async()=>{result=await codexLinuxCustomModelMergeListModels({data:[{model:`gpt-5.5`}]})})()",
    ].join(";"),
    sandbox,
  );

  assert.equal(sandbox.result.data.length, 2);
  const row = sandbox.result.data[1];
  assert.equal(row.model, "opencode-go-kimi-k2-6");
  assert.equal(row.modelProvider, "codex_shim");
  assert.equal(row.upstreamModelId, "kimi-k2.6");
  assert.deepEqual(row.inputModalities, ["text", "image"]);
  assert.equal(row.supportsImageInputs, true);
  assert.equal(row.supportsTools, true);
  assert.equal(row.contextWindow, "262144");
  assert.equal(row.autoCompactTokenLimit, 214958);
  assert.deepEqual(row.truncationPolicy, { mode: "tokens", limit: 180000 });
  assert.equal(row.modelCatalogJson, "/tmp/codex-shim/custom_model_catalog.json");
  assert.equal(sandbox.__codexLinuxCustomModelSlugs.has("opencode-go-kimi-k2-6"), true);
  assert.equal(
    sandbox.__codexLinuxCustomModelCatalogPaths.get("opencode-go-kimi-k2-6"),
    "/tmp/codex-shim/custom_model_catalog.json",
  );
  const runtimeConfig = sandbox.__codexLinuxCustomModelRuntimeConfig.get("opencode-go-kimi-k2-6");
  assert.equal(runtimeConfig.model_context_window, 262144);
  assert.equal(runtimeConfig.model_auto_compact_token_limit, 214958);
  assert.equal(runtimeConfig.truncation_policy.mode, "tokens");
  assert.equal(runtimeConfig.truncation_policy.limit, 180000);
  assert.equal(sandbox.__codexLinuxCustomModelToolSupport.get("opencode-go-kimi-k2-6"), true);
  assert.equal(sandbox.__codexLinuxCustomModelToolSupport.get("kimi-k2.6"), true);

  vm.runInNewContext(
    [
      ROUTING_HELPER_SOURCE,
      "toolSlug=codexLinuxCustomModelSupportsTools(`opencode-go-kimi-k2-6`);",
      "toolWire=codexLinuxCustomModelSupportsTools(`kimi-k2.6`);",
      "toolUnknown=codexLinuxCustomModelSupportsTools(`gpt-5.5`);",
    ].join(""),
    sandbox,
  );
  assert.equal(sandbox.toolSlug, true);
  assert.equal(sandbox.toolWire, true);
  assert.equal(sandbox.toolUnknown, false);
});

test("model query patch preserves explicit providers from shared catalog rows", async () => {
  const sandbox = {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        version: 1,
        providers: {
          openrouter: {
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            wire_api: "chat",
            env_key: "OPENROUTER_API_KEY",
            env_http_headers: {
              Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
            },
            http_headers: {
              "HTTP-Referer": "https://example.invalid",
              "X-Title": "Codex Desktop Linux",
              Authorization: "Bearer not-a-secret-but-unsafe-static-header",
            },
            auth: {
              command: "printenv OPENROUTER_API_KEY",
            },
            requires_openai_auth: false,
          },
          codex_shim: {
            name: "Codex Shim",
            base_url: "http://127.0.0.1:8765/v1",
            wire_api: "responses",
          },
        },
        models: [
          {
            slug: "openrouter-qwen3-coder",
            display_name: "Qwen3 Coder",
            provider_display_name: "OpenRouter",
            model_provider: "openrouter",
            upstream_model_id: "qwen/qwen3-coder",
            context_window: 262144,
          },
          {
            slug: "cursor-zai-coding-glm-5-2",
            display_name: "GLM 5.2",
            provider_display_name: "CLIProxyAPI / Cursor Z.ai Coding",
            model_provider: "codex_shim",
            upstream_model_id: "z-ai/glm-5.2",
            model_catalog_json: "/tmp/codex-shim/custom_model_catalog.json",
          },
          {
            slug: "missing-provider-row",
            display_name: "Missing Provider Row",
            provider_display_name: "Missing Provider",
            upstream_model_id: "missing-provider-row",
          },
        ],
      }),
    }),
  };

  await vm.runInNewContext(
    [
      MODEL_QUERY_SHIM_HELPER_SOURCE,
      "(async()=>{result=await codexLinuxCustomModelMergeListModels({data:[{model:`gpt-5.5`,modelProvider:`openai`}]})})()",
    ].join(";"),
    sandbox,
  );

  const direct = sandbox.result.data.find((row) => row.model === "openrouter-qwen3-coder");
  const shim = sandbox.result.data.find((row) => row.model === "cursor-zai-coding-glm-5-2");
  assert.equal(direct.modelProvider, "openrouter");
  assert.equal(direct.model_provider, "openrouter");
  assert.equal(direct.provider, "openrouter");
  assert.equal(direct.providerDisplayName, "OpenRouter");
  assert.equal(shim.modelProvider, "codex_shim");
  assert.equal(sandbox.result.data.find((row) => row.model === "missing-provider-row"), undefined);
  assert.equal(sandbox.__codexLinuxCustomModelProviders.get("openrouter-qwen3-coder"), "openrouter");
  assert.equal(sandbox.__codexLinuxCustomModelProviders.get("cursor-zai-coding-glm-5-2"), "codex_shim");
  assert.equal(sandbox.__codexLinuxCustomModelProviders.has("missing-provider-row"), false);
  assert.equal(sandbox.__codexLinuxCustomModelWireModels.get("openrouter-qwen3-coder"), "qwen/qwen3-coder");
  assert.equal(sandbox.__codexLinuxCustomModelWireModels.get("cursor-zai-coding-glm-5-2"), "z-ai/glm-5.2");
  assert.equal(sandbox.__codexLinuxCustomModelToolSupport.get("openrouter-qwen3-coder"), false);
  assert.equal(sandbox.__codexLinuxCustomModelToolSupport.get("qwen/qwen3-coder"), false);
  assert.equal(sandbox.__codexLinuxCustomModelToolSupport.get("cursor-zai-coding-glm-5-2"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.__codexLinuxCustomModelProviderConfigs.get("openrouter"))),
    {
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      wire_api: "chat",
      env_key: "OPENROUTER_API_KEY",
      env_http_headers: {
        Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
      },
      http_headers: {
        "HTTP-Referer": "https://example.invalid",
        "X-Title": "Codex Desktop Linux",
      },
      auth: {
        command: "printenv OPENROUTER_API_KEY",
      },
      requires_openai_auth: false,
    },
  );
});

test("model query patch registers provider metadata for app-server supplied custom rows", async () => {
  const fetchedUrls = [];
  const sandbox = {
    fetch: async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          version: 1,
          providers: {
            openrouter: {
              name: "OpenRouter",
              base_url: "https://openrouter.ai/api/v1",
              wire_api: "responses",
              env_key: "OPENROUTER_API_KEY",
            },
          },
          models: [
            {
              slug: "openrouter-qwen3-coder",
              display_name: "Qwen3 Coder",
              provider_display_name: "OpenRouter",
              model_provider: "openrouter",
              model: "qwen/qwen3-coder",
              context_window: 262144,
              auto_compact_token_limit: 210000,
            },
          ],
        }),
      };
    },
  };

  await vm.runInNewContext(
    [
      MODEL_QUERY_SHIM_HELPER_SOURCE,
      "(async()=>{result=await codexLinuxCustomModelMergeListModels({data:[{model:`openrouter-qwen3-coder`,displayName:`Qwen3 Coder`,description:`Qwen3 Coder via OpenRouter.`}]})})()",
    ].join(";"),
    sandbox,
  );

  assert.deepEqual(fetchedUrls, ["/codex-linux/custom-model-catalog.json"]);
  assert.equal(sandbox.result.data.length, 1);
  assert.equal(sandbox.result.data[0].model, "openrouter-qwen3-coder");
  assert.equal(sandbox.__codexLinuxCustomModelSlugs.has("openrouter-qwen3-coder"), true);
  assert.equal(sandbox.__codexLinuxCustomModelProviders.get("openrouter-qwen3-coder"), "openrouter");
  assert.equal(sandbox.__codexLinuxCustomModelWireModels.get("openrouter-qwen3-coder"), "qwen/qwen3-coder");
  assert.equal(
    sandbox.__codexLinuxCustomModelProviderConfigs.get("openrouter").base_url,
    "https://openrouter.ai/api/v1",
  );
  assert.equal(
    sandbox.__codexLinuxCustomModelRuntimeConfig.get("openrouter-qwen3-coder")
      .model_auto_compact_token_limit,
    210000,
  );
});

test("model query patch deduplicates identical provider and display rows", async () => {
  const sandbox = {
    fetch: async () => ({
      ok: true,
      json: async () => [
        {
          slug: "cursor-zai-coding-glm-5-2",
          display_name: "CLIProxyAPI / Cursor Z.ai Coding / GLM 5.2",
          provider_display_name: "CLIProxyAPI / Cursor Z.ai Coding",
          model_provider: "codex_shim",
        },
        {
          slug: "cursor-zai-coding-glm-5-2-44",
          display_name: "CLIProxyAPI / Cursor Z.ai Coding / GLM 5.2",
          provider_display_name: "CLIProxyAPI / Cursor Z.ai Coding",
          model_provider: "codex_shim",
        },
      ],
    }),
  };

  await vm.runInNewContext(
    [
      MODEL_QUERY_SHIM_HELPER_SOURCE,
      "(async()=>{result=await codexLinuxCustomModelMergeListModels({data:[]})})()",
    ].join(";"),
    sandbox,
  );

  assert.equal(sandbox.result.data.length, 1);
  assert.equal(sandbox.result.data[0].model, "cursor-zai-coding-glm-5-2");
  assert.equal(sandbox.__codexLinuxCustomModelSlugs.has("cursor-zai-coding-glm-5-2"), true);
  assert.equal(sandbox.__codexLinuxCustomModelSlugs.has("cursor-zai-coding-glm-5-2-44"), false);
});

test("model query patch never registers an official slug for shim routing", async () => {
  const sandbox = {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        version: 1,
        providers: {
          untrusted_provider: {
            name: "Untrusted custom provider",
            base_url: "http://127.0.0.1:9999/v1",
            wire_api: "responses",
          },
        },
        models: [
          {
            slug: "gpt-5.5",
            model: "captured-gpt-5.5",
            model_provider: "untrusted_provider",
            display_name: "Captured GPT-5.5",
            provider_display_name: "Untrusted custom provider",
            model_catalog_json: "/tmp/untrusted-catalog.json",
          },
        ],
      }),
    }),
  };

  await vm.runInNewContext(
    [
      MODEL_QUERY_SHIM_HELPER_SOURCE,
      "(async()=>{result=await codexLinuxCustomModelMergeListModels({data:[{model:`gpt-5.5`,displayName:`GPT-5.5`}]})})()",
    ].join(";"),
    sandbox,
  );

  assert.equal(sandbox.result.data.length, 1);
  assert.equal(sandbox.result.data[0].displayName, "GPT-5.5");
  assert.equal(sandbox.__codexLinuxCustomModelSlugs.has("gpt-5.5"), false);
  assert.equal(sandbox.__codexLinuxCustomModelCatalogPaths.has("gpt-5.5"), false);
  assert.equal(sandbox.__codexLinuxCustomModelProviders.has("gpt-5.5"), false);
  assert.equal(sandbox.__codexLinuxCustomModelWireModels.has("gpt-5.5"), false);
});

test("model query patch augments the model list request", () => {
  const source = [
    "var x=100,S=[`models`,`list`];",
    "var w=o(c,({availableModels:e,authMethod:t,defaultModel:n,hostId:a,isAuthLoading:o,limit:s,useHiddenModels:c},{get:l})=>({queryKey:C(a,t,s),enabled:l(r).includes(a)&&!o,staleTime:u.FIVE_MINUTES,queryFn:()=>i(`list-models-for-host`,{hostId:a,includeHidden:!0,cursor:null,limit:s}),select:({data:r})=>p({authMethod:t,availableModels:new Set(e),defaultModel:n,models:r,useHiddenModels:c})}));",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelListMergePatch, source);

  assert.match(patched, /function codexLinuxCustomModelMergeListModels/);
  assert.match(patched, new RegExp(MODEL_QUERY_SHIM_PATCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("model query patch preserves identifiers from the current upstream bundle", () => {
  const source = [
    "var x=100,S=[`models`,`list`];",
    "var w=n(i,({hostId:r,limit:o},{get:c})=>({queryKey:C(r,null,o),queryFn:()=>l(`list-models-for-host`,{hostId:r,includeHidden:!0,cursor:null,limit:o}),select:({data:r})=>r}));",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelListMergePatch, source);

  assert.match(patched, /function codexLinuxCustomModelMergeListModels/);
  assert.match(
    patched,
    /queryFn:async\(\)=>codexLinuxCustomModelMergeListModels\(await l\(`list-models-for-host`,\{hostId:r,includeHidden:!0,cursor:null,limit:o\}\)\),select:/,
  );
});

test("model query patch fails loudly when the upstream needle drifts", () => {
  assert.throws(
    () => applyCustomModelListMergePatch("var x=100,S=[`models`,`list`];queryFn:()=>changed()"),
    /model query fetch needle not found/,
  );
});

test("model provider grouping helper groups rows by provider metadata", () => {
  const sandbox = {};
  vm.runInNewContext(
    [
      MODEL_PROVIDER_GROUP_HELPER_SOURCE,
      "const jsx=(type,props,key)=>({type,props,key});",
      "const menu={Title:`Title`,Separator:`Separator`};",
      "const rows=[",
      "{model:`gpt-5.5`,displayName:`GPT-5.5`,modelProvider:`openai`},",
      "{model:`gpt-5.4`,displayName:`GPT-5.4`,modelProvider:`openai`},",
      "{model:`glm-5-2`,displayName:`GLM 5.2`,providerDisplayName:`CLIProxyAPI / Z.ai Coding`},",
      "{model:`mimo`,displayName:`MiMo`,providerDisplayName:`CLIProxyAPI / Xiaomi MiMo`},",
      "{model:`deepseek`,displayName:`DeepSeek`,providerDisplayName:`CLIProxyAPI / Z.ai Coding`},",
      "];",
      "result=codexLinuxCustomModelGroupModelOptions(rows,row=>({type:`Item`,key:row.model,label:row.displayName}),{jsx},menu);",
    ].join(""),
    sandbox,
  );

  const labels = sandbox.result.map((entry) => {
    if (entry.type === "Title") {
      return `title:${entry.props.children}`;
    }
    if (entry.type === "Separator") {
      return "separator";
    }
    return entry.key;
  });
  assert.equal(
    JSON.stringify(labels),
    JSON.stringify(
      [
        "title:OpenAI",
        "gpt-5.5",
        "gpt-5.4",
        "separator",
        "title:CLIProxyAPI / Z.ai Coding",
        "glm-5-2",
        "deepseek",
        "separator",
        "title:CLIProxyAPI / Xiaomi MiMo",
        "mimo",
      ],
    ),
  );
});

test("model provider grouping helper leaves single-provider lists unchanged", () => {
  const sandbox = {};
  vm.runInNewContext(
    [
      MODEL_PROVIDER_GROUP_HELPER_SOURCE,
      "const rows=[{model:`gpt-5.5`,modelProvider:`openai`},{model:`gpt-5.4`,modelProvider:`openai`}];",
      "result=codexLinuxCustomModelGroupModelOptions(rows,row=>({type:`Item`,key:row.model}),{jsx:()=>{}},{Title:`Title`,Separator:`Separator`});",
    ].join(""),
    sandbox,
  );

  assert.equal(
    JSON.stringify(sandbox.result.map((entry) => entry.key)),
    JSON.stringify(["gpt-5.5", "gpt-5.4"]),
  );
});

test("model provider grouping helper recovers providers from normalized descriptions", () => {
  const sandbox = {};
  vm.runInNewContext(
    [
      MODEL_PROVIDER_GROUP_HELPER_SOURCE,
      "const jsx=(type,props,key)=>({type,props,key});",
      "const menu={Title:`Title`,Separator:`Separator`};",
      "const rows=[",
      "{model:`gpt-5.5`,displayName:`GPT-5.5`,description:`Frontier model for complex coding.`},",
      "{model:`cursor-nous-portal-step-3-7-flash-free`,displayName:`Step 3.7 Flash:free`,description:`Step 3.7 Flash:free via CLIProxyAPI / Nous Portal.`},",
      "{model:`opencode-zen-minimax-m3-free`,displayName:`MiniMax M3 Free`,description:`MiniMax M3 Free via CLIProxyAPI / OpenCode Zen.`},",
      "];",
      "result=codexLinuxCustomModelGroupModelOptions(rows,row=>({type:`Item`,key:row.model,label:row.displayName}),{jsx},menu);",
    ].join(""),
    sandbox,
  );

  assert.equal(
    JSON.stringify(
      sandbox.result.map((entry) => {
        if (entry.type === "Title") {
          return `title:${entry.props.children}`;
        }
        if (entry.type === "Separator") {
          return "separator";
        }
        return entry.key;
      }),
    ),
    JSON.stringify([
      "title:OpenAI",
      "gpt-5.5",
      "separator",
      "title:CLIProxyAPI / Nous Portal",
      "cursor-nous-portal-step-3-7-flash-free",
      "separator",
      "title:CLIProxyAPI / OpenCode Zen",
      "opencode-zen-minimax-m3-free",
    ]),
  );
});

test("model provider grouping patch wraps the current model option map", () => {
  const patched = applyPatchTwice(applyCustomModelProviderGroupPatch, modelDropdownBundleFixture());

  assert.match(patched, /function codexLinuxCustomModelGroupModelOptions/);
  assert.match(patched, new RegExp(MODEL_PROVIDER_GROUP_PATCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(patched, /Y=c\?\.map\(e=>/);
});

test("model provider grouping patch fails loudly when the upstream needle drifts", () => {
  assert.throws(
    () => applyCustomModelProviderGroupPatch("function E(e){let t=(0,w.c)(76),{align:r}=e;return null}"),
    /model provider grouping needle not found/,
  );
});

test("recent thread patch clears provider filtering for local history", () => {
  const source = [
    "class T{",
    "listRecentThreads({cursor:e,limit:t}){return this.params.requestClient.sendRequest(`thread/list`,{limit:t,cursor:e,sortKey:this.recentConversationSortKey,modelProviders:null,archived:!1,sourceKinds:pe})}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelRecentThreadsPatch, source);

  assert.match(patched, /modelProviders:\[\]/);
  assert.doesNotMatch(patched, /modelProviders:null,archived:!1,sourceKinds:pe/);
});

test("recent thread patch fails loudly when the upstream needle drifts", () => {
  assert.throws(
    () => applyCustomModelRecentThreadsPatch("class T{listRecentThreads(){return null}}"),
    /recent thread provider filter needle not found/,
  );
});

test("recent thread patch ignores unrelated provider array markers", () => {
  const source = [
    "const unrelated={modelProviders:[]};",
    "class T{",
    "listRecentThreads({cursor:e,limit:t}){return this.params.requestClient.sendRequest(`thread/list`,{limit:t,cursor:e,sortKey:this.recentConversationSortKey,modelProviders:null,archived:!1,sourceKinds:pe})}",
    "}",
  ].join("");
  const patched = applyCustomModelRecentThreadsPatch(source);

  assert.match(patched, /modelProviders:\[\],archived:!1,sourceKinds:pe/);
});

test("recent thread patch preserves current upstream state-db options", () => {
  const source =
    "listRecentThreads({cursor:e,limit:t,useStateDbOnly:n=!1}){return this.params.requestClient.sendRequest(`thread/list`,{limit:t,cursor:e,sortKey:this.recentConversationSortKey,modelProviders:null,archived:!1,sourceKinds:Ue,useStateDbOnly:n})}";
  const patched = applyPatchTwice(applyCustomModelRecentThreadsPatch, source);

  assert.match(patched, /modelProviders:\[\],archived:!1,sourceKinds:Ue,useStateDbOnly:n/);
  assert.match(patched, /useStateDbOnly:n=!1/);
});

test("start conversation routing helper routes only catalog-registered slugs with explicit providers", () => {
  const sandbox = {
    __codexLinuxCustomModelSlugs: new Set(["opencode-go-kimi-k2-6", "provider-specific-custom"]),
    __codexLinuxCustomModelProviders: new Map([["opencode-go-kimi-k2-6", "codex_shim"]]),
    __codexLinuxCustomModelCatalogPaths: new Map([
      ["opencode-go-kimi-k2-6", "/tmp/codex-shim/custom_model_catalog.json"],
    ]),
    __codexLinuxCustomModelRuntimeConfig: new Map([
      [
        "opencode-go-kimi-k2-6",
        {
          model_context_window: 262144,
          model_auto_compact_token_limit: 214958,
          truncation_policy: { mode: "tokens", limit: 180000 },
        },
      ],
    ]),
  };

  vm.runInNewContext(
    [
      ROUTING_HELPER_SOURCE,
      "official=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`gpt-5.5`);",
      "custom=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`opencode-go-kimi-k2-6`);",
      "crof=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`crof-kimi-k2-6-precision`);",
      "composer=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`composer-2-5`);",
      "cursor=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`cursor-zai-coding-glm-5-2`);",
      "registered=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`provider-specific-custom`);",
      "autoReview=codexLinuxCustomModelApplyRouting({config:{},modelProvider:null},`codex-auto-review`);",
      "autoRouter=codexLinuxCustomModelApplyRouting({config:{},modelProvider:null},`codex-auto`);",
    ].join(""),
    sandbox,
  );

  assert.equal(sandbox.official.modelProvider, null);
  assert.equal(sandbox.official.config.model_provider, "openai");
  assert.equal(sandbox.custom.modelProvider, "codex_shim");
  assert.equal(sandbox.custom.model, "opencode-go-kimi-k2-6");
  assert.equal(sandbox.custom.config.model_provider, "codex_shim");
  assert.equal(sandbox.custom.config.model_catalog_json, "/tmp/codex-shim/custom_model_catalog.json");
  assert.equal(sandbox.custom.config.model_context_window, 262144);
  assert.equal(sandbox.custom.config.model_auto_compact_token_limit, 214958);
  assert.deepEqual(sandbox.custom.config.truncation_policy, { mode: "tokens", limit: 180000 });
  assert.equal(sandbox.custom.config["model_providers.codex_shim"].base_url, "http://127.0.0.1:8765/v1");
  assert.equal(sandbox.official.config.model_catalog_json, undefined);
  assert.equal(sandbox.official.config.model_context_window, undefined);
  assert.equal(sandbox.crof.modelProvider, null);
  assert.equal(sandbox.composer.modelProvider, null);
  assert.equal(sandbox.cursor.modelProvider, null);
  assert.equal(sandbox.registered.modelProvider, null);
  assert.equal(sandbox.registered.config.model_provider, "openai");
  assert.equal(sandbox.autoReview.modelProvider, null);
  assert.equal(sandbox.autoRouter.modelProvider, null);
  assert.equal(ROUTING_HELPER_SOURCE.includes("??`codex_shim`"), false);
});

test("start conversation routing helper routes explicit providers without injecting codex_shim", () => {
  const sandbox = {
    __codexLinuxCustomModelSlugs: new Set([
      "openrouter-qwen3-coder",
      "cursor-zai-coding-glm-5-2",
    ]),
    __codexLinuxCustomModelProviders: new Map([
      ["openrouter-qwen3-coder", "openrouter"],
      ["cursor-zai-coding-glm-5-2", "codex_shim"],
    ]),
    __codexLinuxCustomModelProviderConfigs: new Map([
      [
        "openrouter",
        {
          name: "OpenRouter",
          base_url: "https://openrouter.ai/api/v1",
          wire_api: "chat",
          env_key: "OPENROUTER_API_KEY",
        },
      ],
    ]),
    __codexLinuxCustomModelWireModels: new Map([
      ["openrouter-qwen3-coder", "qwen/qwen3-coder"],
      ["cursor-zai-coding-glm-5-2", "z-ai/glm-5.2"],
    ]),
    __codexLinuxCustomModelCatalogPaths: new Map([
      ["cursor-zai-coding-glm-5-2", "/fixture/codex-shim/custom_model_catalog.json"],
    ]),
  };

  vm.runInNewContext(
    [
      ROUTING_HELPER_SOURCE,
      "direct=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null,collaborationMode:{settings:{model:`openrouter-qwen3-coder`,reasoning_effort:`high`}}},`openrouter-qwen3-coder`);",
      "shim=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`cursor-zai-coding-glm-5-2`);",
      "official=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},modelProvider:null},`gpt-5.5`);",
    ].join(""),
    sandbox,
  );

  assert.equal(sandbox.direct.model, "qwen/qwen3-coder");
  assert.equal(sandbox.direct.modelProvider, "openrouter");
  assert.equal(sandbox.direct.config.model, "qwen/qwen3-coder");
  assert.equal(sandbox.direct.config.model_provider, "openrouter");
  assert.equal(sandbox.direct.collaborationMode.settings.model, "qwen/qwen3-coder");
  assert.equal(sandbox.direct.collaborationMode.settings.reasoning_effort, "high");
  assert.equal(sandbox.direct.config["model_providers.openrouter"].env_key, "OPENROUTER_API_KEY");
  assert.equal(sandbox.direct.config["model_providers.codex_shim"], undefined);
  assert.equal(sandbox.shim.model, "z-ai/glm-5.2");
  assert.equal(sandbox.shim.modelProvider, "codex_shim");
  assert.equal(sandbox.shim.config.model, "z-ai/glm-5.2");
  assert.equal(sandbox.shim.config.model_provider, "codex_shim");
  assert.equal(sandbox.shim.config.model_catalog_json, "/fixture/codex-shim/custom_model_catalog.json");
  assert.equal(sandbox.shim.config["model_providers.codex_shim"].base_url, "http://127.0.0.1:8765/v1");
  assert.equal(sandbox.official.modelProvider, null);
  assert.equal(sandbox.official.config.model_provider, "openai");
});

test("turn start routing helper keeps explicit official payload models on the default provider", () => {
  const sandbox = {
    __codexLinuxCustomModelSlugs: new Set(["qa-direct-model"]),
    __codexLinuxCustomModelProviders: new Map([["qa-direct-model", "qa_direct"]]),
    __codexLinuxCustomModelProviderConfigs: new Map([
      [
        "qa_direct",
        {
          name: "QA Direct Provider",
          base_url: "http://127.0.0.1:18080/v1",
          wire_api: "responses",
          env_key: "QA_DIRECT_API_KEY",
        },
      ],
    ]),
    __codexLinuxCustomModelWireModels: new Map([["qa-direct-model", "vendor/qa-direct-v1"]]),
  };

  vm.runInNewContext(
    [
      ROUTING_HELPER_SOURCE,
      "official=codexLinuxCustomModelApplyRouting({model:`gpt-5.4`,config:{model_provider:`openai`},collaborationMode:{settings:{model:`qa-direct-model`}}},codexLinuxCustomModelRouteModel(`gpt-5.4`,`qa-direct-model`));",
      "stale=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`},collaborationMode:{settings:{model:`qa-direct-model`}}},codexLinuxCustomModelRouteModel(void 0,`qa-direct-model`));",
    ].join(""),
    sandbox,
  );

  assert.equal(sandbox.official.model, "gpt-5.4");
  assert.equal(sandbox.official.modelProvider, undefined);
  assert.equal(sandbox.official.config.model_provider, "openai");
  assert.equal(sandbox.official.collaborationMode.settings.model, "qa-direct-model");
  assert.equal(sandbox.official.config["model_providers.qa_direct"], undefined);
  assert.equal(sandbox.stale.model, "vendor/qa-direct-v1");
  assert.equal(sandbox.stale.modelProvider, "qa_direct");
  assert.equal(sandbox.stale.config.model, "vendor/qa-direct-v1");
  assert.equal(sandbox.stale.config.model_provider, "qa_direct");
  assert.equal(sandbox.stale.collaborationMode.settings.model, "vendor/qa-direct-v1");
  assert.equal(sandbox.stale.config["model_providers.qa_direct"].env_key, "QA_DIRECT_API_KEY");
});

test("start conversation routing patch augments app-server conversation params", () => {
  const source = [
    "var Qg=5e3,$g=class{",
    "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{threadSource:s?.threadSource});if(c=O(c,a),c=await Zg(this.params.fetchFromHost,this.params.requestClient,c,n),s?.skipDynamicTools)return c}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelRoutingPatch, source);

  assert.match(patched, /function codexLinuxCustomModelApplyRouting/);
  assert.match(patched, /if\(c=codexLinuxCustomModelApplyRouting\(c,e\),c=O\(c,a\),/);
});

test("start conversation routing patch supports the current upstream bundle shape", () => {
  const source = [
    "var kg=5e3,Ag=class{",
    "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{persistExtendedHistory:s?.persistExtendedHistory??!1,threadSource:s?.threadSource});if(c=ae(c,a),c=await Og(this.params.fetchFromHost,this.params.requestClient,c,n),s?.skipDynamicTools)return c}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelRoutingPatch, source);

  assert.match(patched, /function codexLinuxCustomModelApplyRouting/);
  assert.match(patched, /codexLinuxCustomModelApplyRouting\(c,e\),c=ae\(c,a\)/);
});

test("start conversation routing patch supports renamed current upstream identifiers", () => {
  const source = [
    "var fg=5e3,pg=class{dynamicToolsForThreadStartRequests=new Map;",
    "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await _e(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{threadSource:s?.threadSource});if(c=de(c,a),c=await dg(this.params.fetchFromHost,this.params.requestClient,c,n))return c}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelRoutingPatch, source);

  assert.match(patched, /function codexLinuxCustomModelApplyRouting/);
  assert.match(patched, /codexLinuxCustomModelApplyRouting\(c,e\),c=de\(c,a\)/);
});

test("start conversation routing patch supports Electron 42 base instructions", () => {
  const source = [
    "var md=5e3,hd=class{dynamicToolsForThreadStartRequests=new Map;",
    "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await et(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{baseInstructions:s?.baseInstructions,threadSource:s?.threadSource});if(c=yt(c,a),c=await cd(this.params.fetchFromHost,this.params.requestClient,c,n))return c}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelRoutingPatch, source);

  assert.match(patched, /codexLinuxCustomModelApplyRouting\(c,e\),c=yt\(c,a\)/);
});

test("start conversation routing patch preserves custom provider during Electron 42 thread creation", () => {
  const source = [
    "var md=5e3,hd=class{dynamicToolsForThreadStartRequests=new Map;",
    "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await et(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{baseInstructions:s?.baseInstructions,threadSource:s?.threadSource});if(c=yt(c,a),c=await cd(this.params.fetchFromHost,this.params.requestClient,c,n))return c}",
    "async startConversation({input:e,collaborationMode:t,serviceTier:n,workspaceRoots:r,workspaceKind:i=`project`,projectlessOutputDirectory:a,permissions:o,cwd:s,memoryPreferences:u,baseInstructions:d,skipAutoTitleGeneration:f=!1,additionalDeveloperInstructions:p,config:m,responsesapiClientMetadata:h,projectAssignment:g,threadSource:_,threadStartKind:v}){let{conversationId:x}=await this.threadCreation.createConversation({collaborationMode:t,serviceTier:n,workspaceRoots:r,workspaceKind:i,projectlessOutputDirectory:a,permissions:o,cwd:s,memoryPreferences:u,baseInstructions:d,additionalDeveloperInstructions:p,config:m,projectAssignment:g,threadSource:_,threadStartKind:v,defaultFeatureOverrides:this.defaultFeatureOverrides,personality:this.personality});return x}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelRoutingPatch, source);

  assert.match(
    patched,
    /config:codexLinuxCustomModelApplyRouting\(\{config:m\?\?\{\}\},t\?\.settings\?\.model\)\.config,projectAssignment:g/,
  );
  assert.match(
    patched,
    /skipAutoTitleGeneration:f=codexLinuxCustomModelCustomSlug\(t\?\.settings\?\.model\)/,
  );
});

test("start conversation routing patch disables official auto-title calls for custom models", () => {
  const source = [
    "var fg=5e3,pg=class{dynamicToolsForThreadStartRequests=new Map;",
    "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await _e(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{threadSource:s?.threadSource});if(c=de(c,a),c=await dg(this.params.fetchFromHost,this.params.requestClient,c,n))return c}",
    "async startConversation({input:e,collaborationMode:t,memoryPreferences:u,skipAutoTitleGeneration:d=!1,additionalDeveloperInstructions:f}){let D=()=>this.generateConversationTitle();return d?null:D()}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelRoutingPatch, source);

  assert.match(
    patched,
    /skipAutoTitleGeneration:d=codexLinuxCustomModelCustomSlug\(t\?\.settings\?\.model\)/,
  );
});

test("fork conversation routing preserves custom model provider overrides", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "async function ry(e,{sourceConversationId:t,rolloutPath:n,cwd:r}){",
    "let d=e.getConversation(t);",
    "let f=await e.buildThreadCodexConfig(r??d?.cwd??null),p=await e.sendRequest(`thread/fork`,{threadId:t,path:n??null,cwd:r,threadSource:`user`,...f==null?{}:{config:f},developerInstructions:null});",
    "return p",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelForkRoutingPatch, source);

  assert.match(patched, new RegExp(FORK_ROUTING_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(patched, /d\?\.latestModel\?\?d\?\.latestCollaborationMode\?\.settings\?\.model/);
  assert.match(patched, /\.\.\.f\.modelProvider==null\?\{\}:\{modelProvider:f\.modelProvider\}/);
  assert.match(patched, /\.\.\.f\.config==null\?\{\}:\{config:f\.config\}/);
});

test("fork conversation routing preserves Electron 42 thread source", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "async function cp(e,{sourceConversationId:t,rolloutPath:n,cwd:r,threadSource:d=`user`}){",
    "let f=e.getConversation(t);",
    "let p=await e.buildThreadCodexConfig(r??f?.cwd??null),m=await e.sendRequest(`thread/fork`,{threadId:t,path:n??null,cwd:r,threadSource:d,...p==null?{}:{config:p},...s==null?{}:{developerInstructions:s}});",
    "return m",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelForkRoutingPatch, source);

  assert.match(patched, /threadSource:d/);
  assert.match(patched, /f\?\.latestModel\?\?f\?\.latestCollaborationMode\?\.settings\?\.model/);
  assert.match(patched, /\.\.\.p\.config==null\?\{\}:\{config:p\.config\}/);
});

test("fork and /goal routing helper preserves direct and shim provider payloads", () => {
  const sandbox = {
    __codexLinuxCustomModelSlugs: new Set([
      "openrouter-qwen3-coder",
      "cursor-zai-coding-glm-5-2",
    ]),
    __codexLinuxCustomModelProviders: new Map([
      ["openrouter-qwen3-coder", "openrouter"],
      ["cursor-zai-coding-glm-5-2", "codex_shim"],
    ]),
    __codexLinuxCustomModelProviderConfigs: new Map([
      [
        "openrouter",
        {
          name: "OpenRouter",
          base_url: "https://openrouter.ai/api/v1",
          wire_api: "responses",
          env_key: "OPENROUTER_API_KEY",
        },
      ],
    ]),
    __codexLinuxCustomModelWireModels: new Map([
      ["openrouter-qwen3-coder", "qwen/qwen3-coder"],
      ["cursor-zai-coding-glm-5-2", "z-ai/glm-5.2"],
    ]),
    __codexLinuxCustomModelCatalogPaths: new Map([
      ["cursor-zai-coding-glm-5-2", "/tmp/codex-shim/custom_model_catalog.json"],
    ]),
    directConversation: {
      latestModel: "openrouter-qwen3-coder",
      latestCollaborationMode: { settings: { model: "openrouter-qwen3-coder" } },
    },
    shimConversation: {
      latestModel: "cursor-zai-coding-glm-5-2",
      latestCollaborationMode: { settings: { model: "cursor-zai-coding-glm-5-2" } },
    },
    officialConversation: {
      latestModel: "gpt-5.5",
      latestCollaborationMode: { settings: { model: "gpt-5.5" } },
    },
  };

  vm.runInNewContext(
    [
      ROUTING_HELPER_SOURCE,
      "function forkPayload(conversation){",
      "let routed=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`}},conversation.latestModel??conversation.latestCollaborationMode?.settings?.model??``);",
      "return {threadId:`source-thread`,...routed.model==null?{}:{model:routed.model},...routed.modelProvider==null?{}:{modelProvider:routed.modelProvider},...routed.config==null?{}:{config:routed.config}}",
      "}",
      "direct=forkPayload(directConversation);",
      "shim=forkPayload(shimConversation);",
      "official=forkPayload(officialConversation);",
    ].join(""),
    sandbox,
  );

  assert.equal(sandbox.direct.model, "qwen/qwen3-coder");
  assert.equal(sandbox.direct.modelProvider, "openrouter");
  assert.equal(sandbox.direct.config.model, "qwen/qwen3-coder");
  assert.equal(sandbox.direct.config.model_provider, "openrouter");
  assert.equal(sandbox.direct.config["model_providers.openrouter"].env_key, "OPENROUTER_API_KEY");
  assert.equal(sandbox.direct.config["model_providers.codex_shim"], undefined);
  assert.equal(sandbox.shim.model, "z-ai/glm-5.2");
  assert.equal(sandbox.shim.modelProvider, "codex_shim");
  assert.equal(sandbox.shim.config.model, "z-ai/glm-5.2");
  assert.equal(sandbox.shim.config.model_provider, "codex_shim");
  assert.equal(sandbox.shim.config.model_catalog_json, "/tmp/codex-shim/custom_model_catalog.json");
  assert.equal(sandbox.shim.config["model_providers.codex_shim"].base_url, "http://127.0.0.1:8765/v1");
  assert.equal(sandbox.official.model, undefined);
  assert.equal(sandbox.official.modelProvider, undefined);
  assert.equal(sandbox.official.config.model_provider, "openai");
});

test("thread settings routing preserves custom provider on existing-thread model switches", () => {
  const sandbox = {
    __codexLinuxCustomModelSlugs: new Set([
      "commandcode-minimax-m2-7",
      "opencode-zen-minimax-m3-free",
      "cursor-zai-coding-glm-5-2",
    ]),
    __codexLinuxCustomModelProviders: new Map([
      ["commandcode-minimax-m2-7", "codex_shim"],
      ["opencode-zen-minimax-m3-free", "codex_shim"],
      ["cursor-zai-coding-glm-5-2", "codex_shim"],
    ]),
  };

  vm.runInNewContext(
    [
      ROUTING_HELPER_SOURCE,
      "official=codexLinuxCustomModelApplyThreadSettings({model:`gpt-5.5`,config:{model_provider:`openai`},collaborationMode:{settings:{model:`gpt-5.5`}}});",
      "custom=codexLinuxCustomModelApplyThreadSettings({model:`commandcode-minimax-m2-7`,config:{model_provider:`openai`},collaborationMode:{settings:{model:`commandcode-minimax-m2-7`,reasoning_effort:`high`}}});",
      "collabOnly=codexLinuxCustomModelApplyThreadSettings({collaborationMode:{settings:{model:`opencode-zen-minimax-m3-free`,reasoning_effort:`medium`}}});",
      "officialToCustom=codexLinuxCustomModelNeedsProviderResume({modelProvider:`openai`,latestModel:`gpt-5.5`},{model:`cursor-zai-coding-glm-5-2`});",
      "customToOfficial=codexLinuxCustomModelNeedsProviderResume({modelProvider:`codex_shim`,latestModel:`cursor-zai-coding-glm-5-2`},{model:`gpt-5.5`});",
      "customToCustom=codexLinuxCustomModelNeedsProviderResume({modelProvider:`codex_shim`,latestModel:`cursor-zai-coding-glm-5-2`},{model:`opencode-zen-minimax-m3-free`});",
    ].join(""),
    sandbox,
  );

  assert.equal(sandbox.official.modelProvider, undefined);
  assert.equal(sandbox.official.config.model_provider, "openai");
  assert.equal(sandbox.custom.model, "commandcode-minimax-m2-7");
  assert.equal(sandbox.custom.modelProvider, "codex_shim");
  assert.equal(sandbox.custom.config.model_provider, "codex_shim");
  assert.equal(sandbox.custom.collaborationMode.settings.model, "commandcode-minimax-m2-7");
  assert.equal(sandbox.collabOnly.model, "opencode-zen-minimax-m3-free");
  assert.equal(sandbox.collabOnly.modelProvider, "codex_shim");
  assert.equal(sandbox.officialToCustom, true);
  assert.equal(sandbox.customToOfficial, true);
  assert.equal(sandbox.customToCustom, false);
});

test("thread settings routing patch augments existing-thread settings updates", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "class Manager{",
    "async updateThreadSettingsForNextTurn(e,t){let n=this.pendingThreadSettingsUpdates.get(e),r=(async()=>{n!=null&&await n.catch(()=>void 0);let r=this.getConversation(e)?.latestThreadSettings,i=this.getStreamRole(e);if(await this.sendThreadFollowerRequest(i,`thread-follower-update-thread-settings`,{conversationId:e,threadSettings:t})){this.getConversation(e)?.latestThreadSettings===r&&this.updateConversationState(e,e=>{zp(e,t)});return}if(this.threadSettingsUpdateSupport!==`unsupported`)try{await this.sendRequest(`thread/settings/update`,{threadId:e,...t}),this.threadSettingsUpdateSupport=`supported`,this.getConversation(e)?.latestThreadSettings===r&&this.updateConversationState(e,e=>{zp(e,t)});return}catch(e){if(!wr(e,`thread/settings/update`))throw e;this.threadSettingsUpdateSupport=`unsupported`}this.updateConversationState(e,e=>{zp(e,t)})})();this.pendingThreadSettingsUpdates.set(e,r);try{await r}finally{this.pendingThreadSettingsUpdates.get(e)===r&&this.pendingThreadSettingsUpdates.delete(e)}}",
    "async waitForPendingThreadSettingsUpdate(e){await this.pendingThreadSettingsUpdates.get(e)}",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelThreadSettingsRoutingPatch, source);

  assert.match(patched, /t=codexLinuxCustomModelApplyThreadSettings\(t\);let n=this\.pendingThreadSettingsUpdates/);
  assert.match(
    patched,
    /codexLinuxCustomModelNeedsProviderResume\(this\.getConversation\(e\),t\)/,
  );
  assert.match(patched, /sendRequest\(`thread\/unsubscribe`,\{threadId:e\}\)/);
  assert.match(patched, /this\.streamState\.removeConversation\(e\)/);
  assert.match(patched, /resumeConversationForUnavailableOwner\(\{conversationId:e,model:codexLinuxTargetModel/);
  assert.match(patched, /sendRequest\(`thread\/settings\/update`,\{threadId:e,\.\.\.t\}\)/);
});

test("turn start routing patch recovers stale custom threads without provider settings", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "async function submit(e,t,a){",
    "let C=a.model,T=a.effort,he=a.serviceTier,pe=a.summary,fe=a.personality,y=a.collaborationMode,ae=a.cwd,o=a.clientUserMessageId,ue=!1,le=!1,O=null,re=null,de=null,se=null,h=`project`,ge={threadId:t,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:ue||le?O:null,approvalsReviewer:re,sandboxPolicy:de==null&&(ue||le)?se:null,permissions:de,model:C,serviceTier:he,effort:T,summary:pe,personality:fe,responsesapiClientMetadata:{...a.responsesapiClientMetadata,workspace_kind:h??`project`},outputSchema:a.outputSchema??null,collaborationMode:y??null,attachments:a.attachments??[]},j={threadId:t,...a,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:O,approvalsReviewer:re,sandboxPolicy:se,permissions:de,model:C??null,serviceTier:he,effort:T??null,summary:pe,personality:fe,outputSchema:a.outputSchema??null,collaborationMode:y??null};",
    "let n=await e.sendRequest(`turn/start`,ge,{timeoutMs:1});return n}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelTurnStartRoutingPatch, source);

  assert.match(patched, /ge=codexLinuxCustomModelApplyRouting\(\{threadId:t/);
  assert.match(patched, /\},codexLinuxCustomModelRouteModel\(C,y\?\.settings\?\.model\)\),j=\{threadId:t/);
  assert.match(patched, /sendRequest\(`turn\/start`,ge/);
});

test("turn start routing patch rewrites legacy top-level-only routing hook", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "async function submit(e,t,a){",
    "let C=a.model,T=a.effort,he=a.serviceTier,pe=a.summary,fe=a.personality,y=a.collaborationMode,ae=a.cwd,o=a.clientUserMessageId,ue=!1,le=!1,O=null,re=null,de=null,se=null,h=`project`,ge=codexLinuxCustomModelApplyRouting({threadId:t,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:ue||le?O:null,approvalsReviewer:re,sandboxPolicy:de==null&&(ue||le)?se:null,permissions:de,model:C,serviceTier:he,effort:T,summary:pe,personality:fe,responsesapiClientMetadata:{...a.responsesapiClientMetadata,workspace_kind:h??`project`},outputSchema:a.outputSchema??null,collaborationMode:y??null,attachments:a.attachments??[]},C),j={threadId:t,...a,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:O,approvalsReviewer:re,sandboxPolicy:se,permissions:de,model:C??null,serviceTier:he,effort:T??null,summary:pe,personality:fe,outputSchema:a.outputSchema??null,collaborationMode:y??null};",
    "let n=await e.sendRequest(`turn/start`,ge,{timeoutMs:1});return n}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelTurnStartRoutingPatch, source);

  assert.match(patched, /\},codexLinuxCustomModelRouteModel\(C,y\?\.settings\?\.model\)\),j=\{threadId:t/);
  assert.doesNotMatch(patched, /\},C\),j=\{threadId:t/);
});

test("turn start routing patch upgrades unsafe collaboration-mode fallback routing hook", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "async function submit(e,t,a){",
    "let C=a.model,T=a.effort,he=a.serviceTier,pe=a.summary,fe=a.personality,y=a.collaborationMode,ae=a.cwd,o=a.clientUserMessageId,ue=!1,le=!1,O=null,re=null,de=null,se=null,h=`project`,ge=codexLinuxCustomModelApplyRouting({threadId:t,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:ue||le?O:null,approvalsReviewer:re,sandboxPolicy:de==null&&(ue||le)?se:null,permissions:de,model:C,serviceTier:he,effort:T,summary:pe,personality:fe,responsesapiClientMetadata:{...a.responsesapiClientMetadata,workspace_kind:h??`project`},outputSchema:a.outputSchema??null,collaborationMode:y??null,attachments:a.attachments??[]},C??y?.settings?.model),j={threadId:t,...a,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:O,approvalsReviewer:re,sandboxPolicy:se,permissions:de,model:C??null,serviceTier:he,effort:T??null,summary:pe,personality:fe,outputSchema:a.outputSchema??null,collaborationMode:y??null};",
    "let n=await e.sendRequest(`turn/start`,ge,{timeoutMs:1});return n}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelTurnStartRoutingPatch, source);

  assert.match(patched, /\},codexLinuxCustomModelRouteModel\(C,y\?\.settings\?\.model\)\),j=\{threadId:t/);
  assert.doesNotMatch(patched, /\},C\?\?y\?\.settings\?\.model\),j=\{threadId:t/);
});

test("fork conversation routing leaves official models on the default provider", () => {
  const sandbox = {
    __codexLinuxCustomModelSlugs: new Set(["opencode-zen-minimax-m3-free"]),
    __codexLinuxCustomModelProviders: new Map([["opencode-zen-minimax-m3-free", "codex_shim"]]),
    officialConversation: {
      latestModel: "gpt-5.5",
      latestCollaborationMode: { settings: { model: "gpt-5.5" } },
    },
    customConversation: {
      latestModel: "opencode-zen-minimax-m3-free",
      latestCollaborationMode: { settings: { model: "opencode-zen-minimax-m3-free" } },
    },
  };

  vm.runInNewContext(
    [
      ROUTING_HELPER_SOURCE,
      "official=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`}},officialConversation.latestModel);",
      "custom=codexLinuxCustomModelApplyRouting({config:{model_provider:`openai`}},customConversation.latestModel);",
    ].join(""),
    sandbox,
  );

  assert.equal(sandbox.official.modelProvider, undefined);
  assert.equal(sandbox.official.config.model_provider, "openai");
  assert.equal(sandbox.custom.model, "opencode-zen-minimax-m3-free");
  assert.equal(sandbox.custom.modelProvider, "codex_shim");
  assert.equal(sandbox.custom.config.model_provider, "codex_shim");
});

test("resume dynamic-tools patch re-fetches tools only for tool-capable catalog rows", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "async resumeThread(t,ee,te,y,E){return this.buildNewConversationParams(ee,te,y[0]??`/`,E,E.approvalsReviewer,{skipDynamicTools:!0,threadId:t})}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelResumeDynamicToolsPatch, source);

  assert.match(patched, /skipDynamicTools:!codexLinuxCustomModelSupportsTools\(ee\)/);
  assert.doesNotMatch(patched, /skipDynamicTools:!codexLinuxCustomModelCustomSlug/);
});

test("resume dynamic-tools patch upgrades old custom-slug gating", () => {
  const source = [
    ROUTING_HELPER_SOURCE,
    "async resumeThread(t,ee,te,y,E){return this.buildNewConversationParams(ee,te,y[0]??`/`,E,E.approvalsReviewer,{skipDynamicTools:!codexLinuxCustomModelCustomSlug(ee),threadId:t})}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelResumeDynamicToolsPatch, source);

  assert.match(patched, /skipDynamicTools:!codexLinuxCustomModelSupportsTools\(ee\)/);
  assert.doesNotMatch(patched, /skipDynamicTools:!codexLinuxCustomModelCustomSlug/);
});

test("resume dynamic-tools patch is a no-op when the upstream resume needle drifts", () => {
  const source = `${ROUTING_HELPER_SOURCE}async resumeThread(){return {skipDynamicTools:!0}}`;
  assert.equal(applyCustomModelResumeDynamicToolsPatch(source), source);
});

test("resume dynamic-tools payload patch forwards dynamicTools on thread/resume", () => {
  const needle =
    "personality:p?.personality===void 0?f?.personality??A.personality:p.personality,excludeTurns:b,...b?{initialTurnsPage:{limit:5,itemsView:`full`}}:{}})";
  const source = `${ROUTING_HELPER_SOURCE}sendRequest(\`thread/resume\`,{threadId:t,${needle}`;
  const patched = applyPatchTwice(applyCustomModelResumeDynamicToolsPayloadPatch, source);
  assert.match(patched, /dynamicTools:A\.dynamicTools/);
  assert.match(
    patched,
    /codexLinuxCustomModelSupportsTools\(A\.model\?\?A\.collaborationMode\?\.settings\?\.model\)/,
  );
});

test("resume dynamic-tools payload patch requires the tool-support helper", () => {
  const needle =
    "personality:p?.personality===void 0?f?.personality??A.personality:p.personality,excludeTurns:b,...b?{initialTurnsPage:{limit:5,itemsView:`full`}}:{}})";
  assert.throws(
    () => applyCustomModelResumeDynamicToolsPayloadPatch(`sendRequest(\`thread/resume\`,{threadId:t,${needle}`),
    /tool support helper must be injected/u,
  );
});

test("model tooltip formatter surfaces provider and capability details", () => {
  const sandbox = {
    model: {
      model: "qwen3-coder",
      displayName: "Qwen3 Coder",
      owned_by: "opencode-zen",
      upstream_model_id: "qwen/qwen3-coder",
      inputModalities: ["text", "image"],
      supportsTools: true,
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
      context_window: 262144,
      auto_compact_token_limit: 214958,
      truncation_policy: { mode: "tokens", limit: 180000 },
    },
  };

  vm.runInNewContext(
    `${MODEL_TOOLTIP_HELPER_SOURCE};result=codexLinuxCustomModelTooltip(model,"Coding model.");`,
    sandbox,
  );

  assert.equal(
    sandbox.result,
    [
      "Coding model.",
      "Provider: opencode-zen",
      "Display: Qwen3 Coder",
      "Model: qwen/qwen3-coder",
      "Capabilities: text input, image input, tools",
      "Reasoning: medium, high",
      "Context: 262144",
      "Auto-compact: 214958",
      "Truncation: 180000",
      "Source: CLIProxyAPI/local adapter",
    ].join("\n"),
  );
});

test("model tooltip patch augments composer model option tooltips", () => {
  const source = [
    "function Om(e){",
    "let t=(0,$.c)(24),{conversationId:n,modelOption:r}=e,u=_t(kt),{locale:d}=Ht(),{model:f,displayName:p,description:m,supportedReasoningEfforts:h,defaultReasoningEffort:g}=r,_=f===i.model?`true`:void 0,v=f===i.model?aa:void 0,y;",
    "t[0]!==m||t[1]!==d?(y=Oi(d)?m.replace(/\\.$/u,``):void 0,t[0]=m,t[1]=d,t[2]=y):y=t[2];",
    "return (0,Q.jsx)(oo.Item,{tooltipText:y})",
    "}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelTooltipPatch, source);

  assert.match(patched, /function codexLinuxCustomModelTooltip/);
  assert.match(patched, /y=codexLinuxCustomModelTooltip\(r,Oi\(d\)\?m\.replace/);
  assert.doesNotMatch(patched, /t\[0\]!==m\|\|t\[1\]!==d\?\(y=Oi/);
});

test("model tooltip patch supports renamed current upstream identifiers", () => {
  const source = [
    "function dg(e){let t=(0,$.c)(24),{conversationId:n,modelOption:r,modelSettings:i}=e,{description:g}=r,{locale:f}=Yt(),x;",
    "t[0]!==g||t[1]!==f?(x=aa(f)?g.replace(/\\.$/u,``):void 0,t[0]=g,t[1]=f,t[2]=x):x=t[2];",
    "return x}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelTooltipPatch, source);

  assert.match(patched, /function codexLinuxCustomModelTooltip/);
  assert.match(patched, /x=codexLinuxCustomModelTooltip\(r,aa\(f\)\?g\.replace/);
});

test("model tooltip patch supports the Electron 42 dropdown chunk", () => {
  const source = [
    "function ee(e){let t=(0,w.c)(19),{modelOption:i,selectedModel:a,onSelect:u}=e,{locale:f}=r(),{description:g}=i,x;",
    "t[0]!==g||t[1]!==f?(x=d(f)?g.replace(/\\.$/u,``):void 0,t[0]=g,t[1]=f,t[2]=x):x=t[2];",
    "return (0,T.jsx)(p.Item,{tooltipText:x})}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelTooltipPatch, source);

  assert.match(patched, /x=codexLinuxCustomModelTooltip\(i,d\(f\)\?g\.replace/);
});

test("Electron 42 descriptors target split routing and dropdown chunks", () => {
  const routing = descriptors.find(({ id }) => id === "start-conversation-routing");
  const tooltip = descriptors.find(({ id }) => id === "model-tooltip-details");
  assert.ok(routing);
  assert.ok(tooltip);
  assert.match("thread-context-inputs-D5uMjcUB.js", routing.pattern);
  assert.match("model-and-reasoning-dropdown-DLlEnLde.js", tooltip.pattern);
});

test("Electron 42 attachment descriptors target only the primary composer chunk", () => {
  const attachmentMenu = descriptors.find(({ id }) => id === "attachment-menu-image-affordance");
  assert.ok(attachmentMenu);
  assert.match("composer-DdM3sB3u.js", attachmentMenu.pattern);
  assert.match("composer-CCuv6v-2.js", attachmentMenu.pattern);
  assert.doesNotMatch("composer-controller-BrU4tk7h.js", attachmentMenu.pattern);
});

test("model tooltip patch fails loudly when the upstream needle drifts", () => {
  assert.throws(
    () => applyCustomModelTooltipPatch("function Om(e){return null}"),
    /model tooltip needle not found/,
  );
});

test("composer attachment prop patch passes image capability into the attachment menu", () => {
  const source =
    "let dl=(0,Q.jsx)(Jo,{onAddImageDataUrls:fc,onOpenGoalEditor:_c,supportsFileAttachments:ui!==`cloud`||!bi&&Ti===`local`,supportsRemoteFileAttachments:ui!==`cloud`&&Ti!==`local`});";
  const patched = applyPatchTwice(applyCustomModelComposerAttachmentPropPatch, source);

  assert.match(patched, /supportsImageInputs:Jt/);
});

test("composer attachment prop patch discovers the current image capability variable", () => {
  const source = [
    "let{imageInputUnsupportedReason:Pt,notifyImageInputUnsupported:Ft,supportsImageInputs:It}=mp({scope:z});",
    "let fl=(0,Q.jsx)(Ts,{onOpenGoalEditor:ac,supportsFileAttachments:Pr!==`cloud`,supportsRemoteFileAttachments:Pr!==`cloud`});",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelComposerAttachmentPropPatch, source);

  assert.match(patched, /onOpenGoalEditor:ac,supportsImageInputs:It,supportsFileAttachments:/);
});

test("composer attachment prop patch discovers the June 13 image capability hook result", () => {
  const source = [
    "let{imageInputUnsupportedReason:Bt,notifyImageInputUnsupported:Y,supportsImageInputs:Vt}=$d({scope:ee,conversationId:H,intl:St});",
    "let wl=(0,Q.jsx)(ts,{onAddImageDataUrls:lc,onOpenGoalEditor:mc,supportsFileAttachments:li!==`cloud`||!vi&&Ci===`local`,supportsRemoteFileAttachments:li!==`cloud`&&Ci!==`local`,onPickBrowserFiles:void 0});",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelComposerAttachmentPropPatch, source);

  assert.match(patched, /onOpenGoalEditor:mc,supportsImageInputs:Vt,supportsFileAttachments:/);
});

test("composer attachment prop patch supports the Electron 42 context menu", () => {
  const source = [
    "let{imageInputUnsupportedReason:Ht,notifyImageInputUnsupported:Ut,supportsImageInputs:Gt}=Gf({scope:z});",
    "Bc=Qy({executionTargetCwd:de.cwd,onAddImageDataUrls:Qa,setFileAttachments:ha,supportsFileAttachments:jr!==`cloud`,supportsRemoteFileAttachments:jr!==`cloud`})",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelComposerAttachmentPropPatch, source);

  assert.match(patched, /setFileAttachments:ha,supportsImageInputs:Gt,supportsFileAttachments:/);
});

test("attachment menu patch hides image affordances for text-only models", () => {
  const source = attachmentMenuBundleFixture();
  const patched = applyPatchTwice(applyCustomModelAttachmentMenuPatch, source);

  assert.match(patched, /supportsImageInputs:codexLinuxCustomModelSupportsImageInputs/);
  assert.match(patched, /codexLinuxCustomModelCanAddImages\?bt\(t\):\{images:\[\],others:t\}/);
  assert.match(patched, /supportsFileAttachments:k,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs/);
  assert.match(patched, /false&&t\[28\]===w/);
  assert.match(patched, /defaultMessage:`Add files`/);
  assert.match(patched, /q=codexLinuxCustomModelCanAddImages&&x&&h!=null/);
  assert.match(patched, /true\|\|t\[34\]!==r/);
  assert.equal((patched.match(/codexLinuxCustomModelCanAddImages=codexLinuxCustomModelSupportsImageInputs!==!1/g) ?? []).length, 2);
});

test("attachment menu patch supports the current upstream component layout", () => {
  const source = [
    "supportsFileAttachments:T,supportsRemoteFileAttachments:O,onPickBrowserFiles:k,disabled:A}=e,j=T===void 0?!0:T,M=O===void 0?!1:O,P=A===void 0?!1:A,F=a(s),",
    "if(t[16]!==_e||t[17]!==P||t[18]!==_||t[19]!==f||t[20]!==I||t[21]!==n||t[22]!==m||t[23]!==k||t[24]!==z||t[25]!==F||t[26]!==ne||t[27]!==p||t[28]!==q||t[29]!==j){we=async function(){",
    "let{images:i,others:a}=At(t),o=[];",
    "let Ie;t[60]!==h||supportsFileAttachments:j,togglingSwitchRef:B})",
    "supportsFileAttachments:w,togglingSwitchRef:T}=e,O=E(),",
    "se=w?gt:ue,G;",
    "let le;t[28]===w?le=t[29]:(",
    "le=w?(0,Q.jsx)(D,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(D,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})",
    "let q;t[34]!==r||t[35]!==h||t[36]!==i||t[37]!==o||t[38]!==c||t[39]!==f||t[40]!==g||t[41]!==_||t[42]!==v||t[43]!==x?(q=x&&h!=null?(0,Q.jsx)(ce,{electron:!0,children:(0,Q.jsx)(st,",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelAttachmentMenuPatch, source);

  assert.match(patched, /supportsImageInputs:codexLinuxCustomModelSupportsImageInputs/);
  assert.match(patched, /codexLinuxCustomModelCanAddImages\?At\(t\)/);
  assert.match(patched, /defaultMessage:`Add files`/);
  assert.match(patched, /q=codexLinuxCustomModelCanAddImages&&x&&h!=null/);
});

test("attachment menu patch supports the June 13 upstream component layout", () => {
  const source = [
    "supportsFileAttachments:D,supportsRemoteFileAttachments:O,onPickBrowserFiles:k,disabled:A}=e,j=D===void 0?!0:D,N=O===void 0?!1:O,P=A===void 0?!1:A,F=a(s),",
    "if(t[16]!==_e||t[17]!==P||t[18]!==_||t[19]!==f||t[20]!==L||t[21]!==n||t[22]!==m||t[23]!==k||t[24]!==z||t[25]!==F||t[26]!==ne||t[27]!==p||t[28]!==q||t[29]!==j){we=async function(){",
    "let{images:i,others:a}=At(t),o=[];",
    "let Ie;t[60]!==h||supportsFileAttachments:j,togglingSwitchRef:B})",
    "supportsFileAttachments:w,togglingSwitchRef:D}=e,O=T(),",
    "oe=ae,se=w?gt:ue,G;",
    "let le;t[32]===w?le=t[33]:(",
    "le=w?(0,Q.jsx)(E,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(E,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})",
    "let q;t[38]!==r||t[39]!==h||t[40]!==i||t[41]!==o||t[42]!==c||t[43]!==f||t[44]!==g||t[45]!==_||t[46]!==v||t[47]!==x?(q=x&&h!=null?(0,Q.jsx)(ce,{electron:!0,children:(0,Q.jsx)(st,",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelAttachmentMenuPatch, source);

  assert.match(patched, /supportsImageInputs:codexLinuxCustomModelSupportsImageInputs/);
  assert.match(patched, /codexLinuxCustomModelCanAddImages\?At\(t\)/);
  assert.match(patched, /supportsFileAttachments:j,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs/);
  assert.match(patched, /false&&t\[32\]===w/);
  assert.match(patched, /defaultMessage:`Add files`/);
  assert.match(patched, /q=codexLinuxCustomModelCanAddImages&&x&&h!=null/);
  assert.match(patched, /true\|\|t\[38\]!==r/);
});

test("attachment menu patch supports the Electron 42 integrated composer menu", () => {
  const source = [
    "function unrelated(r){return r==null||r.length===0||!r.valid}",
    "function qy(e){let t=[{disabled:!1,icon:e.supportsFileAttachments?`paperclip`:`image`,id:`pick-local-files`,label:e.supportsFileAttachments?e.labels.filesAndFolders:e.labels.addPhotos,run:()=>Jy(e)}];return t}",
    "async function Jy(e){let t=e.getAttachmentGeneration(),{images:n,otherFiles:r}=Yy(await e.pickFiles({imagesOnly:!e.supportsFileAttachments})),i=n.length===0?[]:await e.loadImageDataUrls(n);if(i.length>0&&e.addImageDataUrls(i),!e.supportsFileAttachments||r.length===0)return;e.addFileAttachments(r)}",
    "function Qy(e){let{supportsFileAttachments:v,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,supportsRemoteFileAttachments:y}=e,F=qy({supportsFileAttachments:v});return F}",
  ].join("");
  const patched = applyPatchTwice(applyCustomModelAttachmentMenuPatch, source);

  assert.match(patched, /supportsImageInputs:codexLinuxCustomModelSupportsImageInputs/);
  assert.match(patched, /imagesOnly:!e\.supportsFileAttachments&&e\.supportsImageInputs/);
  assert.match(patched, /e\.supportsImageInputs&&n\.length!==0/);
  assert.match(patched, /supportsImageInputs:codexLinuxCustomModelSupportsImageInputs/);
  assert.match(patched, /r==null\|\|r\.length===0\|\|!r\.valid/);
  assert.match(patched, /!e\.supportsFileAttachments\|\|codexLinuxOtherFiles\.length===0/);
  assert.doesNotMatch(
    patched.slice(0, patched.indexOf("async function Jy(e){")),
    /codexLinuxOtherFiles/,
  );
});

test("feature descriptors are required upstream patch points when enabled", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
    [
      ["model-picker-visibility", "webview-asset", "required-upstream"],
      ["model-list-shim-catalog", "webview-asset", "required-upstream"],
      ["start-conversation-routing", "webview-asset", "required-upstream"],
      ["existing-thread-settings-routing", "webview-asset", "required-upstream"],
      ["existing-thread-turn-start-routing", "webview-asset", "required-upstream"],
      ["fork-conversation-routing", "webview-asset", "required-upstream"],
      ["resume-dynamic-tools-for-custom-slugs", "webview-asset", "optional"],
      ["resume-forward-dynamic-tools-payload", "webview-asset", "optional"],
      ["recent-thread-provider-filter", "webview-asset", "required-upstream"],
      ["model-tooltip-details", "webview-asset", "required-upstream"],
      ["model-provider-groups", "webview-asset", "required-upstream"],
      ["composer-attachment-image-affordance-prop", "webview-asset", "required-upstream"],
      ["attachment-menu-image-affordance", "webview-asset", "required-upstream"],
    ],
  );

  withTempFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withTempFeatureConfig(["custom-model-catalog"], (featuresRoot) => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map((descriptor) => [
        descriptor.id,
        descriptor.phase,
        descriptor.ciPolicy,
      ]),
      [
        ["feature:custom-model-catalog:model-picker-visibility", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:model-list-shim-catalog", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:start-conversation-routing", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:existing-thread-settings-routing", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:existing-thread-turn-start-routing", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:fork-conversation-routing", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:resume-dynamic-tools-for-custom-slugs", "webview-asset", "optional"],
        ["feature:custom-model-catalog:resume-forward-dynamic-tools-payload", "webview-asset", "optional"],
        ["feature:custom-model-catalog:recent-thread-provider-filter", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:model-tooltip-details", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:model-provider-groups", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:composer-attachment-image-affordance-prop", "webview-asset", "required-upstream"],
        ["feature:custom-model-catalog:attachment-menu-image-affordance", "webview-asset", "required-upstream"],
      ],
    );
  });
});

test("asset descriptor validation fails when the model picker bundle is missing", () => {
  withExtractedApp(
    {
      "model-queries-test.js": [
        "var x=100,S=[`models`,`list`];",
        "var w=o(c,({availableModels:e,authMethod:t,defaultModel:n,hostId:a,isAuthLoading:o,limit:s,useHiddenModels:c},{get:l})=>({queryKey:C(a,t,s),enabled:l(r).includes(a)&&!o,staleTime:u.FIVE_MINUTES,queryFn:()=>i(`list-models-for-host`,{hostId:a,includeHidden:!0,cursor:null,limit:s}),select:({data:r})=>p({authMethod:t,availableModels:new Set(e),defaultModel:n,models:r,useHiddenModels:c})}));",
      ].join(""),
      "thread-context-inputs-test.js": [
        "var Qg=5e3,$g=class{",
        "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{threadSource:s?.threadSource});if(c=O(c,a),c=await Zg(this.params.fetchFromHost,this.params.requestClient,c,n),s?.skipDynamicTools)return c}",
        "async updateThreadSettingsForNextTurn(e,t){let n=this.pendingThreadSettingsUpdates.get(e),r=(async()=>{n!=null&&await n.catch(()=>void 0);let r=this.getConversation(e)?.latestThreadSettings,i=this.getStreamRole(e);if(await this.sendThreadFollowerRequest(i,`thread-follower-update-thread-settings`,{conversationId:e,threadSettings:t})){this.getConversation(e)?.latestThreadSettings===r&&this.updateConversationState(e,e=>{zp(e,t)});return}if(this.threadSettingsUpdateSupport!==`unsupported`)try{await this.sendRequest(`thread/settings/update`,{threadId:e,...t}),this.threadSettingsUpdateSupport=`supported`,this.getConversation(e)?.latestThreadSettings===r&&this.updateConversationState(e,e=>{zp(e,t)});return}catch(e){if(!wr(e,`thread/settings/update`))throw e;this.threadSettingsUpdateSupport=`unsupported`}this.updateConversationState(e,e=>{zp(e,t)})})();this.pendingThreadSettingsUpdates.set(e,r);try{await r}finally{this.pendingThreadSettingsUpdates.get(e)===r&&this.pendingThreadSettingsUpdates.delete(e)}}",
        "async waitForPendingThreadSettingsUpdate(e){await this.pendingThreadSettingsUpdates.get(e)}",
        "async submitTurn(e,t,a){let C=a.model,T=a.effort,he=a.serviceTier,pe=a.summary,fe=a.personality,y=a.collaborationMode,ae=a.cwd,o=a.clientUserMessageId,ue=!1,le=!1,O=null,re=null,de=null,se=null,h=`project`,ge={threadId:t,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:ue||le?O:null,approvalsReviewer:re,sandboxPolicy:de==null&&(ue||le)?se:null,permissions:de,model:C,serviceTier:he,effort:T,summary:pe,personality:fe,responsesapiClientMetadata:{...a.responsesapiClientMetadata,workspace_kind:h??`project`},outputSchema:a.outputSchema??null,collaborationMode:y??null,attachments:a.attachments??[]},j={threadId:t,...a,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:O,approvalsReviewer:re,sandboxPolicy:se,permissions:de,model:C??null,serviceTier:he,effort:T??null,summary:pe,personality:fe,outputSchema:a.outputSchema??null,collaborationMode:y??null};return this.sendRequest(`turn/start`,ge,{timeoutMs:1})}",
        "async forkConversation(e,t,n,r){let d=e.getConversation(t);let f=await e.buildThreadCodexConfig(r??d?.cwd??null),p=await e.sendRequest(`thread/fork`,{threadId:t,path:n??null,cwd:r,threadSource:`user`,...f==null?{}:{config:f},developerInstructions:null});return p}",
        "listRecentThreads({cursor:e,limit:t}){return this.params.requestClient.sendRequest(`thread/list`,{limit:t,cursor:e,sortKey:this.recentConversationSortKey,modelProviders:null,archived:!1,sourceKinds:pe})}",
        "}",
      ].join(""),
      "model-and-reasoning-dropdown-test.js": [
        "function Om(e){",
        "let t=(0,$.c)(24),{conversationId:n,modelOption:r}=e,u=_t(kt),{locale:d}=Ht(),{model:f,displayName:p,description:m,supportedReasoningEfforts:h,defaultReasoningEffort:g}=r,_=f===i.model?`true`:void 0,v=f===i.model?aa:void 0,y;",
        "t[0]!==m||t[1]!==d?(y=Oi(d)?m.replace(/\\.$/u,``):void 0,t[0]=m,t[1]=d,t[2]=y):y=t[2];",
        "return (0,Q.jsx)(oo.Item,{tooltipText:y})",
        "}",
        modelDropdownBundleFixture(),
      ].join(""),
      "composer-CCuv6v-2.js": [
        "function Om(e){",
        "let t=(0,$.c)(24),{conversationId:n,modelOption:r}=e,u=_t(kt),{locale:d}=Ht(),{model:f,displayName:p,description:m,supportedReasoningEfforts:h,defaultReasoningEffort:g}=r,_=f===i.model?`true`:void 0,v=f===i.model?aa:void 0,y;",
        "t[0]!==m||t[1]!==d?(y=Oi(d)?m.replace(/\\.$/u,``):void 0,t[0]=m,t[1]=d,t[2]=y):y=t[2];",
        "return (0,Q.jsx)(oo.Item,{tooltipText:y})",
        "}",
        "let dl=(0,Q.jsx)(Jo,{onAddImageDataUrls:fc,onOpenGoalEditor:_c,supportsFileAttachments:ui!==`cloud`||!bi&&Ti===`local`,supportsRemoteFileAttachments:ui!==`cloud`&&Ti!==`local`});",
        attachmentMenuBundleFixture(),
      ].join(""),
    },
    (extractedDir) => {
      const report = { patches: [] };
      applyWebviewAssetPatchDescriptors(
        extractedDir,
        normalizePatchDescriptors(descriptors),
        { linuxTarget: {}, linux: {} },
        report,
      );

      const picker = report.patches.find((patch) => patch.name === "model-picker-visibility");
      assert.equal(picker.status, "failed-required");
    },
  );
});

test("extracted app descriptors do not add a cross-origin shim catalog CSP", () => {
  withExtractedApp({}, (extractedDir) => {
    const indexPath = path.join(extractedDir, "webview", "index.html");
    const source = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com;\">";
    fs.writeFileSync(
      indexPath,
      source,
    );
    const report = { patches: [] };

    applyExtractedAppPatchDescriptors(
      extractedDir,
      normalizePatchDescriptors(descriptors),
      { linuxTarget: {}, linux: {} },
      report,
    );

    assert.deepEqual(report.patches.map((patch) => [patch.name, patch.status]), []);
    assert.equal(fs.readFileSync(indexPath, "utf8"), source);
  });
});

test("asset descriptor validation patches current bundles", () => {
  withExtractedApp(
    {
      "model-list-filter-test.js":
        "function e(){let a=[],o=null,s=i&&e!==`amazonBedrock`;return s}",
      "model-queries-test.js": [
        "var x=100,S=[`models`,`list`];",
        "var w=o(c,({availableModels:e,authMethod:t,defaultModel:n,hostId:a,isAuthLoading:o,limit:s,useHiddenModels:c},{get:l})=>({queryKey:C(a,t,s),enabled:l(r).includes(a)&&!o,staleTime:u.FIVE_MINUTES,queryFn:()=>i(`list-models-for-host`,{hostId:a,includeHidden:!0,cursor:null,limit:s}),select:({data:r})=>p({authMethod:t,availableModels:new Set(e),defaultModel:n,models:r,useHiddenModels:c})}));",
      ].join(""),
      "thread-context-inputs-test.js": [
        "var Qg=5e3,$g=class{",
        "async buildNewConversationParams(e,t,n,r,i,a,o,s){let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{threadSource:s?.threadSource});if(c=O(c,a),c=await Zg(this.params.fetchFromHost,this.params.requestClient,c,n),s?.skipDynamicTools)return c}",
        "async updateThreadSettingsForNextTurn(e,t){let n=this.pendingThreadSettingsUpdates.get(e),r=(async()=>{n!=null&&await n.catch(()=>void 0);let r=this.getConversation(e)?.latestThreadSettings,i=this.getStreamRole(e);if(await this.sendThreadFollowerRequest(i,`thread-follower-update-thread-settings`,{conversationId:e,threadSettings:t})){this.getConversation(e)?.latestThreadSettings===r&&this.updateConversationState(e,e=>{zp(e,t)});return}if(this.threadSettingsUpdateSupport!==`unsupported`)try{await this.sendRequest(`thread/settings/update`,{threadId:e,...t}),this.threadSettingsUpdateSupport=`supported`,this.getConversation(e)?.latestThreadSettings===r&&this.updateConversationState(e,e=>{zp(e,t)});return}catch(e){if(!wr(e,`thread/settings/update`))throw e;this.threadSettingsUpdateSupport=`unsupported`}this.updateConversationState(e,e=>{zp(e,t)})})();this.pendingThreadSettingsUpdates.set(e,r);try{await r}finally{this.pendingThreadSettingsUpdates.get(e)===r&&this.pendingThreadSettingsUpdates.delete(e)}}",
        "async waitForPendingThreadSettingsUpdate(e){await this.pendingThreadSettingsUpdates.get(e)}",
        "async submitTurn(e,t,a){let C=a.model,T=a.effort,he=a.serviceTier,pe=a.summary,fe=a.personality,y=a.collaborationMode,ae=a.cwd,o=a.clientUserMessageId,ue=!1,le=!1,O=null,re=null,de=null,se=null,h=`project`,ge={threadId:t,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:ue||le?O:null,approvalsReviewer:re,sandboxPolicy:de==null&&(ue||le)?se:null,permissions:de,model:C,serviceTier:he,effort:T,summary:pe,personality:fe,responsesapiClientMetadata:{...a.responsesapiClientMetadata,workspace_kind:h??`project`},outputSchema:a.outputSchema??null,collaborationMode:y??null,attachments:a.attachments??[]},j={threadId:t,...a,clientUserMessageId:o,input:a.input,cwd:ae,approvalPolicy:O,approvalsReviewer:re,sandboxPolicy:se,permissions:de,model:C??null,serviceTier:he,effort:T??null,summary:pe,personality:fe,outputSchema:a.outputSchema??null,collaborationMode:y??null};return this.sendRequest(`turn/start`,ge,{timeoutMs:1})}",
        "async forkConversation(e,t,n,r){let d=e.getConversation(t);let f=await e.buildThreadCodexConfig(r??d?.cwd??null),p=await e.sendRequest(`thread/fork`,{threadId:t,path:n??null,cwd:r,threadSource:`user`,...f==null?{}:{config:f},developerInstructions:null});return p}",
        "listRecentThreads({cursor:e,limit:t}){return this.params.requestClient.sendRequest(`thread/list`,{limit:t,cursor:e,sortKey:this.recentConversationSortKey,modelProviders:null,archived:!1,sourceKinds:pe})}",
        "}",
      ].join(""),
      "model-and-reasoning-dropdown-test.js": [
        "function Om(e){",
        "let t=(0,$.c)(24),{conversationId:n,modelOption:r}=e,u=_t(kt),{locale:d}=Ht(),{model:f,displayName:p,description:m,supportedReasoningEfforts:h,defaultReasoningEffort:g}=r,_=f===i.model?`true`:void 0,v=f===i.model?aa:void 0,y;",
        "t[0]!==m||t[1]!==d?(y=Oi(d)?m.replace(/\\.$/u,``):void 0,t[0]=m,t[1]=d,t[2]=y):y=t[2];",
        "return (0,Q.jsx)(oo.Item,{tooltipText:y})",
        "}",
        modelDropdownBundleFixture(),
      ].join(""),
      "composer-CCuv6v-2.js": [
        "function Om(e){",
        "let t=(0,$.c)(24),{conversationId:n,modelOption:r}=e,u=_t(kt),{locale:d}=Ht(),{model:f,displayName:p,description:m,supportedReasoningEfforts:h,defaultReasoningEffort:g}=r,_=f===i.model?`true`:void 0,v=f===i.model?aa:void 0,y;",
        "t[0]!==m||t[1]!==d?(y=Oi(d)?m.replace(/\\.$/u,``):void 0,t[0]=m,t[1]=d,t[2]=y):y=t[2];",
        "return (0,Q.jsx)(oo.Item,{tooltipText:y})",
        "}",
        "let dl=(0,Q.jsx)(Jo,{onAddImageDataUrls:fc,onOpenGoalEditor:_c,supportsFileAttachments:ui!==`cloud`||!bi&&Ti===`local`,supportsRemoteFileAttachments:ui!==`cloud`&&Ti!==`local`});",
        attachmentMenuBundleFixture(),
      ].join(""),
    },
    (extractedDir, assetsDir) => {
      const report = { patches: [] };
      applyWebviewAssetPatchDescriptors(
        extractedDir,
        normalizePatchDescriptors(descriptors),
        { linuxTarget: {}, linux: {} },
        report,
      );

      assert.deepEqual(
        report.patches.map((patch) => [patch.name, patch.status]),
        [
          ["model-picker-visibility", "applied"],
          ["model-list-shim-catalog", "applied"],
          ["start-conversation-routing", "applied"],
          ["existing-thread-settings-routing", "applied"],
          ["existing-thread-turn-start-routing", "applied"],
          ["fork-conversation-routing", "applied"],
          ["resume-dynamic-tools-for-custom-slugs", "already-applied"],
          ["resume-forward-dynamic-tools-payload", "already-applied"],
          ["recent-thread-provider-filter", "applied"],
          ["model-tooltip-details", "applied"],
          ["model-provider-groups", "applied"],
          ["composer-attachment-image-affordance-prop", "applied"],
          ["attachment-menu-image-affordance", "applied"],
        ],
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "model-list-filter-test.js"), "utf8"),
        /s=!1/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "model-queries-test.js"), "utf8"),
        /codexLinuxCustomModelMergeListModels/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "thread-context-inputs-test.js"), "utf8"),
        /codexLinuxCustomModelApplyRouting/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "thread-context-inputs-test.js"), "utf8"),
        /codexLinuxCustomModelApplyThreadSettings/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "thread-context-inputs-test.js"), "utf8"),
        /codexLinuxCustomModelApplyRouting\(\{threadId:t[\s\S]*\},codexLinuxCustomModelRouteModel\(C,y\?\.settings\?\.model\)\),j=\{threadId:t/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "thread-context-inputs-test.js"), "utf8"),
        /modelProvider:f\.modelProvider/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "thread-context-inputs-test.js"), "utf8"),
        /modelProviders:\[\]/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "model-and-reasoning-dropdown-test.js"), "utf8"),
        new RegExp(MODEL_TOOLTIP_PATCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "model-and-reasoning-dropdown-test.js"), "utf8"),
        /codexLinuxCustomModelGroupModelOptions/,
      );
      assert.match(fs.readFileSync(path.join(assetsDir, "composer-CCuv6v-2.js"), "utf8"), /supportsImageInputs:Jt/);
      assert.match(
        fs.readFileSync(path.join(assetsDir, "composer-CCuv6v-2.js"), "utf8"),
        /defaultMessage:`Add files`/,
      );
    },
  );
});
