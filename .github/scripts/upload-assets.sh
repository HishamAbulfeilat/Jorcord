#!/usr/bin/env bash
# Usage: upload-assets.sh <release-id> <file>...   (needs GH_TOKEN, GITHUB_REPOSITORY). Works on draft releases.
set -euo pipefail
id="$1"; shift
for f in "$@"; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  for try in 1 2 3; do
    if gh api --method POST -H "Content-Type: application/octet-stream" \
        "https://uploads.github.com/repos/$GITHUB_REPOSITORY/releases/$id/assets?name=$name" --input "$f" > /dev/null; then
      echo "uploaded $name"; break
    fi
    [ "$try" = 3 ] && { echo "::error::upload of $name failed"; exit 1; }
    sleep 10
  done
done
