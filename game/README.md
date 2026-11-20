# 甄芙 · 城市篇

独立的离线 Android 游戏，包名 `studio.sese.citygame`，版本 0.2.0。Android 9 及以上，使用支持 WebGL 2 的 Android System WebView。动作制作工具「姿态排练室」1.3.0 使用 `studio.sese.pose`，两个应用可以同时安装。

## 《明天就订车》第一章

在手记选第一章。走近 SUV 上车，用左右键转向、油门加速、刹车减速。停稳后继续按刹车可倒车。试驾沿途路标半径为 14 米，回店停车圈为 12 米。赴宴路线对应半径为 16 米和 13 米，驶进终点圈后停稳下车。步行摇杆可走进展厅和酒店。键盘 W/S 为油门和刹车，A/D 为转向，E 为现场交互。剧情保留当前路标、车辆位置、手机阅读进度和订单页面。

两版里昂分别使用 `leon`、`leonSuit` 骨架。第一章由西装里昂出演陈总。酒店接口默认留空，继续后进入次日。导入 `chapter01-hotel.module.json` 后可进入自编模块，仅导入 `chapter01-hotel.sese.json` 时可直接播放自编动作。支持同时导入 JSON、GLB 或模板 ZIP。

## 开始游戏

「第七区碰面」从东风汽车销售中心门前开始。步行镜头默认在甄芙身后 2.3 米。左下摇杆移动，外圈奔跑，拖动街景转动镜头，双指缩放。「手记」中可继续剧情、自由探索、跳转到各区道路以及换装。公共水面随街区加载。城市场景来自 hero_13 v24。第七区包含东风汽车销售中心和云庭酒店，街区地图可直达酒店正门与 23 层总统套房。18 个区块保留原坐标，并针对手机做了减面、贴图缩放和分块加载。运行时检查街面高度及建筑阻挡。

甄芙使用 R19 素体和 R06 职业装。甄芙、里昂各有根部、中段、前端三个连续的阴茎骨骼，主游戏可播放动作制作 APK 录制的三轴旋转。黑色浅口高跟鞋使每名对手防御乘 0.95，黑色长筒丝袜使每名对手攻速乘 1.03、甄芙防御乘 1.07。服饰选择在开始对局时生效。

## 导入与联调

1. 在「姿态排练室」1.3.0 中打开「剧情制作」，导入模板并编排动作，点「导出主游戏文件」取得关卡及引用的动作。「存档」也可单独导出一个角色的 `.action.json` 或多人搭配 `.sese.json`。
2. 在游戏中打开「手记 → 关卡与动作 → 导入文件」。可以一次选择多份 JSON 或 GLB。首次使用配套示例时，先将 ZIP 解压，并多选目录里的 JSON。示例文件也已预装。
3. 在「剧情」中点开关卡。文件导入顺序任意，关卡会列出尚缺的依赖。更新动作时导入同名文件，更新关卡时保持关卡 ID。文件存放在应用私有数据库中。相同批次有无效数据时，整批不写入。
4. 「三人模块联调」依次播放单角色到场动作、载入三人搭配、显示三条独立数值条。点对手名字切换主要作用目标。默认两名对手分别是对手甲、对手乙。成品演出可以直接替换这一组示例站位。
5. 关卡进度按节点保存，城市步行时另存位置。中途退出未结算对局会回到该局准备页。已经得分的结果可继续确认，不会因重开应用重复发奖。

## 文件约定 v1

| 文件类型 | 顶层 type | 用法 |
| --- | --- | --- |
| 剧情关卡 | sese-story-level | 声明城市出生点、起始节点、对白选项、步行目的地、动作与结局 |
| 对局模块 | sese-encounter-module | 声明参与角色、每人参数、姿势与动作映射、数值事件、胜负规则及结算积分 |
| 编辑器搭配 | sese-pose-combination | 直接读取编辑器导出的多人站位、关键帧、表情、声音与镜头 |
| 独立角色动作 | sese-action | actor 使用编辑器已有的角色、clip 与 keys 结构 |
| 同骨架 GLB | glTF 二进制 2.0 | 读取内嵌动画。支持甄芙或里昂同名骨骼的旋转、位置和缩放通道，无需导入另一套角色网格 |

动作引用使用文件名，例如 `cast-three.sese.json`，多段 GLB 可写成 `idle.glb#Walk`。省略片段名时选择首个匹配骨架的片段。GLB 在多人模块里驱动首个匹配模型的角色，其余人保留站位。分别编排每位演员时使用编辑器搭配，且模块的每个 ID 和模型都须对应 `scene.actors` 里相同的 ID 和 type。编辑器的自定义 ID 可以直接从导出的 JSON 复制。

### 道具柔性碰撞

排练室导出的碰撞轨迹会随动作播放。甄芙的开口和相连内壁跟随接触形状变形，碰撞体撤出后回弹。每个角色副本独立响应场上的碰撞体。

自编动作可在角色的 `contactBodies` 中定义道具，GLB 可在相应片段的 `animations[].extras.contactBodies` 中设置同一结构。以下为一根胶囊沿轴线移出的例子，距离单位为米，时间单位为秒。

```json
{
  "contactBodies": [{
    "id": "stool",
    "shape": "capsule",
    "anchor": "rim",
    "a": [0, 0, -0.012],
    "b": [0, 0, 0.012],
    "radius": 0.013,
    "keys": [
      {"t": 0, "offset": [0, 0, 0.040]},
      {"t": 0.6, "offset": [0, 0, 0]},
      {"t": 1.4, "offset": [0, 0, -0.065]}
    ]
  }]
}
```

