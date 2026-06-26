#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  readFlakePins,
  renderSupportedMd,
  renderSummary,
  run,
} = require("./render-supported-md.js");

const OFFICIAL_DMG_URL = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-supported-md-"));
}

function lock(overrides = {}) {
  return {
    schema_version: 1,
    approved: {
      upstream_app_version: "26.616.71553",
      dmg_url: OFFICIAL_DMG_URL,
      sha256: "a".repeat(64),
      size: 525051984,
      etag: null,
      last_modified: null,
      approved_at: "2026-06-25T00:00:00Z",
      approved_by: "manual",
      wrapper_min_commit: "1".repeat(40),
      patch_report: null,
      notes: "Seeded from validation.",
      ...(overrides.approved || {}),
    },
    candidate: overrides.candidate === undefined ? null : overrides.candidate,
  };
}

test("renderSupportedMd explains supported pin, CI validation, and no-payload boundary", () => {
  const markdown = renderSupportedMd({
    lock: lock(),
    repository: "rabesss/codex-linux",
    nixPins: {
      codexVersion: "26.616.81150",
      codexDmgHash: "sha256-example",
      codexCliVersion: "0.141.0",
      electronVersion: "42.1.0",
    },
  });

  assert.match(markdown, /# Supported Versions And Validation/);
  assert.match(markdown, /26\.616\.71553/);
  assert.match(markdown, new RegExp("a".repeat(64)));
  assert.match(markdown, /CI package jobs are validation jobs/);
  assert.match(markdown, /metadata and source only; no OpenAI app payload packages|metadata, hashes, logs, patch reports/);
  assert.match(markdown, /actions\/workflows\/ci\.yml\/badge\.svg/);
  assert.match(markdown, /make install-guided/);
  assert.match(markdown, /Nix packaging is a separate validation surface/);
  assert.match(markdown, /without downloading the mutable live `Codex\.dmg`/);
  assert.match(markdown, /CI \/ Nix Metadata/);
  assert.match(markdown, /Upstream DMG Watcher/);
  assert.match(markdown, /26\.616\.81150/);
});

test("renderSupportedMd includes candidate state when a candidate is present", () => {
  const markdown = renderSupportedMd({
    lock: lock({
      candidate: {
        upstream_app_version: "26.617.10000",
        dmg_url: OFFICIAL_DMG_URL,
        sha256: "b".repeat(64),
        size: 525052000,
        etag: "candidate-etag",
        last_modified: "Thu, 25 Jun 2026 06:00:00 GMT",
        detected_at: "2026-06-25T06:30:00Z",
        ci_status: "passed",
        workflow_run_url: "https://github.com/rabesss/codex-linux/actions/runs/1234567890",
        patch_report_artifact: "patch-report.json",
        wrapper_min_commit: "2".repeat(40),
        notes: "Validated candidate.",
      },
    }),
    repository: "rabesss/codex-linux",
  });

  assert.match(markdown, /Candidate upstream app/);
  assert.match(markdown, /26\.617\.10000/);
  assert.match(markdown, /Maintainer visibility only until promoted/);
  assert.match(markdown, /actions\/runs\/1234567890/);
});

test("run writes and checks SUPPORTED.md deterministically", () => {
  const root = tempDir();
  try {
    const lockPath = path.join(root, "upstream-dmg-lock.json");
    const flakePath = path.join(root, "flake.nix");
    const outputPath = path.join(root, "SUPPORTED.md");
    fs.writeFileSync(lockPath, `${JSON.stringify(lock(), null, 2)}\n`, "utf8");
    fs.writeFileSync(flakePath, [
      "codexDmg = pkgs.fetchurl {",
      "  hash = \"sha256-example\";",
      "};",
      "codexVersion = \"26.616.81150\";",
      "codexCliVersion = \"0.141.0\";",
      "electronVersion = \"42.1.0\";",
      "",
    ].join("\n"), "utf8");

    let stdout = "";
    let stderr = "";
    let code = run([
      "--lock", lockPath,
      "--flake", flakePath,
      "--output", outputPath,
      "--repo", "rabesss/codex-linux",
    ], {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });

    assert.equal(code, 0, stderr);
    assert.match(stdout, /Wrote support document/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /Supported Versions And Validation/);

    stdout = "";
    stderr = "";
    code = run([
      "--lock", lockPath,
      "--flake", flakePath,
      "--output", outputPath,
      "--repo", "rabesss/codex-linux",
      "--check",
    ], {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });

    assert.equal(code, 0, stderr);
    assert.match(stdout, /Support document is current/);

    fs.appendFileSync(outputPath, "\nstale\n", "utf8");
    stderr = "";
    code = run([
      "--lock", lockPath,
      "--flake", flakePath,
      "--output", outputPath,
      "--repo", "rabesss/codex-linux",
      "--check",
    ], {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /is stale/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readFlakePins extracts the Nix app, DMG, CLI, and Electron pins", () => {
  const root = tempDir();
  try {
    const flakePath = path.join(root, "flake.nix");
    fs.writeFileSync(flakePath, [
      "codexDmg = pkgs.fetchurl {",
      "  url = \"https://persistent.oaistatic.com/codex-app-prod/Codex.dmg\";",
      "  hash = \"sha256-S7VSvxwZBL1m4oTTScRYKcWREORuSDLF1ps++vkQIT8=\";",
      "};",
      "codexVersion = \"26.616.81150\";",
      "codexCliVersion = \"0.141.0\";",
      "electronVersion = \"42.1.0\";",
      "",
    ].join("\n"), "utf8");

    assert.deepEqual(readFlakePins(flakePath), {
      codexVersion: "26.616.81150",
      codexDmgHash: "sha256-S7VSvxwZBL1m4oTTScRYKcWREORuSDLF1ps++vkQIT8=",
      codexCliVersion: "0.141.0",
      electronVersion: "42.1.0",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renderSummary is concise enough for a GitHub step summary", () => {
  const summary = renderSummary({ lock: lock(), repository: "rabesss/codex-linux" });

  assert.match(summary, /Approved upstream app/);
  assert.match(summary, /Candidate in lock: `none`/);
  assert.match(summary, /SUPPORTED\.md/);
});
