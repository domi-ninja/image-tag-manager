#!/usr/bin/env bash
set -euo pipefail

# Install a self-contained release for the current user, preserving their library and models.
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
build=true
case "${1:-}" in
  '') ;;
  --no-build) build=false ;;
  --help|-h)
    printf 'Usage: %s [--no-build]\nInstalls Image Tag Manager for the current user in ~/.local.\nUse --no-build to install the existing release binary and runtime.\n' "$0"
    exit 0 ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
esac
[[ $(uname -s) == Linux ]] || { echo 'This installer requires Linux.' >&2; exit 1; }
[[ $EUID != 0 ]] || { echo 'Run this as your desktop user, without sudo.' >&2; exit 1; }

if "$build"; then
  command -v pnpm >/dev/null || { echo 'Install pnpm and the build prerequisites documented in README.md.' >&2; exit 1; }
  cd -- "$repo_dir"
  pnpm install --frozen-lockfile
  [[ -x src-tauri/runtime/llama-server ]] || pnpm prepare:runtime
  pnpm tauri build --no-bundle
fi

binary="$repo_dir/src-tauri/target/release/image-tag-manager"
runtime="$repo_dir/src-tauri/runtime"
[[ -x "$binary" && -x "$runtime/llama-server" ]] || {
  echo 'Release binary or model runtime missing. Run this script without --no-build.' >&2; exit 1;
}
missing=$(ldd "$binary" | awk '/not found/ {print $1}')
[[ -z "$missing" ]] || {
  printf 'Install the missing system libraries before retrying:\n%s\n' "$missing" >&2; exit 1;
}

data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
install_root="$data_dir/image-tag-manager-desktop"
bin_dir="$HOME/.local/bin"
applications="$data_dir/applications"
mkdir -p -- "$install_root" "$bin_dir" "$applications"
staging=$(mktemp -d "$install_root/.install.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
mkdir -p -- "$staging/app/bin" "$staging/app/lib/Image Tag Manager/runtime"
install -m 755 "$binary" "$staging/app/bin/image-tag-manager"
cp -a -- "$runtime/." "$staging/app/lib/Image Tag Manager/runtime/"

# Tauri resolves resources relative to the installed binary's ../lib/Image Tag Manager directory.
if [[ -e "$install_root/app" ]]; then
  mv -- "$install_root/app" "$staging/previous"
fi
if ! mv -- "$staging/app" "$install_root/app"; then
  [[ ! -e "$staging/previous" ]] || mv -- "$staging/previous" "$install_root/app"
  exit 1
fi
ln -sfn -- "$install_root/app/bin/image-tag-manager" "$bin_dir/image-tag-manager"
for size in 32 128; do
  icon_dir="$data_dir/icons/hicolor/${size}x${size}/apps"
  mkdir -p -- "$icon_dir"
  install -m 644 "$repo_dir/src-tauri/icons/${size}x${size}.png" "$icon_dir/image-tag-manager.png"
done

# Desktop Exec uses its own quoting rules, including doubled literal percent signs.
exec_path="$bin_dir/image-tag-manager"
exec_path=${exec_path//\\/\\\\\\\\}
exec_path=${exec_path//\"/\\\\\"}
exec_path=${exec_path//\$/\\\\\$}
exec_path=${exec_path//\`/\\\\\`}
exec_path=${exec_path//%/%%}
cat > "$staging/image-tag-manager.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Image Tag Manager
Comment=Browse and tag your local image library
Exec="$exec_path"
Icon=image-tag-manager
Terminal=false
Categories=Graphics;Photography;
Keywords=images;photos;tags;classification;
StartupNotify=true
StartupWMClass=image-tag-manager
DESKTOP
if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$staging/image-tag-manager.desktop"
fi
install -m 644 "$staging/image-tag-manager.desktop" "$applications/image-tag-manager.desktop"
# Replace the previous app-menu entry while preserving existing launch shortcuts.
if [[ -f "$applications/image-shelf.desktop" ]] && grep -qx 'Name=Image Shelf' "$applications/image-shelf.desktop"; then
  rm -- "$applications/image-shelf.desktop"
fi
if [[ -L "$bin_dir/image-shelf" ]]; then
  ln -sfn -- "$install_root/app/bin/image-tag-manager" "$bin_dir/image-shelf"
fi
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$applications"
fi
if command -v gtk-update-icon-cache >/dev/null && [[ -f "$data_dir/icons/hicolor/index.theme" ]]; then
  gtk-update-icon-cache -f -t "$data_dir/icons/hicolor"
fi
printf 'Installed Image Tag Manager. Open it from your application menu or run:\n  %s\nDesktop entry: %s\n' "$bin_dir/image-tag-manager" "$applications/image-tag-manager.desktop"
