#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { validateCatalog } = require("./validate-custom-model-catalog.js");

const WIRE_APIS = new Set(["responses", "chat", "openai", "anthropic"]);
const MODALITIES = new Set(["text", "image"]);
const RESERVED_DIRECT_PROVIDERS = new Set(["openai", "chatgpt", "codex_shim"]);
const SAFE_STATIC_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie)$|api[-_]?key|token|secret|credential|password|bearer/i;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function usage() {
  return [
    "Usage:",
    "  custom-model-catalog-setup.js add-direct --provider <id> --provider-name <name> --base-url <url> --wire-api <responses|chat|openai|anthropic> --env-key <ENV> --slug <slug> --model <upstream-id> --display-name <label> [options]",
    "  custom-model-catalog-setup.js inspect [--catalog <path>] [--json]",
    "",
    "Options:",
    "  --catalog <path>                 Catalog path (default: $CODEX_HOME/custom-models.json)",
    "  --json                           Print machine-readable inspect output",
    "  --provider-display-name <label>  Picker provider group label (default: --provider-name)",
    "  --description <text>             Picker tooltip text",
    "  --env-header <Header=ENV>        Header value sourced from an environment variable",
    "  --http-header <Header=value>     Non-credential static metadata header",
    "  --auth-command <command>         Codex command-backed auth provider command",
    "  --context-window <tokens>        Context window metadata",
    "  --max-context-window <tokens>    Max context window metadata",
    "  --auto-compact-token-limit <n>   Auto-compaction threshold",
    "  --truncation-limit <tokens>      Token truncation limit",
    "  --input-modalities <items>       Comma-separated modalities: text,image (default: text)",
    "  --supports-tools                Mark verified tool support true",
    "  --no-supports-tools             Mark tool support false (default)",
    "  --supports-reasoning            Mark reasoning controls true",
    "  --supports-streaming            Mark streaming true (default)",
    "  --no-supports-streaming         Mark streaming false",
    "  --source <label>                Catalog source label (default: user-catalog)",
    "  --dry-run                       Validate and print output without writing",
    "",
    "The helper writes catalog metadata only. It never writes API keys and does not change ~/.codex/config.toml.",
  ].join("\n");
}

function defaultCatalogPath(env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  return path.join(codexHome, "custom-models.json");
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {
    command,
    envHeaders: {},
    httpHeaders: {},
    inputModalities: ["text"],
    supportsTools: false,
    supportsReasoning: false,
    supportsStreaming: true,
    source: "user-catalog",
    dryRun: false,
    json: false,
  };

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case "--catalog":
        options.catalog = takeValue(args, flag);
        break;
      case "--json":
        options.json = true;
        break;
      case "--provider":
        options.provider = takeValue(args, flag);
        break;
      case "--provider-name":
        options.providerName = takeValue(args, flag);
        break;
      case "--provider-display-name":
        options.providerDisplayName = takeValue(args, flag);
        break;
      case "--base-url":
        options.baseUrl = takeValue(args, flag);
        break;
      case "--wire-api":
        options.wireApi = takeValue(args, flag);
        break;
      case "--env-key":
        options.envKey = takeValue(args, flag);
        break;
      case "--env-header": {
        const [header, envName] = parsePair(takeValue(args, flag), flag);
        options.envHeaders[header] = envName;
        break;
      }
      case "--http-header": {
        const [header, value] = parsePair(takeValue(args, flag), flag);
        options.httpHeaders[header] = value;
        break;
      }
      case "--auth-command":
        options.authCommand = takeValue(args, flag);
        break;
      case "--slug":
        options.slug = takeValue(args, flag);
        break;
      case "--model":
        options.model = takeValue(args, flag);
        break;
      case "--display-name":
        options.displayName = takeValue(args, flag);
        break;
      case "--description":
        options.description = takeValue(args, flag);
        break;
      case "--context-window":
        options.contextWindow = positiveInt(takeValue(args, flag), flag);
        break;
      case "--max-context-window":
        options.maxContextWindow = positiveInt(takeValue(args, flag), flag);
        break;
      case "--auto-compact-token-limit":
        options.autoCompactTokenLimit = positiveInt(takeValue(args, flag), flag);
        break;
      case "--truncation-limit":
        options.truncationLimit = positiveInt(takeValue(args, flag), flag);
        break;
      case "--input-modalities":
        options.inputModalities = takeValue(args, flag).split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "--supports-tools":
        options.supportsTools = true;
        break;
      case "--no-supports-tools":
        options.supportsTools = false;
        break;
      case "--supports-reasoning":
        options.supportsReasoning = true;
        break;
      case "--supports-streaming":
        options.supportsStreaming = true;
        break;
      case "--no-supports-streaming":
        options.supportsStreaming = false;
        break;
      case "--source":
        options.source = takeValue(args, flag);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

function takeValue(args, flag) {
  if (args.length === 0 || args[0].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return args.shift();
}

function parsePair(value, flag) {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`${flag} must use Header=value syntax`);
  }
  return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
}

function positiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function validateIdentifier(value, label) {
  const normalized = nonEmpty(value, label);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`${label} must start with a letter and contain only letters, numbers, hyphen, or underscore`);
  }
  return normalized;
}

function validateEnvName(value, label) {
  const normalized = nonEmpty(value, label);
  if (!ENV_NAME_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a valid environment variable name`);
  }
  return normalized;
}

function validateOptions(options, env = process.env) {
  if (options.help) {
    return { help: true };
  }
  if (options.command === "inspect") {
    return {
      command: "inspect",
      catalog: path.resolve(options.catalog || defaultCatalogPath(env)),
      json: options.json,
    };
  }
  if (options.command !== "add-direct") {
    throw new Error("Expected command: add-direct or inspect");
  }
  if (options.json) {
    throw new Error("--json is only supported with inspect");
  }

  const provider = validateIdentifier(options.provider, "--provider");
  if (RESERVED_DIRECT_PROVIDERS.has(provider.toLowerCase())) {
    throw new Error(`--provider "${provider}" is reserved; use this helper for direct/local providers, not official OpenAI or shim rows`);
  }
  const providerName = nonEmpty(options.providerName, "--provider-name");
  const providerDisplayName = options.providerDisplayName ? nonEmpty(options.providerDisplayName, "--provider-display-name") : providerName;
  const baseUrl = nonEmpty(options.baseUrl, "--base-url");
  const wireApi = nonEmpty(options.wireApi, "--wire-api");
  if (!WIRE_APIS.has(wireApi)) {
    throw new Error(`--wire-api must be one of: ${[...WIRE_APIS].join(", ")}`);
  }
  const slug = validateIdentifier(options.slug, "--slug");
  const model = nonEmpty(options.model, "--model");
  const displayName = nonEmpty(options.displayName, "--display-name");
  const source = nonEmpty(options.source, "--source");
  const catalog = path.resolve(options.catalog || defaultCatalogPath(env));

  let envKey = null;
  if (options.envKey != null) {
    envKey = validateEnvName(options.envKey, "--env-key");
  }
  const envHeaders = {};
  for (const [header, envName] of Object.entries(options.envHeaders)) {
    envHeaders[nonEmpty(header, "--env-header header")] = validateEnvName(envName, `--env-header ${header}`);
  }
  const httpHeaders = {};
  for (const [header, headerValue] of Object.entries(options.httpHeaders)) {
    const name = nonEmpty(header, "--http-header header");
    if (SAFE_STATIC_HEADER_PATTERN.test(name)) {
      throw new Error(`--http-header ${name}: credential headers must use --env-header or --auth-command`);
    }
    httpHeaders[name] = nonEmpty(headerValue, `--http-header ${name}`);
  }
  const authCommand = options.authCommand ? nonEmpty(options.authCommand, "--auth-command") : null;
  if (!envKey && Object.keys(envHeaders).length === 0 && !authCommand && !baseUrl.startsWith("http://127.0.0.1:") && !baseUrl.startsWith("http://localhost:")) {
    throw new Error("Direct non-loopback providers need --env-key, --env-header, or --auth-command");
  }
  for (const modality of options.inputModalities) {
    if (!MODALITIES.has(modality)) {
      throw new Error(`Unsupported input modality: ${modality}`);
    }
  }
  if (!options.inputModalities.includes("text")) {
    throw new Error("--input-modalities must include text");
  }

  return {
    ...options,
    catalog,
    provider,
    providerName,
    providerDisplayName,
    baseUrl,
    wireApi,
    envKey,
    envHeaders,
    httpHeaders,
    authCommand,
    slug,
    model,
    displayName,
    description: options.description ? nonEmpty(options.description, "--description") : `${displayName} via ${providerDisplayName}.`,
    source,
  };
}

function readCatalog(catalogPath) {
  if (!fs.existsSync(catalogPath)) {
    return { version: 1, providers: {}, models: [] };
  }
  const data = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${catalogPath}: catalog must be a JSON object`);
  }
  return {
    ...data,
    version: data.version ?? 1,
    providers: data.providers && typeof data.providers === "object" && !Array.isArray(data.providers) ? data.providers : {},
    models: Array.isArray(data.models) ? data.models : [],
  };
}

