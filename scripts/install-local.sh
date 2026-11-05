#!/usr/bin/env bash
#
# Builds EO and replaces the AppImage you launch from your desktop.
#
# The manual version of this is four commands, and the fourth one is the
# one worth getting right: the new file is written beside the old one and
# then *renamed* over it, never copied over it in place. A rename swaps
# the directory entry and leaves the old inode alone, so an EO that is
# open right now keeps running from the file it started with instead of
# having its bytes changed underneath it. Copying over a mounted AppImage
# is how you get a running app that dies at the next page fault.
#
# Linux only, by nature: an AppImage is what `pnpm dev` is not — the
# actual packaged app, with its own userData, its own migrations, and the
# native modules rebuilt for Electron rather than for Node.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RELEASE_DIR="$REPO_ROOT/apps/desktop/release"
DEST="${EO_APPIMAGE:-$HOME/.local/bin/EO.AppImage}"
RUN_CHECKS=0

usage() {
  cat <<'USAGE'
Usage: scripts/install-local.sh [options]

Builds the desktop app, packages it as an AppImage, and installs it over
the one your desktop entry points at.

Options:
  --check         Run typecheck, lint and tests first, and stop if any fail.
  --dest PATH     Install somewhere other than ~/.local/bin/EO.AppImage.
                  (Also settable as $EO_APPIMAGE.)
  -h, --help      Show this.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) RUN_CHECKS=1; shift ;;
    --dest) DEST="${2:?--dest needs a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "This installs an AppImage, which is Linux only. On macOS or Windows, run 'pnpm --filter @eo/desktop release' and install the artifact it produces."
command -v pnpm >/dev/null || die "pnpm is not on PATH."

cd "$REPO_ROOT"

if [[ "$RUN_CHECKS" == 1 ]]; then
  say "Checking (typecheck, lint, test)"
  pnpm typecheck
  pnpm lint
  pnpm test
fi

say "Building"
pnpm build

# --publish never: this is a local install, and electron-builder will
# happily try to upload a GitHub release if it thinks it should.
say "Packaging the AppImage"
pnpm --filter @eo/desktop exec electron-builder --linux AppImage --publish never

# Globbed rather than spelled out, so a version bump in package.json does
# not silently install yesterday's build.
mapfile -t built < <(find "$RELEASE_DIR" -maxdepth 1 -name '*.AppImage' -newermt '-1 hour' -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
[[ ${#built[@]} -gt 0 ]] || die "No AppImage was produced in $RELEASE_DIR."
readonly ARTIFACT="${built[0]}"

# Only a warning: the rename below is safe while EO is open. It just
# means the copy still running is the old one.
if pgrep -f "^${DEST}" >/dev/null 2>&1; then
  printf '\033[33mnote:\033[0m EO is running. The swap is safe, but quit and reopen it to pick this build up.\n'
fi

say "Installing to $DEST"
mkdir -p "$(dirname "$DEST")"
# Staged in the destination directory on purpose: mv is only atomic
# within one filesystem, and /tmp is often a different one.
readonly STAGED="$DEST.new-$$"
trap 'rm -f "$STAGED"' EXIT
cp "$ARTIFACT" "$STAGED"
chmod +x "$STAGED"
mv "$STAGED" "$DEST"
trap - EXIT

cmp -s "$ARTIFACT" "$DEST" || die "Installed file does not match what was built — something else wrote to $DEST."

printf '\n\033[32mInstalled\033[0m %s\n' "$(basename "$ARTIFACT")"
printf '  from  %s\n' "$ARTIFACT"
printf '  to    %s  (%s)\n' "$DEST" "$(du -h "$DEST" | cut -f1)"
printf '  built %s\n' "$(git -C "$REPO_ROOT" log -1 --format='%h %s' 2>/dev/null || echo 'not a git checkout')"

# Said only when it is missing: this script updates an install, it does
# not create the menu entry, and the difference matters the first time.
if ! grep -rqs "^Exec=.*$(basename "$DEST")" "$HOME/.local/share/applications" /usr/share/applications 2>/dev/null; then
  printf '\n\033[33mnote:\033[0m nothing in your applications menu points at %s yet.\n' "$DEST"
  printf '      Run it once from a terminal, or create a .desktop entry with Exec=%s\n' "$DEST"
fi
