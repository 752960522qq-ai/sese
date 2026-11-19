# 姿态排练室

甄芙和里昂的离线 Android 姿态编辑器。支持甄芙摇杆走跑、同屏多人摆姿、独立调节动作时间、关节与位置、自由相机，以及命名场景存档。

## 本地构建

需要 JDK 17、Android SDK Platform 35、Android Build Tools 35 或更高版本、Python 3 和 Node.js。将甄芙 R19 和里昂七动作版的 GLB 放在本机，安装锁定版本的 Three.js，并从本仓库根目录运行以下命令。

```sh
npm install --ignore-scripts
python3 tools/prepare_assets.py --zhenfu /path/to/Zhenfu_R19.glb --leon /path/to/Leon_Kennedy_7_Motions.glb
python3 tools/prepare_audio.py /path/to/Game_Audio_Cues.zip
bash tools/build-apk.sh
```

构建结果位于 `build/PoseStudio.apk`。可通过 `POSE_KEYSTORE`、`POSE_KEY_ALIAS` 和 `POSE_KEY_PASS` 指定自己的签名，缺省使用本机测试签名。模型和纹理随 APK 离线提供，应用无需网络权限。存档保存在应用私有存储。

## 操作

- 自由移动默认控制甄芙。左下摇杆轻推行走、推到底奔跑。单指绕场旋转，双指平移或缩放。
- 在摆姿中选片段、拖动时间轴或逐帧定格，然后调节关节。位置页可输入 X、Y、Z 和朝向，也支持按厘米微调。
- 多人模式可同时添加甄芙、里昂及其副本。各自独立保存动作、关节、位置和播放进度，镜头可对准角色或整个场景。
- 自编动作支持连续记录关键帧和角色位移。单独保存的动作可以套用到本场或其他场景中的同模型角色。
- 甄芙的「表情」页可选择六段享受表情或三段日常反应，单独调节强度、播放、定格、循环和搭配起始时间。自然眨眼、胸廓呼吸分别开关。每个甄芙副本的设置和进度保存在场景中，录制身体关键帧时保留独立表情轨。
- 「声音」页可试听 44 条内置素材，并在角色的声音进度上添加多个片段。每个片段可编辑起始秒数和音量。播放搭配时，场上角色的身体、表情与声音一起从头开始。
- 「存档」中的导出搭配生成 `.sese.json` 文件。将它导入另一份同版应用，可恢复场上角色、动作关键帧、表情进度、声音时间轴、位置和镜头。
- 存档页支持命名保存与读取。使用相同名称会更新该存档。显示精度可在位置页选择 1K、2K 或原始最高 4K，APK 保存原始纹理和网格。

现有安装包也可用于恢复编译所需的素材。把其中的 `assets/models/`、`assets/vendor/`、`assets/audio/` 及 `assets/catalog.json` 复制至 `app/src/main/assets/` 后可直接执行构建脚本。

构建时会从 R19 绑定生成独立的 `models/zhenfu/expressions.glb`。表情轨道只驱动脸部。眨眼和胸廓呼吸各有独立片段。所有片段以静止参考姿态为首帧，可在其他引擎中按同名骨骼映射，并以首帧作为叠加参考。
