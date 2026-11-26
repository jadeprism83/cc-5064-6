# 可见性缓冲（Visibility Buffer）双阶段渲染原型

一个**真实的两阶段可见性缓冲管线**。第一阶段光栅化时只写入"可见图元 + 实例身份 +
重心坐标"，不写任何材质颜色；第二阶段完全不重画几何，只从身份/重心缓冲重建顶点属性
（位置、法线、UV），再执行材质着色。常规前向路径作为逐片元核查的基准。

> 关键约束已落实：第二阶段**不是**把第一阶段缓存的颜色换个名字，也**没有**重新提交
> 几何。`resolve` 通道绘制的只有一个全屏三角形，所有表面数据都从身份数据反查得到。

## 1. 图形入口

可见性缓冲的图形界面（GUI）是唯一完整管线入口：

| 入口 | 命令 | 说明 |
| --- | --- | --- |
| **Web 图形界面（主入口）** | `npm run serve` 后打开 `http://localhost:8080/` | 真实 GPU 双阶段管线、光栅调试视窗、材质切换、像素探针、逐像素差异 |
| 命令行（仅辅助可见性缓冲） | `npm run visbuf -- --width 320 --height 240 --out out` | 无 GPU 时的 CPU 参考实现，输出身份缓冲与着色 PNG、统计信息，用于离线核查不变量 |
| 自动化测试 | `npm test` | GLSL 结构检查 + CPU 管线不变量测试 |

命令行**只辅助**可见性缓冲（生成/检查身份与重心缓冲），不替代 WebGL2 真实管线。

## 2. 目录与图形入口对应关系

```
public/
  index.html              图形界面：六个光栅调试视窗 + 控制面板
  app.js                  界面装配、动画循环、视窗呈现、材质编辑、像素探针
  renderer.js             WebGL2 渲染器：三条通道 + 帧缓冲 + 度量
  shaders/
    visibility.vert/frag  阶段一：仅输出身份(R32UI)与重心(RGBA16F)
    resolve.frag          阶段二：从身份/重心重建属性并着色（无几何绘制）
    forward.vert/frag     常规前向参考路径（逐片元核查基准）
    debug-identity.frag   身份缓冲解码视窗
    debug-bary.frag       重心缓冲视窗
    diff.frag             解析结果与前向结果的逐像素差异
  data-tables.js          全局顶点表 / 索引表 / 几何表 / 三角形展开
  scene.js                几何索引、实例变换、材质身份三张分离的表 + 删除后编号复用
  materials.js            材质描述符、版本号、描述符快照表、卸载/重载
  geometry.js math.js     网格生成（含退化图元、共享顶点楔形）与矩阵/法线数学
  visibility-diagnostics.js 解码追踪、执行证据链、原因码、封存帧与重放（GPU/CPU 共用）
src/cli/visbuf.js         CPU 两阶段参考实现 + 诊断/封存/卸载重放（辅助命令行）
test/                     GLSL 结构检查、管线不变量、解码追踪与取证诊断测试
```

## 3. 两阶段数据流

### 阶段一：可见性光栅化（`visibility.*`）
- 每个网格展开为非索引三角形汤，`gl_VertexID / 3` 即几何内图元号。
- 片元输出两个附件，**不含颜色**：
  - `R32UI` 身份缓冲，位布局 `有效位(31) | 实例号(16..23) | 图元号(0..15)`；
  - `RGBA16F` 重心缓冲 `bary.xyz + depth`，重心作为普通 varying 由光栅器
    **透视正确**插值，与前向路径的 varying 插值方式一致。
- 清屏把身份缓冲置 0（有效位清零），因此背景/被裁剪像素是**显式无效**，
  绝不会被解读成"0 号实例 / 0 号三角形"。

### 阶段二：解析与材质着色（`resolve.frag`）
- 仅画一个全屏三角形，逐像素 `texelFetch` 身份与重心缓冲。
- 解包得到实例号与图元号，经**几何表**查到顶点/索引起始，再从**全局顶点表**
  取出该三角形三个索引顶点的位置、法线、UV。
- 用透视正确的重心权重重建对象空间属性，经实例模型矩阵（法线用逆转置矩阵）
  变换到世界空间，最后做与前向路径**完全相同**的光照。
