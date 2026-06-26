#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildIssueBody,
  failedPatchRows,
  issueTitleFor,
  run,
} = require("./write-upstream-drift-report.js");

const VALID_SHA = "b".repeat(64);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-drift-"));
}

function metadata(overrides = {}) {
  return {
    upstream_app_version: "26.623.31921",
    url: "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg",
    path: "/tmp/codex-upstream-ci/Codex.dmg",
    last_modified: "Fri, 26 Jun 2026 05:08:42 GMT",
    etag: "drift-etag",
    content_length: "42",
    sha256: VALID_SHA,
    size_bytes: "42",
    tested_at_utc: "2026-06-26T06:30:00Z",
    cache_schema_version: "v1",
    ...overrides,
  };
}

function patchReport() {
  return {
    generatedAt: "2026-06-26T06:29:00Z",
    target: "/tmp/codex-build/Codex.app/Contents/Resources/app/.vite/build/main.js",
    patches: [
      { name: "main-process-ui", status: "applied" },
      {
        name: "linux-fast-mode-model-guard",
        status: "failed-required",
        phase: "webview",
        targetSummary: "webview bundle",
        reason: "target marker not found",
      },
    ],
  };
}

test("failedPatchRows returns non-success patch records", () => {
  assert.deepEqual(failedPatchRows(patchReport()), [
    {
      name: "linux-fast-mode-model-guard",
      status: "failed-required",
      phase: "webview",
      target: "webview bundle",
      reason: "target marker not found",
    },
  ]);
});

test("buildIssueBody includes drift details, action, and no-payload boundary", () => {
  const body = buildIssueBody({
    metadata: metadata(),
    patchReport: patchReport(),
    validationLog: "Required patch validation failed\n/tmp/codex-build/private",
    env: {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "rabesss/codex-linux",
      GITHUB_RUN_ID: "123",
    },
  });

  assert.match(body, /Upstream Codex DMG Patch Drift/);
  assert.match(body, /26\.623\.31921/);
  assert.match(body, new RegExp(VALID_SHA));
  assert.match(body, /linux-fast-mode-model-guard/);
  assert.match(body, /No-Payload Boundary/);
  assert.match(body, /actions\/runs\/123/);
});

test("issueTitleFor uses the live DMG SHA prefix", () => {
  assert.equal(issueTitleFor(metadata()), "Upstream Codex DMG patch drift bbbbbbbbbbbb");
});

test("run writes sanitized drift artifacts and GitHub outputs", () => {
  const root = tempDir();
  try {
    const metadataPath = path.join(root, "upstream-dmg-metadata.json");
    const patchReportPath = path.join(root, "patch-report.json");
    const validationLogPath = path.join(root, "patch-validation.log");
    const outputDir = path.join(root, "out");
    const githubOutputPath = path.join(root, "github-output");
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata())}\n`, "utf8");
    fs.writeFileSync(patchReportPath, `${JSON.stringify(patchReport())}\n`, "utf8");
    fs.writeFileSync(validationLogPath, "Required patch validation failed at /tmp/codex-build/private\n", "utf8");

    let stderr = "";
    const code = run([
      "--metadata", metadataPath,
      "--patch-report", patchReportPath,
      "--validation-log", validationLogPath,
      "--metadata-out", path.join(outputDir, "upstream-dmg-metadata.json"),
      "--patch-report-out", path.join(outputDir, "patch-report.json"),
      "--validation-log-out", path.join(outputDir, "patch-validation.log"),
      "--issue-body", path.join(outputDir, "upstream-dmg-drift-issue.md"),
      "--private-path", "/tmp/codex-build",
      "--github-output", githubOutputPath,
    ], {
      env: {},
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });

    assert.equal(code, 0, stderr);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(outputDir, "upstream-dmg-metadata.json"), "utf8")), "path"), false);
    assert.doesNotMatch(fs.readFileSync(path.join(outputDir, "patch-report.json"), "utf8"), /\/tmp\/codex-build/);
    assert.doesNotMatch(fs.readFileSync(path.join(outputDir, "patch-validation.log"), "utf8"), /\/tmp\/codex-build/);
    assert.match(fs.readFileSync(path.join(outputDir, "upstream-dmg-drift-issue.md"), "utf8"), /metadata, logs, and patch reports only/);
    assert.match(fs.readFileSync(githubOutputPath, "utf8"), /issue_title=Upstream Codex DMG patch drift bbbbbbbbbbbb/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run rejects malformed drift metadata", () => {
  const root = tempDir();
  try {
    const metadataPath = path.join(root, "upstream-dmg-metadata.json");
    const patchReportPath = path.join(root, "patch-report.json");
    const validationLogPath = path.join(root, "patch-validation.log");
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata({ sha256: "not-a-sha" }))}\n`, "utf8");
    fs.writeFileSync(patchReportPath, `${JSON.stringify(patchReport())}\n`, "utf8");
    fs.writeFileSync(validationLogPath, "failed\n", "utf8");

    let stderr = "";
    const code = run([
      "--metadata", metadataPath,
      "--patch-report", patchReportPath,
      "--validation-log", validationLogPath,
      "--metadata-out", path.join(root, "metadata-out.json"),
      "--patch-report-out", path.join(root, "patch-report-out.json"),
      "--validation-log-out", path.join(root, "log-out.log"),
      "--issue-body", path.join(root, "issue.md"),
    ], {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /sha256/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
