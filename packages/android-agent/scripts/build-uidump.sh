#!/usr/bin/env bash
# Builds bin/tapflow-uidump.jar from uidump/src (see TreeDump.java for what it is). The jar is committed, like
# bin/scrcpy-server.jar, so installing the agent needs no Android build tools; rebuild after editing the source.
# Needs a JDK (javac) and the Android SDK's build-tools (d8) and a platform (android.jar).
set -euo pipefail
cd "$(dirname "$0")/.."
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
# Numeric versions only: `sort -V` ranks a preview (android-Baklava, 36.0.0-rc1) above every release.
D8="$(ls -d "$SDK"/build-tools/[0-9]*/ | /usr/bin/grep -v -- '-rc' | sort -V | tail -1)d8"
ANDROID_JAR="$(ls -d "$SDK"/platforms/android-[0-9]*/ | sort -V | tail -1)android.jar"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
javac --release 8 -Xlint:-options -cp "$ANDROID_JAR" -d "$WORK/classes" $(find uidump/src -name '*.java')
"$D8" --min-api 24 --output "$WORK" $(find "$WORK/classes" -name '*.class')
# A fixed timestamp, so rebuilding unchanged source with the same tools gives the same jar.
touch -t 198001010000 "$WORK/classes.dex"
(cd "$WORK" && TZ=UTC zip -q -X tapflow-uidump.jar classes.dex)
cp "$WORK/tapflow-uidump.jar" bin/tapflow-uidump.jar
# What the committed jar was built from; a test fails when the source changes without a rebuild.
find uidump/src -name '*.java' | sort | xargs cat | shasum -a 256 | cut -d' ' -f1 > bin/tapflow-uidump.source-sha256
echo "built bin/tapflow-uidump.jar ($(wc -c < bin/tapflow-uidump.jar | tr -d ' ') bytes)"
