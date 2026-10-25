#!/usr/bin/env bash
# Build the tree measurement sample apps into playground/test-builds/, where the other test builds live
# (gitignored). Nothing built here is committed — see `.work` e2e-followups A3 for why.
#
#   ./build.sh            # iOS (both targets) and Android
#   ./build.sh <udid>     # iOS only, installed on that booted simulator
#   ./build.sh ios        # one platform only (also: android)
#
# Outputs, ready to upload to App Center:
#   playground/test-builds/sample-uikit.app.zip     dev.tapflow.sample.uikit
#   playground/test-builds/sample-swiftui.app.zip   dev.tapflow.sample.swiftui
#   playground/test-builds/sample-compose.apk       dev.tapflow.sample.compose
set -euo pipefail
cd "$(dirname "$0")"
ARG="${1:-}"
UDID=""
PLATFORMS="ios android"
case "$ARG" in
  ios|android) PLATFORMS="$ARG" ;;
  "") ;;
  # A device id is a simulator's: installing is iOS-only, so it builds iOS only.
  *) UDID="$ARG"; PLATFORMS="ios" ;;
esac
OUT="$(cd .. && pwd)/test-builds"
mkdir -p "$OUT"

build_ios() {
(
  cd ios
  xcodegen generate >/dev/null
  for target in SampleUIKit SampleSwiftUI; do
    xcodebuild -project TapflowSample.xcodeproj -scheme "$target" -configuration Debug \
      -sdk iphonesimulator -destination "generic/platform=iOS Simulator" -derivedDataPath build \
      CODE_SIGNING_ALLOWED=NO -quiet build
  done
)

for pair in "SampleUIKit:sample-uikit" "SampleSwiftUI:sample-swiftui"; do
  target="${pair%%:*}"
  name="${pair##*:}"
  app="ios/build/Build/Products/Debug-iphonesimulator/$target.app"
  [[ -d "$app" ]] || { echo "build produced no app at $app" >&2; exit 1; }
  # The .app at the zip's root, which is the layout App Center accepts.
  rm -f "$OUT/$name.app.zip"
  ditto -c -k --keepParent "$app" "$OUT/$name.app.zip"
  echo "built $OUT/$name.app.zip"
  if [[ -n "$UDID" ]]; then
    xcrun simctl install "$UDID" "$app"
    echo "installed $target on $UDID"
  fi
done
}

build_android() {
  (cd android && ./gradlew -q assembleDebug)
  cp android/app/build/outputs/apk/debug/app-debug.apk "$OUT/sample-compose.apk"
  echo "built $OUT/sample-compose.apk"
}

for platform in $PLATFORMS; do "build_$platform"; done
