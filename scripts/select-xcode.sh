#!/usr/bin/env bash
# Picks the newest *stable* Xcode 26.x on a GitHub macOS runner. Beta Xcodes (e.g. 27 previews) are
# skipped on purpose: App Store Connect rejects builds made with beta Xcode. Capacitor 8 needs Xcode 26+.
set -euo pipefail
candidate=""
for app in $(ls -d /Applications/Xcode_26*.app 2>/dev/null | grep -viE 'beta|_rc|release_candidate' | sort -V); do
  candidate="$app"
done
if [ -z "$candidate" ]; then
  echo "::error::No stable Xcode 26.x found on this runner"; ls -d /Applications/Xcode*.app || true; exit 1
fi
sudo xcode-select -s "$candidate/Contents/Developer"
xcodebuild -version