function readExistingCatalog(catalogPath) {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`${catalogPath}: catalog does not exist`);
  }
  return readCatalog(catalogPath);
}

function providerConfig(options) {
  const provider = {
    name: options.providerName,
    base_url: options.baseUrl,
    wire_api: options.wireApi,
  };
  if (options.envKey) {
    provider.env_key = options.envKey;
  }
  if (Object.keys(options.envHeaders).length > 0) {
    provider.env_http_headers = options.envHeaders;
  }
  if (Object.keys(options.httpHeaders).length > 0) {
    provider.http_headers = options.httpHeaders;
  }
  if (options.authCommand) {
    provider.auth = { command: options.authCommand };
  }
  return provider;
}

function mergeProviderConfig(existing, generated) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const merged = { ...base, ...generated };
  for (const field of ["env_http_headers", "http_headers", "auth"]) {
    const previous = base[field];
    const next = generated[field];
    if (
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      next &&
      typeof next === "object" &&
      !Array.isArray(next)
    ) {
      merged[field] = { ...previous, ...next };
    }
  }
  return merged;
}

function modelRow(options) {
  const row = {
    slug: options.slug,
    model: options.model,
    model_provider: options.provider,
    display_name: options.displayName,
    provider_display_name: options.providerDisplayName,
    description: options.description,
    input_modalities: options.inputModalities,
    supports_tools: options.supportsTools,
    supports_reasoning: options.supportsReasoning,
    supports_streaming: options.supportsStreaming,
    source: options.source,
  };
  if (options.contextWindow != null) {
    row.context_window = options.contextWindow;
  }
  if (options.maxContextWindow != null) {
    row.max_context_window = options.maxContextWindow;
  }
  if (options.autoCompactTokenLimit != null) {
    row.auto_compact_token_limit = options.autoCompactTokenLimit;
  }
  if (options.truncationLimit != null) {
    row.truncation_policy = { mode: "tokens", limit: options.truncationLimit };
  }
  return row;
}

function mergeCatalog(catalog, options) {
  const next = {
    version: 1,
    providers: { ...(catalog.providers || {}) },
    models: [...(catalog.models || [])],
  };
  next.providers[options.provider] = mergeProviderConfig(next.providers[options.provider], providerConfig(options));
  const row = modelRow(options);
  const existingIndex = next.models.findIndex((model) => model && model.slug === options.slug);
  if (existingIndex >= 0) {
    next.models[existingIndex] = { ...next.models[existingIndex], ...row };
  } else {
    next.models.push(row);
  }
  return next;
}

function validateMergedCatalog(catalog, source) {
  const result = validateCatalog(catalog, source);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result;
}

function modelCapabilityReport(model, index) {
  const inputModalities = Array.isArray(model.input_modalities) && model.input_modalities.length > 0
    ? model.input_modalities
    : ["text"];
  const truncationLimit = model.truncation_policy && Number.isInteger(model.truncation_policy.limit)
    ? model.truncation_policy.limit
    : null;
  const capabilities = {
    inputModalities,
    imageInput: inputModalities.includes("image"),
    supportsTools: model.supports_tools === true,
    supportsReasoning: model.supports_reasoning === true,
    supportsStreaming: model.supports_streaming !== false,
    contextWindow: Number.isInteger(model.context_window) ? model.context_window : null,
    maxContextWindow: Number.isInteger(model.max_context_window) ? model.max_context_window : null,
    autoCompactTokenLimit: Number.isInteger(model.auto_compact_token_limit) ? model.auto_compact_token_limit : null,
    truncationLimit,
  };
  const warnings = [];
  if (!capabilities.imageInput) {
    warnings.push("image input disabled");
  }
  if (!capabilities.supportsTools) {
    warnings.push("Browser/MCP/Computer Use tools not advertised");
  }
  if (!capabilities.supportsStreaming) {
    warnings.push("streaming disabled");
  }
  if (capabilities.contextWindow == null && capabilities.maxContextWindow == null) {
    warnings.push("context window metadata missing");
  }
  if (capabilities.autoCompactTokenLimit == null) {
    warnings.push("auto-compaction threshold missing");
  }
  if (capabilities.truncationLimit == null) {
    warnings.push("truncation limit missing");
  }
  if (model.model_provider === "openai") {
    warnings.push("custom catalog row uses the official openai provider");
  }
  return {
    index,
    slug: model.slug || null,
    model: model.model || null,
    provider: model.model_provider || null,
    displayName: model.display_name || null,
    providerDisplayName: model.provider_display_name || null,
    source: model.source || null,
    capabilities,
    warnings,
  };
}

