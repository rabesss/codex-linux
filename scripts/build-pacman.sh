#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$REPO_DIR/scripts/lib/package-common.sh"
APP_DIR="${APP_DIR_OVERRIDE:-$REPO_DIR/codex-app}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
PKGBUILD_TEMPLATE="$REPO_DIR/packaging/linux/PKGBUILD.template"
INSTALL_HOOKS="$REPO_DIR/packaging/linux/codex-desktop.install"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.desktop"
SERVICE_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.service"
USER_SERVICE_HELPER_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager-user-service.sh"
ICON_SOURCE="$REPO_DIR/assets/codex.png"
PACKAGED_RUNTIME_TEMPLATE="$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"

PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"
MAX_BUILD_THREADS="${MAX_BUILD_THREADS:-0}"
UPDATER_BINARY_SOURCE="${UPDATER_BINARY_SOURCE:-$REPO_DIR/target/release/codex-update-manager}"
UPDATER_SERVICE_SOURCE="${UPDATER_SERVICE_SOURCE:-$SERVICE_TEMPLATE}"
PACKAGED_RUNTIME_SOURCE="${PACKAGED_RUNTIME_SOURCE:-$PACKAGED_RUNTIME_TEMPLATE}"

validate_max_build_threads() {
	case "$MAX_BUILD_THREADS" in
	""|*[!0-9]*)
		error "MAX_BUILD_THREADS must be 0 or a positive integer"
		;;
	esac
}

map_arch() {
	case "$(uname -m)" in
	x86_64) echo "x86_64" ;;
	aarch64) echo "aarch64" ;;
	*) error "Unsupported architecture: $(uname -m)" ;;
	esac
}

# Arch pkgver may contain '+', so keep the caller-provided commit-like suffix in
# pkgver. pkgrel is reserved for distro/package rebuilds of the same upstream
# app version.
pacman_version_parts() {
	PACMAN_PKGVER="$PACKAGE_VERSION"
	PACMAN_PKGREL="1"
}

