#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  redactPrivatePaths,
  sanitizePatchReport,
  sanitizedMetadataForArtifact,
  validateMetadata,
} = require("./write-upstream-candidate-report.js");

function usage() {
  return [
    "Usage: write-upstream-drift-report.js",
    "--metadata upstream-dmg-metadata.json",
    "--patch-report patch-report.json",
    "--validation-log patch-validation.log",
    "--metadata-out upstream-dmg-metadata.json",
    "--patch-report-out patch-report.json",
    "--validation-log-out patch-validation.log",
    "--issue-body upstream-dmg-drift-issue.md",
    "[--github-output $GITHUB_OUTPUT]",
    "[--private-path /runner/private/path]",
  ].join(" ");
}

function parseArgs(argv) {
  const options = {
    githubOutput: null,
    privatePath: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (!arg.startsWith("--")) {
      throw new Error(usage());
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(usage());
    }
    if (key === "privatePath") {
      options.privatePath.push(value);
    } else {
      options[key] = value;
    }
    index += 1;
  }

  for (const key of [
    "metadata",
    "patchReport",
    "validationLog",
    "metadataOut",
    "patchReportOut",
    "validationLogOut",
    "issueBody",
  ]) {
    if (!options[key]) {
      throw new Error(usage());
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function markdownValue(value) {
  if (value == null || value === "") {
    return "n/a";
  }
  return String(value).replace(/\|/g, "\\|");
}

function failedPatchRows(report) {
  return (report.patches ?? [])
    .filter((patch) => patch.status !== "applied" && patch.status !== "already-applied")
    .map((patch) => ({
      name: patch.name ?? "unknown",
      status: patch.status ?? "unknown",
      phase: patch.phase ?? "unknown",
      target: patch.targetSummary ?? "unknown",
      reason: patch.reason ?? "no reason recorded",
    }));
}

function issueTitleFor(metadata) {
  const upstream = validateMetadata(metadata);
  return `Upstream Codex DMG patch drift ${upstream.sha256.slice(0, 12)}`;
}

function workflowRunLink(env = process.env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `[${env.GITHUB_RUN_ID}](${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID})`;
  }
  return "n/a";
}

function buildIssueBody({ metadata, patchReport, validationLog, env = process.env }) {
  const upstream = validateMetadata(metadata);
  const failed = failedPatchRows(patchReport);
  const failureLines = failed.length === 0
    ? ["- Patch validation failed, but no non-success patch records were found in the patch report. Check the validation log for missing required patch names."]
    : failed.map((patch) => `- \`${patch.name}\` \`${patch.status}\` (${patch.phase}, ${patch.target}): ${patch.reason}`);

  return [
    "## Upstream Codex DMG Patch Drift",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| DMG URL | \`${markdownValue(upstream.url)}\` |`,
    `| App version | \`${upstream.upstream_app_version}\` |`,
    `| SHA-256 | \`${upstream.sha256}\` |`,
    `| Size | \`${upstream.size_bytes}\` bytes |`,
    `| Last-Modified | \`${markdownValue(upstream.last_modified)}\` |`,
    `| ETag | \`${markdownValue(upstream.etag)}\` |`,
    `| Workflow run | ${workflowRunLink(env)} |`,
    "",
    "## Required Patch Failures",
    "",
    failureLines.join("\n"),
    "",
    "## Validation Log",
    "",
    "```text",
    validationLog.trim().slice(0, 6000),
    "```",
    "",
    "## Maintainer Action",
    "",
    "- Update semantic patch detectors or target patterns so required patches prove the Linux behavior is still protected.",
    "- If upstream has incorporated the Linux behavior, make the descriptor detect that state as already applied instead of failing.",
    "- Do not promote this DMG until patch validation passes and local dogfood is complete.",
    "",
    "## No-Payload Boundary",
    "",
    "This record contains metadata, logs, and patch reports only. It does not upload the upstream DMG, extracted app, generated `codex-app`, or package payload.",
    "",
  ].join("\n");
}

function appendGitHubOutput(filePath, outputs) {
  if (!filePath) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`);
  fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function run(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;

  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }

    const metadata = readJson(args.metadata);
    const patchReport = sanitizePatchReport(readJson(args.patchReport), args.privatePath);
    const validationLog = redactPrivatePaths(fs.readFileSync(args.validationLog, "utf8"), args.privatePath);
    const metadataForArtifact = sanitizedMetadataForArtifact(metadata);
    const issueBody = buildIssueBody({
      metadata,
      patchReport,
      validationLog,
      env,
    });
    const title = issueTitleFor(metadata);

    writeJson(args.metadataOut, metadataForArtifact);
    writeJson(args.patchReportOut, patchReport);
    writeText(args.validationLogOut, validationLog);
    writeText(args.issueBody, issueBody);
    appendGitHubOutput(args.githubOutput, {
      issue_title: title,
      drift_sha256: metadataForArtifact.sha256,
      drift_sha_short: metadataForArtifact.sha256.slice(0, 12),
      drift_issue_body: args.issueBody,
    });

    stdout.write(`Wrote upstream drift report: ${args.issueBody}\n`);
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
  buildIssueBody,
  failedPatchRows,
  issueTitleFor,
  parseArgs,
  run,
};