function inspectCatalog(catalog, source) {
  const validation = validateCatalog(catalog, source);
  const models = Array.isArray(catalog.models)
    ? catalog.models.filter((model) => model && typeof model === "object" && !Array.isArray(model)).map(modelCapabilityReport)
    : [];
  const warnings = [
    ...validation.warnings,
    ...models.flatMap((model) => model.warnings.map((warning) => `${model.providerDisplayName || model.provider || `model[${model.index}]`} / ${model.displayName || model.slug || model.model || "unknown"}: ${warning}`)),
  ];
  return {
    ok: validation.ok,
    catalog: source,
    validation,
    models,
    warnings,
    errors: validation.errors,
  };
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function formatNumber(value) {
  return value == null ? "-" : String(value);
}

function formatInspectText(report) {
  const lines = [];
  lines.push(`${report.ok ? "ok" : "failed"}: ${report.catalog}`);
  lines.push(`models: ${report.models.length}`);
  if (report.models.length > 0) {
    lines.push("");
    lines.push("Provider | Model | Slug | Route | Tools | Image | Reasoning | Streaming | Context | Auto-compact | Truncation");
    lines.push("---|---|---|---|---|---|---|---|---|---|---");
    for (const model of report.models) {
      const caps = model.capabilities;
      lines.push([
        model.providerDisplayName || "-",
        model.displayName || "-",
        model.slug || "-",
        model.provider || "-",
        yesNo(caps.supportsTools),
        yesNo(caps.imageInput),
        yesNo(caps.supportsReasoning),
        yesNo(caps.supportsStreaming),
        formatNumber(caps.contextWindow || caps.maxContextWindow),
        formatNumber(caps.autoCompactTokenLimit),
        formatNumber(caps.truncationLimit),
      ].join(" | "));
    }
  }
  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const error of report.errors) {
    lines.push(`error: ${error}`);
  }
  return `${lines.join("\n")}\n`;
}

function writeCatalog(catalogPath, catalog) {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true, mode: 0o700 });
  const tempPath = `${catalogPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, catalogPath);
  try {
    fs.chmodSync(catalogPath, 0o600);
  } catch {
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlInlineMap(value) {
  return `{ ${Object.entries(value).map(([key, item]) => `${tomlString(key)} = ${tomlString(item)}`).join(", ")} }`;
}

function configSnippet(options) {
  const lines = [
    "# Keep the global default on OpenAI so official Codex rows stay direct.",
    'model_provider = "openai"',
    "",
    `[model_providers.${options.provider}]`,
    `name = ${tomlString(options.providerName)}`,
    `base_url = ${tomlString(options.baseUrl)}`,
    `wire_api = ${tomlString(options.wireApi)}`,
  ];
  if (options.envKey) {
    lines.push(`env_key = ${tomlString(options.envKey)}`);
  }
  if (Object.keys(options.envHeaders).length > 0) {
    lines.push(`env_http_headers = ${tomlInlineMap(options.envHeaders)}`);
  }
  if (Object.keys(options.httpHeaders).length > 0) {
    lines.push(`http_headers = ${tomlInlineMap(options.httpHeaders)}`);
  }
  if (options.authCommand) {
    lines.push("", `[model_providers.${options.provider}.auth]`, `command = ${tomlString(options.authCommand)}`);
  }
  return lines.join("\n");
}

function run(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    const options = validateOptions(parsed);
    if (options.command === "inspect") {
      const catalog = readExistingCatalog(options.catalog);
      const report = inspectCatalog(catalog, options.catalog);
      if (options.json) {
        stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        stdout.write(formatInspectText(report));
      }
      return report.ok ? 0 : 1;
    }
    const catalog = readCatalog(options.catalog);
    const merged = mergeCatalog(catalog, options);
    const validation = validateMergedCatalog(merged, options.catalog);
    if (!options.dryRun) {
      writeCatalog(options.catalog, merged);
    }
    stdout.write(`${options.dryRun ? "validated" : "updated"}: ${options.catalog}\n`);
    for (const warning of validation.warnings) {
      stdout.write(`warning: ${warning}\n`);
    }
    stdout.write("\nAdd or keep this Codex config snippet outside the catalog:\n\n");
    stdout.write(`${configSnippet(options)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`error: ${error.message}\n`);
    stderr.write(`\n${usage()}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = {
  configSnippet,
  defaultCatalogPath,
  inspectCatalog,
  mergeCatalog,
  parseArgs,
  run,
  validateOptions,
};
