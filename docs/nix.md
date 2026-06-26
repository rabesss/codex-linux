# Nix

Run Codex Desktop for Linux directly with:

```bash
nix run github:rabesss/codex-linux
```

The flake handles dependencies and patches Electron for NixOS. Ordinary
push/pull-request CI validates committed Nix metadata and flake evaluation
without downloading the mutable live `Codex.dmg`. Full Nix package-output
refreshes run in a dedicated workflow after the upstream DMG watcher succeeds or
when a maintainer starts it manually.

For local CI parity, run:

```bash
./scripts/ci-local.sh nix
```

That target performs the same static metadata validation and flake evaluation
as normal GitHub CI. To explicitly build the package outputs locally, opt in:

```bash
CI_NIX_BUILD_OUTPUTS=1 ./scripts/ci-local.sh nix
```

If you hit a hash mismatch right after an upstream release, the live DMG has
probably moved before the Nix refresh workflow updated the committed hash. Check
the upstream watcher and Nix refresh workflow status, then retry after the
refresh PR lands.

## Codex CLI Requirement

Codex Desktop still needs the Codex CLI at runtime. The Nix package in this
repository does not install or maintain the CLI for you; it only needs a
working `codex` binary. Put `codex` on your user `PATH`, or set
`CODEX_CLI_PATH` to the exact binary that Codex Desktop should launch.

One direct upstream install path is the npm package:

```bash
npm i -g @openai/codex
```

### Community Nix CLI Packages

If you want a Nix-native CLI setup, one community-maintained option is the
`sadjow/codex-cli-nix` flake. It is not part of this repository and is not
maintained by this project or by OpenAI. We do not control its release cadence,
build recipe, binary cache, or support policy.

Use it only if that trade-off makes sense for your configuration. Pin it to a
tag or commit for reproducibility, review the flake and cache trust settings
before using them, and report package/cache-specific issues to that project.
Issues in this repository should be limited to Codex Desktop discovering and
launching a working CLI binary.

The community flake exposes Nix packages for the native binary and Node.js
builds:

```bash
nix run github:sadjow/codex-cli-nix/main
```

For a declarative setup, add the CLI flake as an input:

```nix
{
  inputs.codex-cli-nix = {
    # Default branch is `main` on GitHub, not `master`.
    url = "github:sadjow/codex-cli-nix/main";
    inputs = {
      nixpkgs.follows = "nixpkgs";
      flake-utils.follows = "flake-utils";
    };
  };
}
```

The flake also publishes a third-party Cachix cache for prebuilt binaries. This
cache is independent from this repository's `codex-desktop-linux` cache. Enabling
it means trusting substitutes signed by that cache key; omit this step if you
prefer local builds.

```bash
cachix use codex-cli
```

For a declarative NixOS cache configuration:

```nix
{
  nix.settings = {
    substituters = [ "https://codex-cli.cachix.org" ];
    trusted-public-keys = [
      "codex-cli.cachix.org-1:1Br3H1hHoRYG22n//cGKJOk3cQXgYobUel6O8DgSing="
    ];
  };
}
```

Then install its package next to Codex Desktop from Home Manager:

```nix
{ inputs, pkgs, ... }:
let
  codexCli = inputs.codex-cli-nix.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  home.packages = [
    codexCli
  ];

  programs.codexDesktopLinux.enable = true;
}
```

For a NixOS module, use the same package in `environment.systemPackages`
instead of `home.packages`.

Pinning `github:sadjow/codex-cli-nix` to a release tag or commit is
recommended for fully reproducible configurations.

If your graphical session does not put the selected profile on `PATH`, set
`CODEX_CLI_PATH` to the Nix-built CLI binary:

```nix
{
  home.sessionVariables.CODEX_CLI_PATH = "${codexCli}/bin/codex";
}
```

If `nix run` appears to do nothing, check the launcher log first:

```bash
sed -n '1,220p' ~/.cache/codex-desktop/launcher.log
```

## Feature Outputs

Flakes do not include the git-ignored `linux-features/features.json` opt-in
file. The maintained Nix variant only exposes the Computer Use UI build:

```bash
nix run github:rabesss/codex-linux#codex-desktop-computer-use-ui
```

## Home Manager / NixOS Module

For a declarative install:

```nix
{
  imports = [
    inputs.codex-linux.homeManagerModules.default
  ];

  programs.codexDesktopLinux = {
    enable = true;
    computerUseUi.enable = true;
  };
}
```

This installs the selected Codex Desktop package variant and starts a user
`codex-remote-control.service` with:

```text
codex app-server --remote-control --listen unix://
```

A `nixosModules.default` export is also available for system-level
configurations that prefer a global user unit.

## Development Shell

```bash
nix develop github:rabesss/codex-linux
```

## Cachix

CI can populate a Cachix cache named `codex-desktop-linux` for flake package
outputs. Cache population is manual because it builds fixed-output app payloads
from committed Nix pins and should not fail ordinary branch pushes when the
upstream DMG moves. To push to the cache, create it in Cachix and add a
repository secret named `CACHIX_AUTH_TOKEN` with write access.

Users can opt in locally with:

```bash
cachix use codex-desktop-linux
```

The `Populate Cachix` workflow builds the default package, feature-specific
package variants, and `.#installer` when started manually.
