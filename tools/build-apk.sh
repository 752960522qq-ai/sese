#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f app/src/main/assets/models/leon/actor.gltf
test -f app/src/main/assets/models/zhenfu/actor.gltf
test -f app/src/main/assets/audio/cues.json || { echo 'Run tools/prepare_audio.py with the reviewed sound ZIP first.' >&2; exit 1; }
archive_lib=node_modules/three/examples/jsm/libs/fflate.module.js
if [[ -f "$archive_lib" ]]; then cp "$archive_lib" app/src/main/assets/vendor/fflate.module.js; fi
test -s app/src/main/assets/vendor/fflate.module.js || { echo 'Install the pinned three dependency for the ZIP reader.' >&2; exit 1; }
if [[ -n "${POSE_LEON_BASE:-}${POSE_LEON_SUIT:-}" ]]; then
    python3 tools/prepare_leons.py "${POSE_LEON_BASE:?Supply the fitted base GLB}" "${POSE_LEON_SUIT:?Supply the fitted suit GLB}"
fi
test -s app/src/main/assets/models/leonSuit/actor.gltf
python3 tools/rig_controls.py app/src/main/assets/models
if [[ -n "${POSE_WARDROBE:-}" ]]; then
    python3 tools/prepare_wardrobe.py "$POSE_WARDROBE" app/src/main/assets/models/zhenfu
fi
test -s app/src/main/assets/models/zhenfu/dressed.gltf || { echo 'Set POSE_WARDROBE to the current office wardrobe ZIP.' >&2; exit 1; }
python3 tools/prepare_body_contacts.py app/src/main/assets/models
city_dir="${POSE_CITY_DIR:-app/src/main/assets/city}"
test -s "$city_dir/index.json" || { echo 'Set POSE_CITY_DIR to the prepared mobile city.' >&2; exit 1; }
if [[ "$(realpath "$city_dir")" != "$(realpath -m app/src/main/assets/city)" ]]; then
    python3 - "$city_dir" app/src/main/assets/city <<'CITY'
import shutil, sys
from pathlib import Path
src,dst=map(Path,sys.argv[1:])
if dst.exists():
    for p in dst.rglob('*'):
        if p.is_file() and not (src/p.relative_to(dst)).exists():p.unlink()
shutil.copytree(src,dst,dirs_exist_ok=True)
CITY
fi
node tools/build-expressions.mjs
cp -R web/. app/src/main/assets/
bash tools/android-shell.sh
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Set ANDROID_HOME}}"
bt="$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED
with ZipFile('build/shell/shell.apk') as core, ZipFile('build/unsigned.apk','w',compresslevel=5) as apk:
    for entry in core.infolist():
        apk.writestr(entry,core.read(entry))
    root=Path('app/src/main/assets')
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        relative=path.relative_to(root)
        stored=path.suffix in {'.png','.jpg'} or (path.suffix=='.bin' and relative.parts[0]!='city')
        apk.write(path,'assets/'+relative.as_posix(),compress_type=ZIP_STORED if stored else ZIP_DEFLATED)
PY
"$bt/zipalign" -f 4 build/unsigned.apk build/aligned.apk
keystore="${POSE_KEYSTORE:-$HOME/.android/debug.keystore}"
alias="${POSE_KEY_ALIAS:-androiddebugkey}"
if [[ -z "${POSE_KEY_PASS:-}" ]]; then export POSE_KEY_PASS=android; fi
if [[ ! -f "$keystore" && -z "${POSE_KEYSTORE:-}" ]]; then
    mkdir -p "$(dirname "$keystore")"
    keytool -genkeypair -keystore "$keystore" -storepass:env POSE_KEY_PASS -keypass:env POSE_KEY_PASS -alias "$alias" -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
"$bt/apksigner" sign --ks "$keystore" --ks-key-alias "$alias" --ks-pass env:POSE_KEY_PASS --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false --out build/PoseStudio.apk build/aligned.apk
"$bt/apksigner" verify --verbose build/PoseStudio.apk
