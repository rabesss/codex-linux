#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { run } = require("./custom-model-catalog-setup.js");
const { validateCatalog } = require("./validate-custom-model-catalog.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-model-setup-"));
}

function captureRun(args) {
  let stdout = "";
  let stderr = "";
  const code = run(args, {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  return { code, stdout, stderr };
}

function validArgs(catalogPath) {
  return [
    "add-direct",
    "--catalog", catalogPath,
    "--provider", "openrouter",
    "--provider-name", "OpenRouter",
    "--base-url", "https://openrouter.ai/api/v1",
    "--wire-api", "responses",
    "--env-key", "OPENROUTER_API_KEY",
    "--env-header", "Authorization=OPENROUTER_AUTHORIZATION_HEADER",
    "--http-header", "HTTP-Referer=https://example.invalid",
    "--slug", "openrouter-qwen3-coder",
    "--model", "qwen/qwen3-coder",
    "--display-name", "Qwen3 Coder",
    "--context-window", "262144",
    "--auto-compact-token-limit", "210000",
    "--truncation-limit", "64000",
    "--supports-tools",
    "--supports-reasoning",
  ];
}

test("add-direct creates a provider-aware catalog without writing secrets", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    const result = captureRun(validArgs(catalogPath));

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /updated:/);
    assert.match(result.stdout, /model_provider = "openai"/);
    assert.match(result.stdout, /\[model_providers\.openrouter\]/);
    assert.match(result.stdout, /env_key = "OPENROUTER_API_KEY"/);
    assert.doesNotMatch(result.stdout, /sk-/);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.equal(catalog.version, 1);
    assert.equal(catalog.providers.openrouter.name, "OpenRouter");
    assert.equal(catalog.providers.openrouter.env_key, "OPENROUTER_API_KEY");
    assert.deepEqual(catalog.providers.openrouter.env_http_headers, {
      Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
    });
    assert.equal(catalog.models[0].slug, "openrouter-qwen3-coder");
    assert.equal(catalog.models[0].model, "qwen/qwen3-coder");
    assert.equal(catalog.models[0].model_provider, "openrouter");
    assert.equal(catalog.models[0].supports_tools, true);
    assert.deepEqual(catalog.models[0].truncation_policy, { mode: "tokens", limit: 64000 });
    assert.equal(validateCatalog(catalog, catalogPath).ok, true);

    const mode = fs.statSync(catalogPath).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add-direct is idempotent for an existing slug", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    assert.equal(captureRun(validArgs(catalogPath)).code, 0);
    const second = captureRun([
      ...validArgs(catalogPath),
      "--provider-display-name", "OpenRouter BYOK",
      "--source", "updated-user-catalog",
    ]);
    assert.equal(second.code, 0, second.stderr);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].provider_display_name, "OpenRouter BYOK");
    assert.equal(catalog.models[0].source, "updated-user-catalog");
    assert.equal(validateCatalog(catalog, catalogPath).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add-direct preserves existing provider metadata when updating a provider", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        providers: {
          openrouter: {
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            wire_api: "responses",
            env_key: "OPENROUTER_API_KEY",
            requires_openai_auth: true,
            request_max_retries: 4,
            env_http_headers: {
              "X-Existing": "OPENROUTER_EXISTING_HEADER",
            },
          },
        },
        models: [],
      }, null, 2),
      "utf8",
    );

    const result = captureRun([
      ...validArgs(catalogPath),
      "--env-header", "X-New=OPENROUTER_NEW_HEADER",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.equal(catalog.providers.openrouter.requires_openai_auth, true);
    assert.equal(catalog.providers.openrouter.request_max_retries, 4);
    assert.deepEqual(catalog.providers.openrouter.env_http_headers, {
      "X-Existing": "OPENROUTER_EXISTING_HEADER",
      Authorization: "OPENROUTER_AUTHORIZATION_HEADER",
      "X-New": "OPENROUTER_NEW_HEADER",
    });
    assert.equal(validateCatalog(catalog, catalogPath).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run validates and prints config without writing a catalog", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    const result = captureRun([...validArgs(catalogPath), "--dry-run"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /validated:/);
    assert.equal(fs.existsSync(catalogPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspect prints a provider capability matrix and warnings", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    const created = captureRun(validArgs(catalogPath));
    assert.equal(created.code, 0, created.stderr);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.models.push({
      slug: "local-small",
      model: "local-small",
      model_provider: "local",
      display_name: "Local Small",
      provider_display_name: "Local",
      input_modalities: ["text"],
      supports_tools: false,
      supports_streaming: false,
    });
    catalog.providers.local = {
      name: "Local",
      base_url: "http://127.0.0.1:1234/v1",
      wire_api: "responses",
    };
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    const before = fs.statSync(catalogPath).mtimeMs;

    const result = captureRun(["inspect", "--catalog", catalogPath]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ok:/);
    assert.match(result.stdout, /Provider \| Model \| Slug \| Route \| Tools \| Image/);
    assert.match(result.stdout, /OpenRouter \| Qwen3 Coder \| openrouter-qwen3-coder \| openrouter \| yes \| no \| yes \| yes \| 262144 \| 210000 \| 64000/);
    assert.match(result.stdout, /Local \| Local Small \| local-small \| local \| no \| no \| no \| no \| - \| - \| -/);
    assert.match(result.stdout, /warning: Local \/ Local Small: Browser\/MCP\/Computer Use tools not advertised/);
    assert.match(result.stdout, /warning: Local \/ Local Small: context window metadata missing/);
    assert.equal(fs.statSync(catalogPath).mtimeMs, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspect --json reports structured capability metadata", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    const created = captureRun(validArgs(catalogPath));
    assert.equal(created.code, 0, created.stderr);

    const result = captureRun(["inspect", "--catalog", catalogPath, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.catalog, catalogPath);
    assert.equal(report.models.length, 1);
    assert.deepEqual(report.models[0].capabilities.inputModalities, ["text"]);
    assert.equal(report.models[0].capabilities.supportsTools, true);
    assert.equal(report.models[0].capabilities.supportsReasoning, true);
    assert.equal(report.models[0].capabilities.supportsStreaming, true);
    assert.equal(report.models[0].capabilities.contextWindow, 262144);
    assert.equal(report.models[0].capabilities.autoCompactTokenLimit, 210000);
    assert.equal(report.models[0].capabilities.truncationLimit, 64000);
    assert.deepEqual(report.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspect reports validator warnings without failing", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        models: [
          {
            slug: "external-qwen",
            model: "qwen/qwen3-coder",
            model_provider: "external",
            display_name: "Qwen3 Coder",
            provider_display_name: "External",
            input_modalities: ["text", "image"],
            supports_tools: true,
            context_window: 262144,
            auto_compact_token_limit: 210000,
            truncation_policy: { mode: "tokens", limit: 64000 },
          },
        ],
      }, null, 2),
      "utf8",
    );

    const result = captureRun(["inspect", "--catalog", catalogPath]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /warning: .*model_provider: "external" is not declared/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspect returns validation errors without rewriting a catalog", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
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
            slug: "one",
            model: "qwen/qwen3-coder",
            model_provider: "openrouter",
            display_name: "Qwen3 Coder",
            provider_display_name: "OpenRouter",
          },
          {
            slug: "two",
            model: "qwen/qwen3-coder",
            model_provider: "openrouter",
            display_name: "Qwen3 Coder",
            provider_display_name: "OpenRouter",
          },
        ],
      }, null, 2),
      "utf8",
    );
    const before = fs.readFileSync(catalogPath, "utf8");

    const result = captureRun(["inspect", "--catalog", catalogPath]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /failed:/);
    assert.match(result.stdout, /duplicate visible row/);
    assert.equal(fs.readFileSync(catalogPath, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspect does not create a missing catalog", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "missing-custom-models.json");
    const result = captureRun(["inspect", "--catalog", catalogPath]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /catalog does not exist/);
    assert.equal(fs.existsSync(catalogPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspect does not resolve or print environment secret values", () => {
  const root = tempDir();
  const previousKey = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = "sk-testsecretvaluethatmustnotprint";
    const catalogPath = path.join(root, "custom-models.json");
    const created = captureRun(validArgs(catalogPath));
    assert.equal(created.code, 0, created.stderr);

    const result = captureRun(["inspect", "--catalog", catalogPath, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /sk-testsecretvaluethatmustnotprint/);
    assert.doesNotMatch(result.stderr, /sk-testsecretvaluethatmustnotprint/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.models[0].provider, "openrouter");
  } finally {
    if (previousKey == null) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add-direct rejects credential-shaped static headers", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    const args = validArgs(catalogPath);
    const refererIndex = args.indexOf("HTTP-Referer=https://example.invalid");
    args[refererIndex] = "Authorization=Bearer nope";
    const result = captureRun(args);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /credential headers must use --env-header or --auth-command/);
    assert.equal(fs.existsSync(catalogPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add-direct rejects reserved official and shim provider ids", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    const args = validArgs(catalogPath);
    args[args.indexOf("openrouter")] = "openai";
    const official = captureRun(args);
    assert.equal(official.code, 1);
    assert.match(official.stderr, /reserved/);

    const shimArgs = validArgs(catalogPath);
    shimArgs[shimArgs.indexOf("openrouter")] = "codex_shim";
    const shim = captureRun(shimArgs);
    assert.equal(shim.code, 1);
    assert.match(shim.stderr, /reserved/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add-direct rejects duplicate visible rows before writing", () => {
  const root = tempDir();
  try {
    const catalogPath = path.join(root, "custom-models.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
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
            slug: "existing-openrouter-qwen",
            model: "qwen/qwen3-coder",
            model_provider: "openrouter",
            display_name: "Qwen3 Coder",
            provider_display_name: "OpenRouter",
          },
        ],
      }, null, 2),
      "utf8",
    );

    const result = captureRun(validArgs(catalogPath));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /duplicate visible row/);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    assert.equal(catalog.models.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
