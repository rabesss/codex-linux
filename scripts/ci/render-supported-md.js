#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { validateLock } = require("./validate-upstream-dmg-lock.js");

const DEFAULT_REPO_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_LOCK_PATH = path.join(DEFAULT_REPO_DIR, "release", "upstream-dmg-lock.json");
const DEFAULT_FLAKE_PATH = path.join(DEFAULT_REPO_DIR, "flake.nix");
const DEFAULT_OUTPUT_PATH = path.join(DEFAULT_REPO_DIR, "SUPPORTED.md");
const DEFAULT_REPOSITORY = "rabesss/codex-linux";

const WORKFLOWS = [
  {
    label: "CI",
    file: "ci.yml",
    validates: "Rust, smoke tests, Debian/RPM/pacman fixture packages, and Nix metadata/evaluation",
  },
  {
    label: "Upstream DMG Watcher",
    file: "upstream-build-app.yml",
    validates: "Scheduled/manual live upstream DMG patch/build validation and metadata-only candidate or drift reports",
  },
  {
    label: "Install Dependencies",
    file: "install-deps.yml",
    validates: "Dependency bootstrap behavior on supported apt images",
  },
  {
    label: "Populate Cachix",
    file: "cachix.yml",
    validates: "Manual Nix cache population when repository secrets are configured",
  },
];

