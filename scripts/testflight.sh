#!/usr/bin/env bash
# Build the iOS app and upload it to App Store Connect for TestFlight.
#
#   npm run testflight              build www → cap sync → archive → upload
#   npm run testflight -- --no-upload   stop after the archive (nothing leaves this Mac)
#
# Uploads with the Apple ID signed into Xcode (Settings → Accounts), using the
# DEVELOPMENT_TEAM in the Xcode project (the parent's team). The build number
# is a timestamp (YYYYMMDDHHMM) so it never repeats; the version (MARKETING_VERSION)
# stays whatever the project says. The archive lands in Xcode's Organizer.
# Still manual afterwards, in App Store Connect: the export-compliance answer
# and adding the build to the tester group.
set -euo pipefail

UPLOAD=1
for arg in "$@"; do
  case "$arg" in
    --no-upload) UPLOAD=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PROJECT="ios/App/App.xcodeproj"
PBX="$PROJECT/project.pbxproj"

TEAM="$(grep -m1 'DEVELOPMENT_TEAM = ' "$PBX" | sed 's/.*= \(.*\);/\1/')"
VERSION="$(grep -m1 'MARKETING_VERSION = ' "$PBX" | sed 's/.*= \(.*\);/\1/')"
BUILD="$(date +%Y%m%d%H%M)"
[ -n "$TEAM" ] || { echo "No DEVELOPMENT_TEAM in $PBX. Set the signing team in Xcode first." >&2; exit 1; }

if [ -n "$(git status --porcelain -- index.html privacy.html terms.html sw.js manifest.json assets)" ]; then
  echo "⚠️  Uncommitted web changes: this build will contain code that isn't on GitHub."
fi
echo "▶ Slope Battles $VERSION ($BUILD), team $TEAM, upload: $([ $UPLOAD = 1 ] && echo yes || echo no)"

echo "▶ 1/4 Copying web files into www/"
npm run -s build:www

echo "▶ 2/4 Syncing www/ into the iOS project"
npx cap sync ios

ARCHIVE="$HOME/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)/SlopeBattles $VERSION ($BUILD).xcarchive"
echo "▶ 3/4 Archiving (a few minutes)"
xcodebuild -project "$PROJECT" -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CURRENT_PROJECT_VERSION="$BUILD" \
  archive -quiet
echo "  Archive: $ARCHIVE"

if [ $UPLOAD = 0 ]; then
  echo "✓ Archived only (--no-upload). Nothing was sent to Apple."
  exit 0
fi

echo "▶ 4/4 Uploading to App Store Connect"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$WORK/export" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -allowProvisioningUpdates -quiet

echo "✓ Uploaded $VERSION ($BUILD). Next, in App Store Connect → TestFlight (10–30 min of processing):"
echo "  1. Answer the export-compliance question (same answer as build 1)"
echo "  2. Add the build to the tester group"