- 实例越界、图元号越界分别用洋红/红色错误标记，并由界面告警，而非静默渲染。

## 4. 几何索引 / 实例变换 / 材质身份分离

三张表彼此独立（见 `scene.js`、`data-tables.js`）：

- 几何表：网格只上传一次，按稳定 `geometryId` 引用；
- 实例变换表：每实例独立的模型矩阵/逆转置法线矩阵；
- 材质身份表：每实例记录 `materialId` 与版本。

可见性缓冲写入的是**全局实例号**。界面提供"重排绘制批次"开关，会改变提交顺序，
但片元始终凭实例号反查自己的变换与材质，因此重排不会让任何片元读到别的实例数据。
该性质由 `test/run-tests.js` 的 "draw-batch reorder leaves per-pixel identity unchanged" 断言。

## 5. 两种材质描述符策略

界面"材质策略"下拉框可切换，对应需求中的两种办法：

1. **随可见缓冲保存描述符快照**（snapshot）
   可见性捕获时冻结材质纹理/基色/粗糙度/金属度及其版本号；之后即使材质被编辑，
   解析仍使用捕获时的描述符。勾选"冻结描述符快照"后编辑材质，可观察到版本错配
   （界面黄色告警 + 画面黄色提示叠加）。"重新捕获当前描述符快照"按钮释放冻结。
2. **采样前按版本重新绑定**（rebind）
   每次解析前按当前材质版本把实时纹理库绑定到采样器数组，始终使用最新描述符。

材质编号在帧内重用时，可见性缓冲通过身份中的实例号→材质身份表→对应版本绑定，
保证逐片元取到的是该像素对应实例在该版本下的材质，而不是仅凭材质槽位取错版本。

## 6. 边界与异常处理

- **背景**：身份有效位为 0，解析直接输出背景色。
- **裁剪产生的边界**：`src/cli/visbuf.js` 在齐次裁剪空间对六个平面做 Sutherland–
  Hodgman 裁剪，裁剪后扇形三角化；GPU 路径由硬件裁剪，二者身份语义一致。
- **退化图元**：零面积三角形不产生样本，但仍占用一个图元号，证明图元号与索引缓冲
  对齐、而非与"可见三角形顺序"对齐。测试断言退化的 0 号三角形永不出现。
- **无效身份**：任何有效位为 0 的像素都不会被当作零号三角形；越界身份用错误色标记。

## 7. 透视属性恢复与逐像素核查

- 透视恢复：存储的重心是 `b_i = (a_i / w_i) / Σ(a_k / w_k)`，解析时除以各顶点
  裁剪空间 `w` 再归一化，还原仿射权重，与前向硬件透视插值一致。
- 控制路径：关闭"透视正确属性恢复"会改用仿射权重，在**非均匀缩放**场景下与前向
  路径产生可测差异，差异图随之增大，用于验证恢复公式的正确性。
- 界面六个视窗：① 身份缓冲 ② 重心缓冲 ③ 双阶段着色结果（可切换
  世界坐标/法线/UV/反照率/身份假彩色）④ 前向参考 ⑤ 逐像素差异（可 ×8 放大）
  ⑥ 像素探针（悬停读取实例、图元、packed 值与解析/前向 RGB）。
- 侧栏给出覆盖像素、无效像素、平均/最大差异（0–255）与覆盖率。

## 8. 测试场景覆盖

- 不同程序化纹理：棋盘、条纹、同心环、网格、噪声；
- 非均匀缩放：每个实例的三轴缩放不同，考验逆转置法线与透视恢复；
- 动态模型：球体、圆环等随时间旋转；
- 退化图元批次：验证无效/退化处理；
- 批次重排：验证实例身份与提交顺序解耦。

## 9. 运行

```bash
npm run serve      # 打开 http://localhost:8080/ （图形入口，需要 WebGL2 浏览器）
npm test           # GLSL 结构检查 + 管线不变量 + 解码追踪/取证诊断
npm run visbuf -- --width 320 --height 240 --reorder --out out
npm run visbuf -- --affine --out out       # 仿射控制路径对照
```

无头/无 WebGL2 环境下，`npm test` 与 `npm run visbuf` 仍可运行，用于核查身份/重心
契约；完整着色画面请在支持 WebGL2 的浏览器中通过图形入口查看。

