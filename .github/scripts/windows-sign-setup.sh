#!/usr/bin/env bash
# Prepares Windows Authenticode signing for `tauri build` (runs on the windows runner under bash).
# Two optional modes, picked by which secrets exist; with neither, nothing is signed:
#   1. PFX certificate:   WINDOWS_CERTIFICATE (base64 .pfx) + WINDOWS_CERTIFICATE_PASSWORD
#   2. Azure Trusted Signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
#      TRUSTED_SIGNING_ENDPOINT, TRUSTED_SIGNING_ACCOUNT, TRUSTED_SIGNING_PROFILE
# Writes src-tauri/tauri.windowssign.conf.json (a Tauri config override) and exports WIN_SIGN_ARGS / WIN_SIGNED via GITHUB_ENV.
set -euo pipefail
OUT=apps/desktop/src-tauri/tauri.windowssign.conf.json
TS="${WINDOWS_TIMESTAMP_URL:-http://timestamp.digicert.com}"

if [ -n "${WINDOWS_CERTIFICATE:-}" ]; then
  echo "$WINDOWS_CERTIFICATE" | base64 -d > "$RUNNER_TEMP/codesign.pfx"
  THUMB=$(CERT_PATH="$(cygpath -w "$RUNNER_TEMP/codesign.pfx")" powershell -NoProfile -Command '
    $pw = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    (Import-PfxCertificate -FilePath $env:CERT_PATH -CertStoreLocation Cert:\CurrentUser\My -Password $pw).Thumbprint' | tr -d '\r\n ')
  [ -n "$THUMB" ] || { echo "::error::Could not import WINDOWS_CERTIFICATE"; exit 1; }
  rm -f "$RUNNER_TEMP/codesign.pfx"
  printf '{"bundle":{"windows":{"certificateThumbprint":"%s","digestAlgorithm":"sha256","timestampUrl":"%s"}}}\n' "$THUMB" "$TS" > "$OUT"
  echo "Windows signing: PFX certificate (thumbprint ${THUMB:0:8}…)"
elif [ -n "${TRUSTED_SIGNING_ENDPOINT:-}" ] && [ -n "${AZURE_CLIENT_ID:-}" ]; then
  cargo install trusted-signing-cli --locked
  # %1 is replaced by Tauri with the file to sign. Credentials come from the AZURE_* env vars.
  printf '{"bundle":{"windows":{"signCommand":{"cmd":"trusted-signing-cli","args":["-e","%s","-a","%s","-c","%s","-d","Jorcord","%%1"]}}}}\n' \
    "$TRUSTED_SIGNING_ENDPOINT" "$TRUSTED_SIGNING_ACCOUNT" "$TRUSTED_SIGNING_PROFILE" > "$OUT"
  echo "Windows signing: Azure Trusted Signing"
else
  echo "Windows signing: not configured, installers will be unsigned (SmartScreen warning)."
  exit 0
fi
echo "WIN_SIGN_ARGS=--config src-tauri/tauri.windowssign.conf.json" >> "$GITHUB_ENV"
echo "WIN_SIGNED=1" >> "$GITHUB_ENV"