write_threaded_makepkg_config() {
	local target="$1"
	local home_dir="${HOME:-}"
	local xdg_config_home="${XDG_CONFIG_HOME:-}"
	local user_makepkg_conf=""
	local append_config_file

	if [ -z "$xdg_config_home" ] && [ -n "$home_dir" ]; then
		xdg_config_home="$home_dir/.config"
	fi
	if [ -n "$xdg_config_home" ] && [ -r "$xdg_config_home/pacman/makepkg.conf" ]; then
		user_makepkg_conf="$xdg_config_home/pacman/makepkg.conf"
	elif [ -n "$home_dir" ] && [ -r "$home_dir/.makepkg.conf" ]; then
		user_makepkg_conf="$home_dir/.makepkg.conf"
	fi

	append_config_file() {
		local source_path="$1"
		[ -r "$source_path" ] || return 0
		printf '\n# Begin %s\n' "$source_path"
		cat "$source_path"
		printf '\n# End %s\n' "$source_path"
	}

	{
		if [ -n "${MAKEPKG_CONF:-}" ]; then
			[ -r "$MAKEPKG_CONF" ] || error "MAKEPKG_CONF is not readable: $MAKEPKG_CONF"
			append_config_file "$MAKEPKG_CONF"
		else
			append_config_file /etc/makepkg.conf
			local system_makepkg_conf
			for system_makepkg_conf in /etc/makepkg.conf.d/*.conf; do
				append_config_file "$system_makepkg_conf"
			done
			[ -n "$user_makepkg_conf" ] && append_config_file "$user_makepkg_conf"
		fi
		printf 'PKGDEST=%q\n' "$DIST_DIR"
		if [ "$MAX_BUILD_THREADS" != "0" ]; then
			printf 'MAKEFLAGS="${MAKEFLAGS:+$MAKEFLAGS }-j%s"\n' "$MAX_BUILD_THREADS"
			printf 'COMPRESSZST=(zstd -c -z -T%s -)\n' "$MAX_BUILD_THREADS"
		fi
	} >"$target"
}

main() {
	validate_max_build_threads

	ensure_app_layout
	ensure_file_exists "$PKGBUILD_TEMPLATE" "PKGBUILD template"
	ensure_file_exists "$DESKTOP_TEMPLATE" "desktop template"
	ensure_file_exists "$ICON_SOURCE" "icon"
	if package_with_updater_enabled; then
		ensure_file_exists "$INSTALL_HOOKS" "install hooks"
		ensure_file_exists "$UPDATER_SERVICE_SOURCE" "updater service template"
		ensure_file_exists "$USER_SERVICE_HELPER_TEMPLATE" "updater user service helper"
		ensure_file_exists "$PACKAGED_RUNTIME_SOURCE" "packaged launcher runtime helper"
	else
		info "Building package without codex-update-manager (PACKAGE_WITH_UPDATER=0)"
	fi
	command -v makepkg >/dev/null 2>&1 || error "makepkg is required (part of pacman)"

	if [ "$(id -u)" -eq 0 ]; then
		error "makepkg cannot run as root. Run this script as a regular user."
	fi

	ensure_updater_binary

	local arch
	arch="$(map_arch)"
	pacman_version_parts

	local build_root
	build_root="$(mktemp -d)"
	# shellcheck disable=SC2064
	if [ "${KEEP_PACMAN_BUILD_ROOT:-0}" = "1" ]; then
		trap "printf '%s\n' 'Preserved pacman build root: $build_root'" EXIT
	else
		trap "rm -rf '$build_root'" EXIT
	fi

	local staging_root="$build_root/staging"
	local makepkg_config="$build_root/makepkg.conf"
	write_threaded_makepkg_config "$makepkg_config"

	if [ "$MAX_BUILD_THREADS" != "0" ]; then
		info "Pacman package build/compression threads: $MAX_BUILD_THREADS"
	fi

	stage_common_package_files "$staging_root"
	stage_optional_update_builder_bundle "$staging_root"
	write_launcher_stub "$staging_root"
	run_linux_feature_package_hooks "$staging_root" "pacman"
	normalize_package_payload_permissions "$staging_root"
	restore_linux_feature_payload_permissions "$staging_root"

	local package_name
	local pacman_pkgver
	local pacman_pkgrel
	local staging_dir
	local arch_replacement
	package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
	pacman_pkgver="$(sed_escape_replacement "$PACMAN_PKGVER")"
	pacman_pkgrel="$(sed_escape_replacement "$PACMAN_PKGREL")"
	staging_dir="$(sed_escape_replacement "$staging_root")"
	arch_replacement="$(sed_escape_replacement "$arch")"

	sed \
		-e "s/__PACKAGE_NAME__/$package_name/g" \
		-e "s/__PKGVER__/$pacman_pkgver/g" \
		-e "s/__PKGREL__/$pacman_pkgrel/g" \
		-e "s|__STAGING_DIR__|$staging_dir|g" \
		-e "s/__ARCH__/$arch_replacement/g" \
		"$PKGBUILD_TEMPLATE" >"$build_root/PKGBUILD"
	if package_with_updater_enabled; then
		sed -e "s|/opt/codex-desktop|/opt/$PACKAGE_NAME|g" \
			-e "s|codex_desktop_repair_system_package_shadow_entries codex-desktop|codex_desktop_repair_system_package_shadow_entries $PACKAGE_NAME|g" \
			"$INSTALL_HOOKS" >"$build_root/${PACKAGE_NAME}.install"
	else
		write_no_updater_pacman_install_hooks "$build_root/${PACKAGE_NAME}.install"
		sed -i \
			-e "/'polkit'/d" \
			"$build_root/PKGBUILD"
	fi

	mkdir -p "$DIST_DIR"
	info "Building ${PACKAGE_NAME}-${PACMAN_PKGVER}-${PACMAN_PKGREL}-${arch}.pkg.tar.zst"

	find_built_package() {
		local found=""
		found="$(find "$DIST_DIR" \( -name "${PACKAGE_NAME}-${PACMAN_PKGVER}-*.pkg.tar.zst" \
			-o -name "${PACKAGE_NAME}-${PACMAN_PKGVER}-*.pkg.tar.xz" \) \
			-print -quit 2>/dev/null || true)"
		if [ -z "$found" ]; then
			found="$(find "$build_root" -maxdepth 1 \( -name "${PACKAGE_NAME}-${PACMAN_PKGVER}-*.pkg.tar.zst" \
				-o -name "${PACKAGE_NAME}-${PACMAN_PKGVER}-*.pkg.tar.xz" \) \
				-print -quit 2>/dev/null || true)"
			if [ -n "$found" ]; then
				cp "$found" "$DIST_DIR/"
				found="$DIST_DIR/$(basename "$found")"
			fi
		fi
		printf '%s\n' "$found"
	}

	# Build the package; --nodeps skips dependency checks at build time (they
	# are enforced by pacman at install time), and --skipinteg is needed
	# because we have no remote sources to verify.
	(cd "$build_root" && MAKEPKG_CONF="$makepkg_config" makepkg -f --nodeps --skipinteg 2>&1) >&2

	local pkg_file=""
	pkg_file="$(find_built_package)"
	if [ -z "$pkg_file" ]; then
		local makepkg_path
		local makepkg_trace_log="$build_root/makepkg-xtrace.log"
		makepkg_path="$(command -v makepkg)"
		info "makepkg returned without a package; retrying with bash xtrace workaround"
		(cd "$build_root" && MAKEPKG_CONF="$makepkg_config" BASH_XTRACEFD=9 PS4='' \
			bash -x "$makepkg_path" -f --nodeps --skipinteg 9>"$makepkg_trace_log" 2>&1) >&2
		pkg_file="$(find_built_package)"
	fi
	[ -f "$pkg_file" ] || error "makepkg did not produce a package"

	ln -sfn "$(basename "$pkg_file")" "$DIST_DIR/${PACKAGE_NAME}-latest.pkg.tar.zst"

	info "Built package: $pkg_file"
	printf '%s\n' "$pkg_file"
}

main "$@"