function usage() {
  return [
    "Usage: render-supported-md.js [options]",
    "",
    "Options:",
    "  --lock <path>         Upstream DMG lock JSON (default: release/upstream-dmg-lock.json)",
    "  --flake <path>        flake.nix path for Nix package pins (default: flake.nix)",
    "  --output <path>       SUPPORTED.md output path (default: SUPPORTED.md)",
    "  --repo <owner/name>   GitHub repository for badges (default: rabesss/codex-linux)",
    "  --summary-out <path>  Append a short support summary for GitHub step summaries",
    "  --check               Fail when output is stale instead of writing it",
    "  --stdout             Print generated Markdown instead of writing it",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    lockPath: DEFAULT_LOCK_PATH,
    flakePath: DEFAULT_FLAKE_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    repository: process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
    summaryOut: null,
    check: false,
    stdout: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg === "--lock") {
      options.lockPath = argv[index + 1];
      if (!options.lockPath) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--flake") {
      options.flakePath = argv[index + 1];
      if (!options.flakePath) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--output") {
      options.outputPath = argv[index + 1];
      if (!options.outputPath) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--repo") {
      options.repository = argv[index + 1];
      if (!options.repository) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--summary-out") {
      options.summaryOut = argv[index + 1];
      if (!options.summaryOut) {
        throw new Error(usage());
      }
      index += 1;
    } else {
      throw new Error(usage());
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readFlakePins(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const source = fs.readFileSync(filePath, "utf8");
  const readString = (name) => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"\\s*;`, "u"));
    return match ? match[1] : null;
  };
  const dmgMatch = source.match(/codexDmg\s*=\s*pkgs[.]fetchurl\s*\{[\s\S]*?hash\s*=\s*"([^"]+)"\s*;/u);
  return {
    codexVersion: readString("codexVersion"),
    codexDmgHash: dmgMatch ? dmgMatch[1] : null,
    codexCliVersion: readString("codexCliVersion"),
    electronVersion: readString("electronVersion"),
  };
}

function shortSha(value, length = 12) {
  if (typeof value !== "string") {
    return "n/a";
  }
  return value.slice(0, length);
}

function markdownValue(value) {
  if (value == null || value === "") {
    return "n/a";
  }
  return String(value).replace(/\|/g, "\\|");
}

function workflowBadge(repository, workflowFile, label) {
  const safeLabel = encodeURIComponent(label);
  const safeWorkflow = encodeURIComponent(workflowFile);
  return `[![${label}](https://github.com/${repository}/actions/workflows/${safeWorkflow}/badge.svg?branch=main)](https://github.com/${repository}/actions/workflows/${safeWorkflow})`;
}

function renderWorkflowBadges(repository) {
  return WORKFLOWS.map((workflow) => workflowBadge(repository, workflow.file, workflow.label)).join("\n");
}

function renderCandidateRows(candidate) {
  if (candidate == null) {
    return [
      "| Candidate status | None recorded in the checked-in lock |",
      "| Candidate effect | No unapproved candidate is part of the default install path |",
    ];
  }

  return [
    `| Candidate status | ${markdownValue(candidate.ci_status)} |`,
    `| Candidate upstream app | \`${markdownValue(candidate.upstream_app_version)}\` |`,
    `| Candidate SHA-256 | \`${markdownValue(candidate.sha256)}\` |`,
    `| Candidate size | \`${markdownValue(candidate.size)}\` bytes |`,
    `| Candidate detected | \`${markdownValue(candidate.detected_at)}\` |`,
    `| Candidate workflow | ${candidate.workflow_run_url ? `[run](${candidate.workflow_run_url})` : "n/a"} |`,
    "| Candidate effect | Maintainer visibility only until promoted into `approved` |",
  ];
}

function renderNixPinsSection(nixPins) {
  if (!nixPins) {
    return [
      "## Nix Flake Pins",
      "",
      "Nix flake pin details were not available while generating this file.",
      "",
    ].join("\n");
  }

  return [
    "## Nix Flake Pins",
    "",
    "Nix packaging is a separate validation surface from the default updater approval lock. Ordinary push/PR CI validates committed Nix metadata and flake evaluation without downloading the mutable live `Codex.dmg`; full package-output refreshes belong to the upstream candidate/promotion lane.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Nix Codex app version | \`${markdownValue(nixPins.codexVersion)}\` |`,
    `| Nix Codex DMG SRI hash | \`${markdownValue(nixPins.codexDmgHash)}\` |`,
    `| Nix bundled Codex CLI | \`${markdownValue(nixPins.codexCliVersion)}\` |`,
    `| Nix Electron runtime | \`${markdownValue(nixPins.electronVersion)}\` |`,
    "",
  ].join("\n");
}

function renderSupportedMd({ lock, repository = DEFAULT_REPOSITORY, nixPins = null }) {
  const failures = validateLock(lock, { checkGit: false });
  if (failures.length > 0) {
    throw new Error(`Cannot render SUPPORTED.md from invalid upstream lock:\n- ${failures.join("\n- ")}`);
  }

  const approved = lock.approved;
  const candidateRows = renderCandidateRows(lock.candidate).join("\n");

  return `# Supported Versions And Validation

This file is generated by \`scripts/ci/render-supported-md.js\`. Update it with:

\`\`\`bash
make supported
\`\`\`

CI checks this file on every push and pull request. Scheduled/manual workflows own live upstream DMG drift and optional cache population. The badges below are live GitHub workflow status links for \`${repository}\`.

${renderWorkflowBadges(repository)}

## Current Support Contract

| Area | Supported | Not supported |
| --- | --- | --- |
| Upstream Codex app | The approved DMG pin listed below | Arbitrary latest DMGs, modified DMGs, or old pins not listed here |
| Linux wrapper | Current \`main\` plus reviewed commits reachable from the approved minimum wrapper commit | Random old commits or local patches not represented in CI |
| Public distribution | Source checkout, installer, metadata, hashes, and validation reports | Public packages containing the OpenAI DMG, extracted app, \`codex-app\`, or rebuilt app payload |
| Native package builders | Debian/Ubuntu \`.deb\`, Fedora/openSUSE \`.rpm\`, and Arch-family pacman package builder paths validated from fixtures in CI | Treating CI fixture packages as end-user release packages |
| Nix | Static metadata checks and flake evaluation from the Nix flake pins listed below | Treating live upstream DMG drift as an ordinary push/PR failure, or treating Nix pins as automatic updater approval |
| AppImage | Local self-build path and smoke coverage for the AppImage builder | Published AppImage payloads containing the upstream app |

## Approved Upstream App

| Field | Value |
| --- | --- |
| Upstream app version | \`${markdownValue(approved.upstream_app_version)}\` |
| DMG URL | \`${markdownValue(approved.dmg_url)}\` |
| SHA-256 | \`${markdownValue(approved.sha256)}\` |
| Size | \`${markdownValue(approved.size)}\` bytes |
| ETag | \`${markdownValue(approved.etag)}\` |
| Last-Modified | \`${markdownValue(approved.last_modified)}\` |
| Approved at | \`${markdownValue(approved.approved_at)}\` |
| Approved by | \`${markdownValue(approved.approved_by)}\` |
| Minimum wrapper commit | \`${markdownValue(approved.wrapper_min_commit)}\` |
| Patch report | \`${markdownValue(approved.patch_report)}\` |
| Notes | ${markdownValue(approved.notes)} |

## Candidate State

| Field | Value |
| --- | --- |
${candidateRows}

${renderNixPinsSection(nixPins)}
## What CI Proves

| Check | What it means |
| --- | --- |
| \`CI / Rust and Smoke Tests\` | Shell syntax, Rust formatting/lints/tests, script smoke tests, generated support docs, and metadata validators pass. |
| \`CI / Build Debian Package\` | A fixture app can be packaged as \`.deb\` and the package contains the updater, user service, update builder, approved DMG lock, and packaged runtime helper. |
| \`CI / Build RPM Package\` | A fixture app can be packaged as \`.rpm\` with the same required updater and update-builder contents. |
| \`CI / Build Pacman Package\` | A fixture app can be packaged inside an Arch container with the same required updater and update-builder contents. |
| \`CI / Nix Metadata\` | Committed Nix app, Electron, native-module, bundled CLI, and Browser Use runtime metadata is internally consistent, and the flake evaluates without building live fixed-output app payloads. |
| \`Upstream DMG Watcher\` | Scheduled/manual automation can download the live official DMG, patch/build it, validate required patch points, and upload metadata-only candidate evidence or patch-drift reports. |
| \`Install Dependencies\` | The dependency bootstrap script remains usable on the tested apt-based images. |

CI package jobs are validation jobs. They do not publish release packages for users.

## User Validation

Validate the checked-in support contract:

\`\`\`bash
node scripts/ci/validate-upstream-dmg-lock.js release/upstream-dmg-lock.json
node scripts/ci/render-supported-md.js --check
\`\`\`

Validate a downloaded DMG before building from it:

\`\`\`bash
sha256sum /path/to/Codex.dmg
node -e 'const lock=require("./release/upstream-dmg-lock.json"); console.log(lock.approved.sha256)'
make inspect-upstream DMG=/path/to/Codex.dmg
\`\`\`

Install from the supported local build path:

\`\`\`bash
make install-guided
\`\`\`

Users who already downloaded the official DMG can point the build at that file:

\`\`\`bash
make build-app DMG=/path/to/Codex.dmg
make package
make install
\`\`\`

## Version Policy

The default supported upstream app version is the approved pin above. A newer upstream DMG is a candidate until scheduled/manual watcher validation, local dogfood, and a reviewed promotion update the lock.

Older upstream app versions remain supported only when they are explicitly listed in this file or covered by a committed validation matrix. If OpenAI changes the internal DMG or app layout and the Linux patch set must move to a new structure, old-version support may be dropped unless maintaining it is low-risk and CI keeps testing it.

The Linux wrapper can support multiple upstream app pins only when the patch code is version-gated and every supported pin has automated validation evidence. Otherwise, support follows the current approved pin plus any documented rollback path.

## Artifact Boundary

Public CI artifacts and public releases may contain metadata, hashes, logs, patch reports, source code, and review records. They must not contain the OpenAI DMG, extracted \`.app\`, generated \`codex-app\`, AppImage payload, or native packages that include OpenAI application code.
`;
}

function renderSummary({ lock, repository }) {
  const approved = lock.approved;
  return [
    "## Supported Versions",
    "",
    `- Approved upstream app: \`${approved.upstream_app_version}\``,
    `- Approved DMG SHA-256: \`${approved.sha256}\``,
    `- Minimum wrapper commit: \`${shortSha(approved.wrapper_min_commit)}\``,
    `- Candidate in lock: \`${lock.candidate ? `${lock.candidate.upstream_app_version} ${shortSha(lock.candidate.sha256)}` : "none"}\``,
    `- Public distribution boundary: metadata and source only; no OpenAI app payload packages.`,
    `- Support doc: https://github.com/${repository}/blob/main/SUPPORTED.md`,
    "",
  ].join("\n");
}

function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing !== content) {
    fs.writeFileSync(filePath, content, "utf8");
  }
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

    const lock = readJson(options.lockPath);
    const nixPins = readFlakePins(options.flakePath);
    const content = renderSupportedMd({ lock, repository: options.repository, nixPins });

    if (options.stdout) {
      stdout.write(content);
    } else if (options.check) {
      const existing = fs.existsSync(options.outputPath) ? fs.readFileSync(options.outputPath, "utf8") : null;
      if (existing !== content) {
        stderr.write(`${options.outputPath} is stale. Run: node scripts/ci/render-supported-md.js --output ${options.outputPath}\n`);
        return 1;
      }
      stdout.write(`Support document is current: ${options.outputPath}\n`);
    } else {
      writeIfChanged(options.outputPath, content);
      stdout.write(`Wrote support document: ${options.outputPath}\n`);
    }

    if (options.summaryOut) {
      fs.appendFileSync(options.summaryOut, renderSummary({ lock, repository: options.repository }), "utf8");
    }

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
  WORKFLOWS,
  parseArgs,
  readFlakePins,
  renderSupportedMd,
  renderSummary,
  run,
};
