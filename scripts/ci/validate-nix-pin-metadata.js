#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_REPO_DIR = path.resolve(__dirname, "..", "..");
const SRI_SHA256_PATTERN = /^sha256-[A-Za-z0-9+/=]{44}$/u;
const VERSION_PATTERN = /^[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z._-]+)?$/u;

function usage() {
  return [
    "Usage: validate-nix-pin-metadata.js [options]",
    "",
    "Options:",
    "  --repo-dir <path>      Repository root (default: current repository)",
    "  --flake <path>         flake.nix path (default: <repo>/flake.nix)",
    "  --native-pkg <path>    native-modules package.json path",
    "  --codex-cli <path>     codex-cli-runtime.sh path",
    "  --bundled-plugins <path>",
    "                         bundled-plugins.sh path",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    repoDir: DEFAULT_REPO_DIR,
    flakePath: null,
    nativePkgPath: null,
    codexCliRuntimePath: null,
    bundledPluginsPath: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo-dir") {
      options.repoDir = argv[index + 1];
      if (!options.repoDir) throw new Error(usage());
      index += 1;
    } else if (arg === "--flake") {
      options.flakePath = argv[index + 1];
      if (!options.flakePath) throw new Error(usage());
      index += 1;
    } else if (arg === "--native-pkg") {
      options.nativePkgPath = argv[index + 1];
      if (!options.nativePkgPath) throw new Error(usage());
      index += 1;
    } else if (arg === "--codex-cli") {
      options.codexCliRuntimePath = argv[index + 1];
      if (!options.codexCliRuntimePath) throw new Error(usage());
      index += 1;
    } else if (arg === "--bundled-plugins") {
      options.bundledPluginsPath = argv[index + 1];
      if (!options.bundledPluginsPath) throw new Error(usage());
      index += 1;
    } else {
      throw new Error(usage());
    }
  }

  options.repoDir = path.resolve(options.repoDir);
  options.flakePath = path.resolve(options.flakePath ?? path.join(options.repoDir, "flake.nix"));
  options.nativePkgPath = path.resolve(
    options.nativePkgPath ?? path.join(options.repoDir, "nix", "native-modules", "package.json"),
  );
  options.codexCliRuntimePath = path.resolve(
    options.codexCliRuntimePath ?? path.join(options.repoDir, "scripts", "lib", "codex-cli-runtime.sh"),
  );
  options.bundledPluginsPath = path.resolve(
    options.bundledPluginsPath ?? path.join(options.repoDir, "scripts", "lib", "bundled-plugins.sh"),
  );

  return options;
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readNixString(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"\\s*;`, "u"));
  return match ? match[1] : null;
}

function readFetchUrlField(source, binding, field) {
  const block = source.match(new RegExp(`\\b${binding}\\s*=\\s*pkgs[.]fetchurl\\s*\\{(?<body>[\\s\\S]*?)\\n\\s*\\};`, "u"));
  if (!block) return null;
  const value = block.groups.body.match(new RegExp(`\\b${field}\\s*=\\s*"([^"]+)"\\s*;`, "u"));
  return value ? value[1] : null;
}

function readShellDefault(source, variableName) {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp(`${escaped}="\\$\\{${escaped}:-([^}"]+)\\}"`, "u"));
  return match ? match[1] : null;
}

function readShellDefaultFromPattern(source, pattern) {
  const match = source.match(pattern);
  return match ? match[1] : null;
}

function sriToHex(sri) {
  if (!SRI_SHA256_PATTERN.test(sri)) {
    return null;
  }
  return Buffer.from(sri.slice("sha256-".length), "base64").toString("hex");
}

