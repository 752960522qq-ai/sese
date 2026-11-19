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

## 操作

- 自由移动默认控制甄芙。左下摇杆轻推行走、推到底奔跑。单指绕场旋转，双指平移或缩放。
- 在摆姿中选片段、拖动时间轴或逐帧定格，然后调节关节。位置页可输入 X、Y、Z 和朝向，也支持按厘米微调。
- 多人模式可同时添加甄芙、里昂及其副本。各自独立保存动作、关节、位置和播放进度，镜头可对准角色或整个场景。
- 自编动作支持连续记录关键帧和角色位移。单独保存的动作可以套用到本场或其他场景中的同模型角色。
- 存档页支持命名保存与读取。使用相同名称会更新该存档。显示精度可在位置页选择 1K、2K 或原始最高 4K，APK 保存原始纹理和网格。

现有安装包也可用于恢复编译所需的私有素材。把其中的 `assets/models/`、`assets/vendor/` 及 `assets/catalog.json` 复制至 `app/src/main/assets/` 后可直接执行构建脚本。
