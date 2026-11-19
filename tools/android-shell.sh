#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Set ANDROID_HOME}}"
target=35
tools="$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
api="$sdk/platforms/android-$target/android.jar"
out="${1:-build/shell}"
mkdir -p "$out/classes" "$out/dex"
"$tools/aapt2" compile --dir app/src/main/res -o "$out/res.zip"
"$tools/aapt2" link -I "$api" --manifest app/src/main/AndroidManifest.xml -o "$out/resources.apk" "$out/res.zip"
javac -source 8 -target 8 -bootclasspath "$api" -d "$out/classes" app/src/main/java/studio/sese/pose/StudioActivity.java
(cd "$out/classes" && jar cf ../classes.jar .)
"$tools/d8" --release --min-api 28 --lib "$api" --output "$out/dex" "$out/classes.jar"
cp "$out/resources.apk" "$out/shell.apk"
(cd "$out/dex" && zip -q -j ../shell.apk classes.dex)
