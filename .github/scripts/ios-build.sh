#!/usr/bin/env bash
# Builds the iOS app. Signed .ipa when the iOS secrets exist, otherwise the unsigned sideload .ipa.
# Signed mode needs: IOS_CERTIFICATE_P12_B64, IOS_CERTIFICATE_PASSWORD, IOS_PROVISIONING_PROFILE_B64, APPLE_TEAM_ID
#   optional: IOS_EXTRA_PROFILES_B64 (space separated base64 profiles, e.g. for app extensions), IOS_EXPORT_METHOD (app-store-connect|ad-hoc|development|enterprise, default app-store-connect),
#   APP_STORE_CONNECT_KEY_ID / APP_STORE_CONNECT_ISSUER_ID / APP_STORE_CONNECT_KEY_B64 (uploads to TestFlight after export)
# env in: APP_VERSION, BUILD_NUMBER, RUNNER_TEMP, GITHUB_WORKSPACE. Output: out/*.ipa
set -euo pipefail
cd apps/mobile/ios/App
if [ -d App.xcworkspace ]; then TARGET=(-workspace App.xcworkspace); else TARGET=(-project App.xcodeproj); fi
ARCHIVE="$RUNNER_TEMP/Jorcord.xcarchive"
mkdir -p "$GITHUB_WORKSPACE/out"

if [ -z "${IOS_CERTIFICATE_P12_B64:-}" ] || [ -z "${IOS_PROVISIONING_PROFILE_B64:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo "iOS signing not configured: building the unsigned sideload .ipa"
  xcodebuild "${TARGET[@]}" -scheme App -configuration Release -sdk iphoneos -archivePath "$ARCHIVE" archive \
    MARKETING_VERSION="$APP_VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" | tail -n 60
  mkdir -p "$RUNNER_TEMP/ipa/Payload"
  cp -R "$ARCHIVE/Products/Applications/App.app" "$RUNNER_TEMP/ipa/Payload/"
  (cd "$RUNNER_TEMP/ipa" && zip -qry "$GITHUB_WORKSPACE/out/Jorcord-$APP_VERSION-ios-unsigned.ipa" Payload)
  exit 0
fi

echo "iOS signing configured: building a signed .ipa"
KC="$RUNNER_TEMP/jorcord.keychain-db"; KCPW=$(openssl rand -hex 16)
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KCPW" "$KC"
echo "$IOS_CERTIFICATE_P12_B64" | base64 -d > "$RUNNER_TEMP/ios.p12"
security import "$RUNNER_TEMP/ios.p12" -k "$KC" -P "$IOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" > /dev/null
security list-keychains -d user -s "$KC" login.keychain-db
rm -f "$RUNNER_TEMP/ios.p12"

# Install every provisioning profile and remember bundle id -> profile name for the export step.
PROFDIR="$HOME/Library/MobileDevice/Provisioning Profiles"; mkdir -p "$PROFDIR"
MAP=""; MAIN_PROFILE_NAME=""
i=0
for b64 in "$IOS_PROVISIONING_PROFILE_B64" ${IOS_EXTRA_PROFILES_B64:-}; do
  f="$RUNNER_TEMP/p$i.mobileprovision"; echo "$b64" | base64 -d > "$f"
  security cms -D -i "$f" > "$RUNNER_TEMP/p$i.plist"
  UUID=$(/usr/libexec/PlistBuddy -c 'Print UUID' "$RUNNER_TEMP/p$i.plist")
  NAME=$(/usr/libexec/PlistBuddy -c 'Print Name' "$RUNNER_TEMP/p$i.plist")
  APPID=$(/usr/libexec/PlistBuddy -c 'Print Entitlements:application-identifier' "$RUNNER_TEMP/p$i.plist")
  BUNDLE="${APPID#*.}"
  cp "$f" "$PROFDIR/$UUID.mobileprovision"
  [ "$i" = 0 ] && MAIN_PROFILE_NAME="$NAME"
  MAP="$MAP<key>$BUNDLE</key><string>$NAME</string>"
  echo "Installed profile '$NAME' for $BUNDLE"
  i=$((i+1))
done

xcodebuild "${TARGET[@]}" -scheme App -configuration Release -sdk iphoneos -archivePath "$ARCHIVE" archive \
  MARKETING_VERSION="$APP_VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="$MAIN_PROFILE_NAME" | tail -n 60

METHOD="${IOS_EXPORT_METHOD:-app-store-connect}"
cat > "$RUNNER_TEMP/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>$METHOD</string>
<key>teamID</key><string>$APPLE_TEAM_ID</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>Apple Distribution</string>
<key>provisioningProfiles</key><dict>$MAP</dict>
<key>uploadSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist" -exportPath "$RUNNER_TEMP/export" | tail -n 30
cp "$RUNNER_TEMP/export/"*.ipa "$GITHUB_WORKSPACE/out/Jorcord-$APP_VERSION-ios.ipa"

if [ -n "${APP_STORE_CONNECT_KEY_ID:-}" ] && [ -n "${APP_STORE_CONNECT_ISSUER_ID:-}" ] && [ -n "${APP_STORE_CONNECT_KEY_B64:-}" ] && [ "$METHOD" = app-store-connect ]; then
  mkdir -p "$HOME/.appstoreconnect/private_keys"
  echo "$APP_STORE_CONNECT_KEY_B64" | base64 -d > "$HOME/.appstoreconnect/private_keys/AuthKey_$APP_STORE_CONNECT_KEY_ID.p8"
  xcrun altool --upload-app -f "$GITHUB_WORKSPACE/out/Jorcord-$APP_VERSION-ios.ipa" -t ios --apiKey "$APP_STORE_CONNECT_KEY_ID" --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"
  rm -rf "$HOME/.appstoreconnect/private_keys"
fi
security delete-keychain "$KC" || true