function validate(options) {
  const failures = [];
  const flake = readFile(options.flakePath);
  const nativePkg = JSON.parse(readFile(options.nativePkgPath));
  const codexCliRuntime = readFile(options.codexCliRuntimePath);
  const bundledPlugins = readFile(options.bundledPluginsPath);

  const codexVersion = readNixString(flake, "codexVersion");
  const codexCliVersion = readNixString(flake, "codexCliVersion");
  const electronVersion = readNixString(flake, "electronVersion");
  const codexDmgHash = readFetchUrlField(flake, "codexDmg", "hash");
  const nodeReplUrl = readFetchUrlField(flake, "browserUseNodeReplRuntime", "url");
  const nodeReplSri = readFetchUrlField(flake, "browserUseNodeReplRuntime", "hash");

  if (!codexVersion || !VERSION_PATTERN.test(codexVersion)) {
    failures.push("flake.nix codexVersion must be a version-like string");
  }
  if (!codexCliVersion || !VERSION_PATTERN.test(codexCliVersion)) {
    failures.push("flake.nix codexCliVersion must be a version-like string");
  }
  if (!electronVersion || !VERSION_PATTERN.test(electronVersion)) {
    failures.push("flake.nix electronVersion must be a version-like string");
  }
  if (!codexDmgHash || !SRI_SHA256_PATTERN.test(codexDmgHash)) {
    failures.push("flake.nix codexDmg hash must be an SRI sha256");
  }
  if (!nodeReplUrl || !/^https:\/\//u.test(nodeReplUrl)) {
    failures.push("flake.nix browserUseNodeReplRuntime url must be HTTPS");
  }
  if (!nodeReplSri || !SRI_SHA256_PATTERN.test(nodeReplSri)) {
    failures.push("flake.nix browserUseNodeReplRuntime hash must be an SRI sha256");
  }

  const nativeDeps = nativePkg.dependencies ?? {};
  if (nativeDeps.electron !== electronVersion) {
    failures.push(`native-modules electron pin mismatch: expected ${electronVersion}, got ${nativeDeps.electron ?? "missing"}`);
  }
  for (const dependency of ["better-sqlite3", "node-pty"]) {
    if (typeof nativeDeps[dependency] !== "string" || nativeDeps[dependency].trim() === "") {
      failures.push(`native-modules ${dependency} pin is missing`);
    }
  }

  const installerCliVersion = readShellDefault(codexCliRuntime, "CODEX_BUNDLED_CODEX_CLI_VERSION");
  if (installerCliVersion !== codexCliVersion) {
    failures.push(`Codex CLI pin mismatch: flake ${codexCliVersion ?? "missing"} vs installer ${installerCliVersion ?? "missing"}`);
  }

  const installerNodeReplUrl = readShellDefaultFromPattern(
    bundledPlugins,
    /CODEX_BROWSER_USE_NODE_REPL_RUNTIME_URL:-([^}"]+)/u,
  );
  const installerNodeReplSha = readShellDefaultFromPattern(
    bundledPlugins,
    /CODEX_BROWSER_USE_NODE_REPL_RUNTIME_SHA256:-([0-9a-f]{64})/u,
  );
  const nodeReplHex = nodeReplSri ? sriToHex(nodeReplSri) : null;
  if (installerNodeReplUrl !== nodeReplUrl) {
    failures.push(`Browser Use node_repl URL pin mismatch: flake ${nodeReplUrl ?? "missing"} vs installer ${installerNodeReplUrl ?? "missing"}`);
  }
  if (installerNodeReplSha !== nodeReplHex) {
    failures.push(`Browser Use node_repl SHA256 pin mismatch: flake ${nodeReplHex ?? "missing"} vs installer ${installerNodeReplSha ?? "missing"}`);
  }

  return failures;
}

function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }
    const failures = validate(options);
    if (failures.length > 0) {
      stderr.write(`Nix pin metadata validation failed:\n- ${failures.join("\n- ")}\n`);
      return 1;
    }
    stdout.write("Nix pin metadata validation passed.\n");
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = {
  parseArgs,
  readFetchUrlField,
  readNixString,
  run,
  sriToHex,
  validate,
};