`rim` 以甄芙的开口为原点，局部 Z 轴向内。也可使用 `model` 或角色骨名，将道具绑到其他角色。球体使用 `shape: "sphere"`，以 `a` 为球心。静止道具可以直接指定 `offset`。相邻位置点按动作时间线性插值，多个形状可分别填写唯一的 `id`。已有场景道具可调用 `world.contacts.addCollider(object3D, {shape, a, b, radius})`，端点相对道具自身，移除道具时调用返回的注销函数。

### 剧情节点

关卡使用 `version: 1`、稳定的 `id`、`title`、`city: "hero13-v24"`、米制 glTF 坐标 `spawn: [x,y,z]`、`start` 及以 ID 为键的 `nodes`。对白和站位采用 UTF-8 JSON。旧关卡可继续使用 `hero13-v23`。

| kind | 主要字段 | 完成条件 |
| --- | --- | --- |
| dialogue | speaker、text、next 或 choices | 点继续或选择带 label、next 的选项 |
| walk | label、position、radius、next | 甄芙进入目的地半径 |
| drive | car、heading、route、可选 passenger、next | 上车经过有序路标，在终点刹停并下车 |
| interact | label、position、radius、verb、text、fields、next | 走近位置，主动操作并确认 |
| scene | position、timeOfDay、label、text、verb、next | 切换场景和光照后继续 |
| phone | contact、messages、next | 按次序收发全部消息 |
| slot | module、可选 file、next | 导入的模块结算、动作结束或直接继续 |
| motion | file、可选 seconds、next | 动作到时，或玩家跳过 |
| encounter | label、module、win、可选 great 和 lose | 模块结算，默认失败重新开始本场，默认大胜进入 win |
| end | text | 章节结束，写入完成记录 |

`encounter` 既可按文件名引用独立模块，也可将该模块的参数直接写在节点上。后续编辑器只需按本约定导出关卡、模块和已支持的动作文件。

### 多人对局

`lead` 是甄芙。每个 `opponents` 项各有 ID、名字、模型、初始值、体力、敏感度、防御和攻击速率。当前格式可定义 1–15 名对手，手机可显示人数取决于设备性能。界面中每条数值条范围均为 0–100。点选主要目标后，主动操作作用于该人，其他未结束的参与者按 `background` 比例继续变化。默认是 0.55。

| 字段 | 含义 |
| --- | --- |
| goal | first 表示任一对手先满即胜。all 表示全部对手到满即胜，先到满者停止累计 |
| danger | 80–90，默认 85。进入危险阶段后限制换姿势和主动收缩，并缩小时机窗口 |
| lead / opponents[] | id、model、label。start 默认为 0，stamina 默认为 100，sensitivity、attack、defense 默认为 1。gain 是基础每秒增量，可设为 0 来完全使用时间事件 |
| poses[] | name、self 和 other 是姿势及双方倍率，file 绑定动作，multipliers 可按对手 ID 微调 |
| seconds / events | 姿势的循环时长及事件。事件用 `{"at":3,"delta":{"lead":0.25,"guestA":1,"guestB":0.5}}` 分别给参与者加值，at 按动作时间递增。需要事件时指定 seconds |
| rewards | win、great、lose 分别是胜利、大胜及失败基础积分，胜利时按命中和操作附加最多 8 分 |

慢速、中速、快速、猛烈对应动作时间倍率 0.70、1.00、1.45、1.95。双方数值按不同速率累计。放松停顿冻结动作时钟和增量 2.5 秒。主动收缩持续 3 秒，精准刺激的效果取决于指针是否落在亮色窗口，请求放慢有 2 次。不同对手可独立改变压力并作出反应。单帧中越过 100 时按跨线先后结算，同时达到制胜条件为大胜。在 all 模式下，此条件是最后一位尚未结束的对手到满。

## 构建

从仓库根目录运行。需要 JDK 17+、SDK Platform 35、Build Tools 35、Python 3、NumPy、SciPy、Pillow，以及 meshoptimizer v0.23 的共享库。角色及城市源素材由下列输入恢复，源码分支不含大体积模型。

```sh
export ASSET_DIR="$PWD/build/city-assets" GAME_BUILD_DIR="$PWD/build/city-apk"
python3 game/tools/prepare_city.py /path/to/hero13-v23-zips "$ASSET_DIR/city" /path/to/libmeshoptimizer.so --district-update /path/to/hero13_city_v24_07_酒店区块更新.zip
python3 game/tools/prepare_cast.py /path/to/PoseStudio-1.3.0.apk /path/to/Zhenfu_Officewear_R06_Preview.zip "$ASSET_DIR" /path/to/libmeshoptimizer.so
python3 game/tools/prepare_vehicle.py /path/to/hero13_city_v24_07_酒店区块更新.zip "$ASSET_DIR/vehicles/dealer-suv.glb"
bash game/tools/build.sh
```

城市底包为 `hero13_city_v23_A_01-04.zip`、`hero13_city_v23_B_05-08.zip`、`hero13_city_v23_C_09-18.zip`，叠加 v24 第七区更新包后，构建器会用官方清单校验全部 18 个原始区块。从已交付游戏 APK 恢复 `assets/` 时，可将其作为 ASSET_DIR。用上方的 `prepare_city.py` 和 `prepare_cast.py` 重建酒店楼层与碰撞索引、套裙、贴合腿部的丝袜和臀部内壁。角色缓存中的 `wardrobe.json` 会标记本次适配版本 `skirt-knit-3`。成品在 GAME_BUILD_DIR 的 `Zhenfu-City-0.2.0.apk`。默认使用本机测试证书，可用 GAME_KEYSTORE、GAME_KEY_ALIAS、GAME_KEY_PASS 指定发行证书。城市场景和车辆的署名收录在 APK 的 `assets/city/credits/`。
