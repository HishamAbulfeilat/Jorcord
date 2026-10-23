# Code signing

The release workflow (`.github/workflows/release.yml`) signs every platform when its secrets exist and silently builds unsigned artifacts when they do not. Add secrets under GitHub, Settings, Secrets and variables, Actions. Nothing here costs Jorcord money to run, but the certificates and the Apple Developer Program membership are paid by whoever publishes the builds.

Status: the workflow and scripts are written and syntax-checked. They have not been run against real certificates, so the first signed tag should be a pre-release you check with the commands below.

## Windows (Authenticode)

Unsigned installers trigger SmartScreen. Pick one mode; `.github/scripts/windows-sign-setup.sh` chooses by which secrets exist.

| Mode | Secrets |
|---|---|
| PFX certificate (OV/EV from a CA) | `WINDOWS_CERTIFICATE` (base64 of the .pfx), `WINDOWS_CERTIFICATE_PASSWORD` |
| Azure Trusted Signing (cloud, no private key on disk, about USD 10 a month) | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `TRUSTED_SIGNING_ENDPOINT`, `TRUSTED_SIGNING_ACCOUNT`, `TRUSTED_SIGNING_PROFILE` |

Notes: `base64 -w0 cert.pfx` makes the first secret. Since 2023 CAs issue OV/EV keys on hardware tokens, which cannot run in CI; use Azure Trusted Signing or a cloud HSM service in that case. Optional variable `WINDOWS_TIMESTAMP_URL` (default DigiCert). The workflow writes a Tauri config override (`certificateThumbprint` or `signCommand`) and then verifies every `.msi` and `-setup.exe` with `Get-AuthenticodeSignature`; the job fails if any is not `Valid`.

## macOS (Developer ID and notarization)

Secrets: `APPLE_CERTIFICATE` (base64 .p12 of a "Developer ID Application" certificate), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (for example `Developer ID Application: Name (TEAMID)`), `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`. Tauri signs with the hardened runtime using `Entitlements.plist` and notarizes. After the build the workflow runs `codesign --verify --deep --strict` and `spctl -a -t exec` on each `.app`.

## iOS (signed .ipa, optional TestFlight)

Secrets: `IOS_CERTIFICATE_P12_B64` (Apple Distribution certificate), `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_B64` (profile for `app.jorcord.mobile`), `APPLE_TEAM_ID`. Optional: `IOS_EXTRA_PROFILES_B64` (space separated base64 profiles, one per app extension such as a broadcast extension), repository variable `IOS_EXPORT_METHOD` (`app-store-connect` default, `ad-hoc`, `development`, `enterprise`), and `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_B64` (an App Store Connect API key .p8) to upload to TestFlight. Without the required four, `.github/scripts/ios-build.sh` produces the unsigned sideload `.ipa` as before. The script uses a throwaway keychain, installs the profiles, archives with manual signing, builds `ExportOptions.plist` from the installed profiles' bundle ids and exports.

## Android

Already wired: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Without them CI uses an ephemeral keystore and users must uninstall before upgrading. Keep the real keystore backed up: losing it means users can never upgrade in place.

## Updater

`TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` signs the auto-update bundles. This is separate from OS code signing.

## Checking a release by hand

- Windows: `Get-AuthenticodeSignature .\Jorcord_x64-setup.exe | Format-List`
- macOS: `spctl -a -vv /Applications/Jorcord.app` and `xcrun stapler validate Jorcord.app`
- iOS: `codesign -dv --verbose=4 Payload/App.app` after unzipping the `.ipa`