## 10. 可见性解码追踪与像素取证诊断

图形界面第 **⑦ 号视窗「可见性诊断（解码追踪）」** 是该能力的入口，侧栏
「可见性取证与诊断」面板的按钮全部调用 `renderer.js` 的真实实现
（`readVisibilityBuffers` / `traceVisibilityPixel` / `runVisibilityDiagnostics` /
`captureVisFrameArchive` / `replayVisFrameArchive`），底层共用
`public/visibility-diagnostics.js`。**不存在固定数据冒充的身份/着色图**：
诊断图逐像素来自对 GPU 回读的 R32UI 身份与 RGBA16F 重心缓冲重新追踪。

### 10.1 同一帧的两种用法
- **实时显示**：`live` 模式下诊断视窗对当代可见缓冲节流复跑（stride 抽样 +
  `LogBudget` 有界预算），一键「回到实时可见缓冲」即用当代资源重新生成。
- **取证快照**：「封存当前可见性帧」把身份/重心/相机/实例/几何/材质描述符与
  纹理冻结为 `vis-frame-archive`，可导出 JSON 长期保存；「重放封存帧」在材质
  热换后仍逐像素还原捕获时的原三角颜色（测试断言逐像素一致）。

### 10.2 执行证据链与原因码
`tracePixel` 对每个像素按阶段记录证据：`decode → instance-table →
geometry-table → vertex-fetch → attribute-recover → material-binding →
material-shade → verify`。每个异常都归到明确 `ReasonCode` 与阶段，并附带
恢复属性（世界坐标/法线/UV/反照率/权重）与像素差异：

| 原因 | 阶段 | 含义 |
| --- | --- | --- |
| `instance-out-of-range` / `identity-corrupt` | decode / instance-table | 身份编码问题，洋红/红标记并中止 |
| `geometry-unloaded` / `material-unloaded` | geometry-table / material-binding | 旧编号资源已卸载，标出缺失依赖并**停在那次绘制** |
| `material-stale-binding` | material-binding | 编号复用/热换后首次读到旧属性，记录绑定版本与实时版本 |
| `material-boundary` | material-shade | 实例重用边界或材质自身纹素边界，与属性错读区分 |
| `bary-non-normalized` / `bary-perspective-mismatch` / `attribute-misread` | attribute-recover / verify | 属性错读，定位到恢复阶段并记录像素差异 |
| `shared-vertex-derivative` / `out-of-bounds-fetch` | vertex-fetch | 共享顶点导数与越界读取区分，可回溯实际被着色三角形 |

干净帧只允许出现 `clean` / `background` / `material-boundary`，诊断器**不允许
伪报**（由 `clean frame produces no false-positive anomaly codes` 测试守护）。

### 10.3 编号复用与缺失依赖
- 「模拟删除后编号复用」调用 `deleteAndReuseInstanceId`：删除实例并把其编号
  复用到几何/材质不同的新物体，重放旧单帧时凭三角标识与材质版本在
  **material-binding** 阶段标出陈旧绑定，而不是把新物体属性静默当成旧像素。
- 「模拟旧编号资源卸载」会把几何/材质标记卸载，重放时诊断器聚合
  `missingDependencies` 并把对应像素着成原因标记色，绘制在该处中止。
- 「复位场景与资源」恢复实例编排、重载材质并回到实时缓冲。

### 10.4 日志成本控制
整帧分析采用 `stride` 抽样与 `LogBudget(maxEvents,maxPixels)` 双上限，超预算即
截断并在结果中置 `truncated`；GUI 实时诊断默认每 12 帧复跑一次，避免取证日志
拖慢动画。`log budget caps forensic log cost` 测试验证上限生效。

### 10.5 命令行辅助（不替代图形入口）
`npm run visbuf` 仅作离线核查，新增标志：

```bash
npm run visbuf -- --diagnose                       # 复跑追踪，输出原因分布与有界日志
npm run visbuf -- --archive --out out              # 额外写出 vis-frame.json 取证快照
npm run visbuf -- --archive --unload-material 1 \
                 --unload-geometry 0 --out out     # 卸载重放，报缺失依赖并中止
```

不带新标志的旧调用与旧 `vis-frame.json` 仍运行到底（向后兼容由
`archived frame JSON round-trips` 测试覆盖）。

