#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  run,
  sriToHex,
  validate,
} = require("./validate-nix-pin-metadata.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-nix-pin-metadata-"));
}

function writeFixture(root, overrides = {}) {
  const flakePath = path.join(root, "flake.nix");
  const nativePkgPath = path.join(root, "package.json");
  const codexCliRuntimePath = path.join(root, "codex-cli-runtime.sh");
  const bundledPluginsPath = path.join(root, "bundled-plugins.sh");

  fs.writeFileSync(flakePath, [
    "codexDmg = pkgs.fetchurl {",
    "  url = \"https://persistent.oaistatic.com/codex-app-prod/Codex.dmg\";",
    `  hash = "${overrides.codexDmgHash ?? "sha256-S7VSvxwZBL1m4oTTScRYKcWREORuSDLF1ps++vkQIT8="}";`,
    "};",
    `codexVersion = "${overrides.codexVersion ?? "26.616.81150"}";`,
    `codexCliVersion = "${overrides.codexCliVersion ?? "0.141.0"}";`,
    `electronVersion = "${overrides.electronVersion ?? "42.1.0"}";`,
    "browserUseNodeReplRuntime = pkgs.fetchurl {",
    "  url = \"https://persistent.oaistatic.com/codex-primary-runtime/26.426.12240/codex-primary-runtime-linux-x64-26.426.12240.tar.xz\";",
    "  hash = \"sha256-21Yk6276NrZuxvbdBIjO+5ZuSWNoYqq2IJpDNsHKkMQ=\";",
    "};",
    "",
  ].join("\n"), "utf8");

  fs.writeFileSync(nativePkgPath, `${JSON.stringify({
    dependencies: {
      electron: overrides.nativeElectron ?? "42.1.0",
      "better-sqlite3": "12.9.0",
      "node-pty": "1.1.0",
    },
  }, null, 2)}\n`, "utf8");

  fs.writeFileSync(codexCliRuntimePath, [
    "#!/bin/bash",
    `CODEX_BUNDLED_CODEX_CLI_VERSION="\${CODEX_BUNDLED_CODEX_CLI_VERSION:-${overrides.installerCliVersion ?? "0.141.0"}}"`,
    "",
  ].join("\n"), "utf8");

  fs.writeFileSync(bundledPluginsPath, [
    "#!/bin/bash",
    "CODEX_BROWSER_USE_NODE_REPL_RUNTIME_URL=\"${CODEX_BROWSER_USE_NODE_REPL_RUNTIME_URL:-https://persistent.oaistatic.com/codex-primary-runtime/26.426.12240/codex-primary-runtime-linux-x64-26.426.12240.tar.xz}\"",
    "CODEX_BROWSER_USE_NODE_REPL_RUNTIME_SHA256=\"${CODEX_BROWSER_USE_NODE_REPL_RUNTIME_SHA256:-db5624eb6efa36b66ec6f6dd0488cefb966e49636862aab6209a4336c1ca90c4}\"",
    "",
  ].join("\n"), "utf8");

  return {
    flakePath,
    nativePkgPath,
    codexCliRuntimePath,
    bundledPluginsPath,
  };
}

test("validates static Nix pin metadata without downloading the upstream DMG", () => {
  const root = tempDir();
  try {
    const fixture = writeFixture(root);
    assert.deepEqual(validate(fixture), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports local metadata drift", () => {
  const root = tempDir();
  try {
    const fixture = writeFixture(root, {
      nativeElectron: "41.0.0",
      installerCliVersion: "0.140.0",
    });
    const failures = validate(fixture).join("\n");
    assert.match(failures, /native-modules electron pin mismatch/);
    assert.match(failures, /Codex CLI pin mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run exits non-zero on invalid metadata", () => {
  const root = tempDir();
  try {
    const fixture = writeFixture(root, { codexDmgHash: "not-a-hash" });
    let stderr = "";
    const code = run([
      "--flake", fixture.flakePath,
      "--native-pkg", fixture.nativePkgPath,
      "--codex-cli", fixture.codexCliRuntimePath,
      "--bundled-plugins", fixture.bundledPluginsPath,
    ], {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    assert.equal(code, 1);
    assert.match(stderr, /codexDmg hash must be an SRI sha256/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sriToHex decodes SRI sha256 values", () => {
  assert.equal(
    sriToHex("sha256-S7VSvxwZBL1m4oTTScRYKcWREORuSDLF1ps++vkQIT8="),
    "4bb552bf1c1904bd66e284d349c45829c59110e46e4832c5d69b3efaf910213f",
  );
});
