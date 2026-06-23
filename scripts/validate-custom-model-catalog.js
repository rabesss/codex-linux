#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const INTEGER_FIELDS = [
  "context_window",
  "max_context_window",
  "auto_compact_token_limit",
  "priority",
];
const BOOLEAN_FIELDS = [
  "supports_tools",
  "supports_reasoning",
  "supports_streaming",
  "supports_reasoning_summaries",
  "support_verbosity",
  "supports_search_tool",
  "supports_parallel_tool_calls",
  "supported_in_api",
  "prefer_websockets",
];
const REQUIRED_MODEL_FIELDS = [
  "slug",
  "model",
  "model_provider",
  "display_name",
  "provider_display_name",
];
const SAFE_SECRET_REFERENCE_KEYS = new Set(["env_key", "env_http_headers", "auth"]);
const SECRET_KEY_PATTERN = /(^|[_-])(api[_-]?key|secret|password|credential)([_-]|$)|(^|[_-])bearer([_-]|$)|(^|[_-])token$/i;
const OPENAI_KEY_PREFIX = "s" + "k-";
const GITHUB_TOKEN_PREFIX = "g" + "hp_";
const SLACK_TOKEN_PREFIX = "x" + "ox";
const SECRET_VALUE_PATTERN = new RegExp(
  `(${OPENAI_KEY_PREFIX}[A-Za-z0-9_-]{12,}|${GITHUB_TOKEN_PREFIX}[A-Za-z0-9_]{12,}|${SLACK_TOKEN_PREFIX}[baprs]-[A-Za-z0-9-]{12,})`,
  "u",
);

function usage() {
  return [
    "Usage: validate-custom-model-catalog.js [--json] <catalog.json> [...]",
    "",
    "Validates the Codex Desktop Linux shared custom model catalog contract.",
  ].join("\n");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function locationJoin(location, child) {
  return location ? `${location}.${child}` : child;
}

function readCatalog(filePath) {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { error: `failed to read JSON: ${error.message}` };
  }
}

