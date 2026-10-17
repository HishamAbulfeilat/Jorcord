#!/usr/bin/env bash
# Usage: make-updater-manifest.sh <version> <dir-with-release-assets>   -> prints the Tauri updater manifest (latest.json) on stdout.
# Needs GITHUB_REPOSITORY and jq. A platform is listed only when its updater bundle AND its .sig exist (the .sig files only exist when the
# TAURI_SIGNING_PRIVATE_KEY secret was set); with none at all this prints nothing and the caller skips latest.json.
set -euo pipefail
V="$1"; D="$2"
BASE="https://github.com/${GITHUB_REPOSITORY}/releases/download/v${V}"
platforms='{}'
add() { # <tauri platform key> <asset glob>
  local f; f=$(find "$D" -maxdepth 1 -type f -name "$2" | sort | head -1)
  if [ -z "$f" ] || [ ! -f "$f.sig" ]; then echo "::warning::no signed updater bundle for $1" >&2; return 0; fi
  platforms=$(jq -c --arg k "$1" --arg u "$BASE/$(basename "$f")" --rawfile s "$f.sig" '. + {($k): {signature: ($s | rtrimstr("\n")), url: $u}}' <<<"$platforms")
}
add windows-x86_64 '*-setup.exe'
add linux-x86_64 '*.AppImage'
add darwin-aarch64 '*macos-arm64.app.tar.gz'
add darwin-x86_64 '*macos-x64.app.tar.gz'
[ "$platforms" != '{}' ] || exit 0
jq -n --arg v "$V" --arg d "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson p "$platforms" '{version: $v, notes: ("Jorcord " + $v), pub_date: $d, platforms: $p}'
