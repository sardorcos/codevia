#!/usr/bin/env bash
# Builds Codevia Pocket and uploads it to TestFlight. Runs on macOS with Xcode 16+.
# Signing is fully automatic (cloud-managed certificates) through an App Store Connect API key.
#
# Required environment:
#   APPLE_TEAM_ID          10-character Apple Developer Team ID
#   ASC_KEY_ID             App Store Connect API key ID (role: Admin, needed for cloud signing)
#   ASC_ISSUER_ID          App Store Connect issuer ID
#   ASC_KEY_PATH           path to the AuthKey_XXXX.p8 file
# Optional:
#   BUNDLE_ID              default com.codevia.pocket (must match the app record in App Store Connect)
#   BUILD_NUMBER           default: current UTC timestamp (must increase for every upload)
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}" "${ASC_KEY_ID:?set ASC_KEY_ID}" "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}" "${ASC_KEY_PATH:?set ASC_KEY_PATH}"
BUNDLE_ID="${BUNDLE_ID:-com.codevia.pocket}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
VERSION="$(node -p "require('./package.json').version")"
OUT="build/ios"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

npm run build
CODEVIA_BUNDLE_ID="$BUNDLE_ID" npx cap sync ios

rm -rf "$OUT" && mkdir -p "$OUT"
sed "s/TEAM_ID_PLACEHOLDER/$APPLE_TEAM_ID/" ios/ExportOptions.plist > "$OUT/ExportOptions.plist"

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/CodeviaPocket.xcarchive" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGN_STYLE=Automatic \
  "${AUTH[@]}" archive

# destination=upload in ExportOptions sends the build straight to App Store Connect / TestFlight.
xcodebuild -exportArchive -archivePath "$OUT/CodeviaPocket.xcarchive" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"

echo "Uploaded Codevia Pocket $VERSION ($BUILD_NUMBER). It appears in TestFlight after Apple finishes processing (usually 5–30 min)."
