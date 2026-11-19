# 姿态排练室

甄芙和里昂的离线 Android 姿态编辑器。支持甄芙摇杆走跑、同屏多人摆姿、独立调节动作时间、关节与位置、自由相机，以及命名场景存档。

## 本地构建

需要 JDK 17、Android SDK Platform 35、Android Build Tools 35 或更高版本、Python 3 和 Node.js。将甄芙 R19 和里昂七动作版的 GLB 放在本机，安装锁定版本的 Three.js，并从本仓库根目录运行以下命令。

```sh
npm install --ignore-scripts
python3 tools/prepare_assets.py --zhenfu /path/to/Zhenfu_R19.glb --leon /path/to/Leon_Kennedy_7_Motions.glb
bash tools/build-apk.sh
```

构建结果位于 `build/PoseStudio.apk`。可通过 `POSE_KEYSTORE`、`POSE_KEY_ALIAS` 和 `POSE_KEY_PASS` 指定自己的签名，缺省使用本机测试签名。模型和纹理随 APK 离线提供，应用无需网络权限。存档保存在应用私有存储。
