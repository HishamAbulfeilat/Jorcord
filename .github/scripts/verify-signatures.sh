#!/usr/bin/env bash
# Fails the job when signing was configured but the produced installers are not validly signed.
# usage: verify-signatures.sh windows|macos <bundle dir>
set -uo pipefail
os=$1; dir=$2; bad=0
if [ "$os" = windows ]; then
  while IFS= read -r f; do
    st=$(F="$(cygpath -w "$f")" powershell -NoProfile -Command '(Get-AuthenticodeSignature $env:F).Status' | tr -d '\r')
    echo "$st  $f"; [ "$st" = Valid ] || bad=1
  done < <(find "$dir" -type f \( -name '*.msi' -o -name '*-setup.exe' \))
else
  while IFS= read -r app; do
    codesign --verify --deep --strict --verbose=2 "$app" || bad=1
    spctl -a -t exec -vv "$app" || bad=1
  done < <(find "$dir" -type d -name '*.app' -prune)
fi
exit $bad