function scanSecrets(value, location, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecrets(item, `${location}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) {
    if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
      errors.push(`${location}: contains a key-shaped secret value`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childLocation = locationJoin(location, key);
    if (SECRET_KEY_PATTERN.test(key) && !SAFE_SECRET_REFERENCE_KEYS.has(key)) {
      errors.push(`${childLocation}: catalog must not contain plaintext secret or credential fields`);
    }
    scanSecrets(child, childLocation, errors);
  }
}

function validateProvider(providerId, provider, source, errors) {
  if (!isObject(provider)) {
    errors.push(`${source}.providers.${providerId}: provider must be an object`);
    return;
  }
  for (const field of ["name", "base_url", "wire_api", "env_key"]) {
    if (provider[field] != null && !stringValue(provider[field])) {
      errors.push(`${source}.providers.${providerId}.${field}: must be a non-empty string`);
    }
  }
  if (provider.wire_api != null && !["responses", "chat", "openai", "anthropic"].includes(provider.wire_api)) {
    errors.push(`${source}.providers.${providerId}.wire_api: unsupported wire API "${provider.wire_api}"`);
  }
  if (provider.env_http_headers != null && !isObject(provider.env_http_headers)) {
    errors.push(`${source}.providers.${providerId}.env_http_headers: must be an object`);
  }
  if (provider.auth != null && !isObject(provider.auth)) {
    errors.push(`${source}.providers.${providerId}.auth: must be an object`);
  }
  if (provider.requires_openai_auth != null && typeof provider.requires_openai_auth !== "boolean") {
    errors.push(`${source}.providers.${providerId}.requires_openai_auth: must be boolean`);
  }
}

function validateModel(model, index, source, providers, seenSlugs, seenVisibleRows, errors, warnings) {
  const prefix = `${source}.models[${index}]`;
  if (!isObject(model)) {
    errors.push(`${prefix}: model row must be an object`);
    return;
  }
  for (const field of REQUIRED_MODEL_FIELDS) {
    if (!stringValue(model[field])) {
      errors.push(`${prefix}.${field}: required non-empty string`);
    }
  }
  const slug = stringValue(model.slug);
  if (slug) {
    if (seenSlugs.has(slug)) {
      errors.push(`${prefix}.slug: duplicate slug "${slug}"`);
    }
    seenSlugs.add(slug);
  }
  const modelProvider = stringValue(model.model_provider);
  if (modelProvider && modelProvider !== "codex_shim" && !providers.has(modelProvider)) {
    warnings.push(`${prefix}.model_provider: "${modelProvider}" is not declared in this catalog; ensure Codex config defines [model_providers.${modelProvider}]`);
  }
  const displayName = stringValue(model.display_name);
  const providerDisplayName = stringValue(model.provider_display_name);
  if (displayName && providerDisplayName) {
    const visibleKey = `${providerDisplayName}\u0000${displayName}`;
    if (seenVisibleRows.has(visibleKey)) {
      errors.push(`${prefix}: duplicate visible row "${providerDisplayName} / ${displayName}"`);
    }
    seenVisibleRows.add(visibleKey);
  }
  for (const field of INTEGER_FIELDS) {
    if (model[field] != null && (!Number.isInteger(model[field]) || model[field] < 1)) {
      errors.push(`${prefix}.${field}: must be a positive integer`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (model[field] != null && typeof model[field] !== "boolean") {
      errors.push(`${prefix}.${field}: must be boolean`);
    }
  }
  if (model.input_modalities != null) {
    if (!Array.isArray(model.input_modalities) || model.input_modalities.length === 0) {
      errors.push(`${prefix}.input_modalities: must be a non-empty array`);
    } else {
      for (const [modalityIndex, modality] of model.input_modalities.entries()) {
        if (!["text", "image"].includes(modality)) {
          errors.push(`${prefix}.input_modalities[${modalityIndex}]: unsupported modality "${modality}"`);
        }
      }
    }
  }
  if (model.supported_reasoning_levels != null) {
    if (!Array.isArray(model.supported_reasoning_levels)) {
      errors.push(`${prefix}.supported_reasoning_levels: must be an array`);
    } else {
      model.supported_reasoning_levels.forEach((level, levelIndex) => {
        if (!isObject(level) || !stringValue(level.effort)) {
          errors.push(`${prefix}.supported_reasoning_levels[${levelIndex}].effort: required non-empty string`);
        }
      });
    }
  }
  if (model.truncation_policy != null && !isObject(model.truncation_policy)) {
    errors.push(`${prefix}.truncation_policy: must be an object`);
  }
  if (model.available_in_plans != null && !Array.isArray(model.available_in_plans)) {
    errors.push(`${prefix}.available_in_plans: must be an array`);
  }
}

function validateCatalog(catalog, source) {
  const errors = [];
  const warnings = [];
  if (!isObject(catalog)) {
    return { source, ok: false, errors: [`${source}: catalog must be an object`], warnings };
  }
  if (catalog.version !== 1) {
    errors.push(`${source}.version: expected 1`);
  }
  if (!Array.isArray(catalog.models)) {
    errors.push(`${source}.models: required array`);
  }
  if (catalog.providers != null && !isObject(catalog.providers)) {
    errors.push(`${source}.providers: must be an object when present`);
  }
  scanSecrets(catalog, source, errors);

  const providers = new Set();
  if (isObject(catalog.providers)) {
    for (const [providerId, provider] of Object.entries(catalog.providers)) {
      if (!stringValue(providerId)) {
        errors.push(`${source}.providers: provider id must be non-empty`);
        continue;
      }
      providers.add(providerId);
      validateProvider(providerId, provider, source, errors);
    }
  }
  if (Array.isArray(catalog.models)) {
    const seenSlugs = new Set();
    const seenVisibleRows = new Set();
    catalog.models.forEach((model, index) => {
      validateModel(model, index, source, providers, seenSlugs, seenVisibleRows, errors, warnings);
    });
  }
  return { source, ok: errors.length === 0, errors, warnings };
}

function main(argv) {
  const args = [...argv];
  const json = args[0] === "--json";
  if (json) {
    args.shift();
  }
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(usage());
    return args.length === 0 ? 2 : 0;
  }

  const catalogs = args.map((filePath) => {
    const source = path.relative(process.cwd(), path.resolve(filePath)) || filePath;
    const read = readCatalog(filePath);
    if (read.error) {
      return { source, ok: false, errors: [`${source}: ${read.error}`], warnings: [] };
    }
    return validateCatalog(read.value, source);
  });
  const errors = catalogs.flatMap((catalog) => catalog.errors);
  const warnings = catalogs.flatMap((catalog) => catalog.warnings);
  const report = { ok: errors.length === 0, catalogs, errors, warnings };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const catalog of catalogs) {
      const status = catalog.ok ? "ok" : "failed";
      console.log(`${status}: ${catalog.source}`);
      for (const warning of catalog.warnings) {
        console.log(`warning: ${warning}`);
      }
      for (const error of catalog.errors) {
        console.error(`error: ${error}`);
      }
    }
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { validateCatalog };
