#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$src/.." && pwd)"
: "${ASSET_DIR:?Set ASSET_DIR to the prepared game asset directory}"
: "${GAME_BUILD_DIR:?Set GAME_BUILD_DIR to the output directory}"
: "${ANDROID_HOME:?Set ANDROID_HOME to the SDK}"
bt="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
api="$ANDROID_HOME/platforms/android-35/android.jar"
mkdir -p "$GAME_BUILD_DIR"/{classes,dex} "$ASSET_DIR/examples"
test -f "$ASSET_DIR/city/index.json" && test -f "$ASSET_DIR/models/zhenfu/wardrobe.json"
test -s "$ASSET_DIR/models/leonSuit/actor.gltf" && test -s "$ASSET_DIR/vehicles/dealer-suv.glb"
cp "$src"/web/* "$ASSET_DIR/"
cp "$repo"/web/{rig.js,skin.js,morph.js,expressions.js,scene-file.js,sounds.js,wardrobe.js} "$ASSET_DIR/"
cp "$src"/examples/*.json "$ASSET_DIR/examples/"
"$bt/aapt2" compile --dir "$src/android/res" -o "$GAME_BUILD_DIR/res.zip"
"$bt/aapt2" link -I "$api" --manifest "$src/android/AndroidManifest.xml" -o "$GAME_BUILD_DIR/core.apk" "$GAME_BUILD_DIR/res.zip"
javac -source 8 -target 8 -bootclasspath "$api" -d "$GAME_BUILD_DIR/classes" "$src/android/GameActivity.java"
jar cf "$GAME_BUILD_DIR/classes.jar" -C "$GAME_BUILD_DIR/classes" .
"$bt/d8" --release --min-api 28 --lib "$api" --output "$GAME_BUILD_DIR/dex" "$GAME_BUILD_DIR/classes.jar"
python3 - "$GAME_BUILD_DIR" "$ASSET_DIR" <<'PY'
from pathlib import Path
from zipfile import ZipFile,ZIP_STORED,ZIP_DEFLATED
import sys
out,root=map(Path,sys.argv[1:])
with ZipFile(out/'core.apk') as base,ZipFile(out/'unsigned.apk','w',compression=ZIP_DEFLATED,compresslevel=5) as apk:
    for ent in base.infolist():apk.writestr(ent,base.read(ent))
    apk.write(out/'dex/classes.dex','classes.dex')
    for p in sorted(root.rglob('*')):
        if p.is_file():apk.write(p,'assets/'+p.relative_to(root).as_posix(),compress_type=ZIP_STORED if p.suffix in {'.png','.jpg'} else ZIP_DEFLATED)
PY
"$bt/zipalign" -f 4 "$GAME_BUILD_DIR/unsigned.apk" "$GAME_BUILD_DIR/aligned.apk"
store="${GAME_KEYSTORE:-$HOME/.android/debug.keystore}"
alias="${GAME_KEY_ALIAS:-androiddebugkey}"
if [[ -z "${GAME_KEY_PASS:-}" ]]; then export GAME_KEY_PASS=android; fi
if [[ ! -f "$store" && -z "${GAME_KEYSTORE:-}" ]]; then
    mkdir -p "$(dirname "$store")"
    keytool -genkeypair -keystore "$store" -storepass:env GAME_KEY_PASS -keypass:env GAME_KEY_PASS -alias "$alias" -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'
fi
"$bt/apksigner" sign --ks "$store" --ks-key-alias "$alias" --ks-pass env:GAME_KEY_PASS --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false --out "$GAME_BUILD_DIR/Zhenfu-City-0.2.0.apk" "$GAME_BUILD_DIR/aligned.apk"
"$bt/apksigner" verify --verbose "$GAME_BUILD_DIR/Zhenfu-City-0.2.0.apk"
