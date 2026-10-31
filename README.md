# mira_device — DSH 的「输入」

三件套里的**第 2 件**：把**摄像头 / 麦克风 / 虚拟采集器**（`muse_galaxy` 等）统一成一路输入，
自动按 VAD 切句、按间隔自动推帧识别，并把识别结果作为**插话（steer）**送进会话。
它**依赖 `mira_media`**：断句阈值、语音识别、识图所用的 key 都在那边。

```
muse_vtuber ──┐
              ├─→ mira_device ──→ mira_media        （箭头 = "依赖"）
muse_galaxy ──┘   （本插件）      （TTS/ASR/VAD/凭据）
```

- 版本：**1.0.0**（2026-11-01 从 `muse_vtuber` 3.1.0 拆出）
- 位置：`PluginDSH/mira_device`
- 依赖：`miraMedia` 服务（注入）；零第三方依赖

---

## 1. 它负责什么

| 能力 | 落地 |
|---|---|
| 摄像头 | 浏览器 `getUserMedia`（`camera.*`）；开关是 `state.cameraOn`，来源 `state.cameraSource`（`device` / `galaxy` / `none`） |
| 麦克风 | 浏览器采集 + 本地 VAD 断句 → `POST /device/api/asr`；开关 `state.micOn`，来源 `state.micSource` |
| 虚拟采集器 | 采集口 `/device/api/capture/*`（本机回环 + 令牌）；MJPEG 分发 `/device/api/stream.mjpg`；`capture.autoSwitch` 自动把来源切到 `galaxy` |
| 自动分段语音 | 本机设备：浏览器 VAD；采集器：宿主侧用 `miraMedia.createSegmenter()`（阈值是 `mira_media` 的 `vad`） |
| 自动推帧 | `vision.autoIntervalMs > 0`：本机设备由浏览器抓帧 POST `/vision`；采集器源由宿主定时抓缓存帧 → `miraMedia.describeImage()` |
| 插话 | `events.*` 模板 + 限流 + `agent.steer()`；消息的 `source.kind = 'mira_device'` |
| agent 取一帧 | 工具 `device_look`：`vision.provider=dsh`（默认）把帧交给当前模型看；`aliyun` 服务端识图返回文字 |
| 设置页 | `settings.section` → **「输入」**：设备、采集器、自动推帧、事件流（key 只读转述「声音」） |

它**不负责**：画（`muse_vtuber`）、出声与识别实现（`mira_media`）。

## 2. 落盘（约定1 / 约定3 / 约定7）

```
$DSH_HOME/mira_config/mira_device/
  config.json             配置（schemaVersion 1）。唯一会自动创建的文件
  state.json              输入实况（摄像头/麦克风开关、来源，schemaVersion 1）
  capture.json            采集口令牌（600，首次自动生成；muse_galaxy 读它）
```

**热生效**：`config.json` 内容变了，下一次读取就重新加载；`state.json` 每次写入都原子替换。

## 3. 配置表

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不注册工具与路由 |
| `camera.enabled` | `true` | 关掉后按钮与 `device_look` 报 `config/missing` |
| `camera.deviceId` | `""` | 留空 = 浏览器默认设备 |
| `camera.width` / `height` | `640` / `480` | `getUserMedia` 的 `ideal` |
| `mic.enabled` | `true` | |
| `mic.deviceId` | `""` | 留空 = 默认输入设备 |
| `mic.sampleRate` | `16000` | 送识别的目标采样率（浏览器侧重采样） |
| `capture.enabled` | `true` | 关掉后采集口回 503 |
| `capture.fps` / `capture.width` | `8` / `720` | 告诉采集器的"设备口径"（真机 4fps/480 偏糊） |
| `capture.audio` | `true` | 要不要采集器的 PCM |
| `capture.autoSwitch` | `true` | 采集器接入时自动切来源到 `galaxy` |
| `capture.maxAudioMs` | `30000` | 单句 PCM 缓冲上限 |
| `capture.staleMs` / `lostMs` | `3000` / `15000` | 多久没数据算 stalled / lost（lost 会 close 并把来源回落） |
| `vision.enabled` | `true` | 关掉后 `device_look` 与自动推帧都不可用 |
| `vision.provider` | `dsh` | `dsh` = 帧作为图片交给当前会话模型（不花第三方额度）；`aliyun` = 服务端识图 |
| `vision.base` | `https://token-plan.maas.qianwenaiapi.com/api/v1` | 识图地址（key 在 `mira_media`） |
| `vision.model` | `qwen3.8-flash` | 网关没有 VL 专模，这个能收图（实测）；官方 DashScope 用 `qwen-vl-max-latest` |
| `vision.prompt` | 一句中文描述 | 自动推帧用的提示词 |
| `vision.timeoutMs` | `30000` | |
| `vision.autoIntervalMs` | `0` | `>0` = 定时自动推帧识别并插话；`0` = 关（默认关：会持续消耗额度） |
| `events.enabled` | `true` | 识别结果自动进会话 |
| `events.steer` | `true` | `true` = 插话；`false` = 只显示在侧边栏 |
| `events.voiceTemplate` | `[感知·语音] {text}` | 支持 `{kind} {text} {time} {date} {sessionId}` |
| `events.visionTemplate` | `[感知·画面] {text}` | 同上 |
| `events.minIntervalMs` | `5000` | 两条之间最小间隔 |
| `events.maxPerMin` | `6` | 每分钟上限 |
| `events.cooldownKeyMs` | `30000` | 同一句话的冷却 |
| `events.maxChars` | `400` | 单条事件正文字数上限 |

`vision.provider=aliyun` 的自动推帧需要一个能"看图"的云端 key（阿里云 DashScope；
本机现在的 `mira_media` 已接 token-plan 网关的 key，`/device/api/vision` 实测可用）；
把 `mira_media` 指向本机 stream 网关时，TTS/ASR 不需要云端 key，但**自动推帧仍不可用**
（网关没有 OpenAI 兼容的看图端点），此时用 `device_look`（默认 `dsh` 模式，把帧交给当前模型看）。

> **断句阈值不在这里**：`vad.*` 属于 `mira_media`（「设置 · 声音」）。「设置 · 输入」里只显示
> 当前值（只读转述），改要去声音页 —— 一份阈值，三种输入共用。

## 4. 工具（5 个）

| 工具 | 干什么 | 失败长什么样 |
|---|---|---|
| `device_status` | 只读：开关/来源、每路采集器的帧数与断句数、断句阈值、自动推帧间隔、ASR/识图就绪、页面数 | 永不失败 |
| `device_camera` | 开/关摄像头（不传 `on` = 切换）；来源是采集器时表示"要不要接收那路流" | — |
| `device_mic` | 开/关麦克风 | — |
| `device_look` | 取当前一帧 → **默认交给当前会话的模型看**（`vision.provider=dsh`，走附件库，`render` 返回 `[说明文字, image 块]`）；`aliyun` 时服务端识图回文字。**采集器源直接用宿主缓存帧，不需要页面在场** | 摄像头没开 → `camera/closed`；本机源没页面 → `delivery/failed`；没有附件服务 → `platform/unsupported`；模型不收图 → `vision/unsupported` |
| `device_listen` | 让浏览器录 N 秒 → `miraMedia.transcribe()` → 文字；`steer:true` 顺手插话 | 麦克风没开 → `mic/closed`；采集器源 → `mic/external`（它自己会送整句） |

## 5. 服务契约（`miraDevice`）

```js
miraDevice.status()                       // 只读状态（含 audio/vad/capture/vision/events）
miraDevice.state()                        // { cameraOn, micOn, cameraSource, micSource, ... }
miraDevice.setState(patch, { by })        // 白名单字段，落盘 + 广播
miraDevice.setSource(kind, source)        // kind='camera'|'mic'，source='device'|'galaxy'|'none'
miraDevice.frame()                        // 采集器缓存帧 { captureId, label, at, dataUrl } 或 null
miraDevice.capture()                      // 采集口状态（每路流/订阅者/令牌文件）
miraDevice.streamUrl()                    // '/device/api/stream.mjpg'
miraDevice.percept({ kind, text, sessionId, auto })   // 按本插件的模板/限流送进会话
miraDevice.publicConfig() / miraDevice.settingsView()
```

## 6. HTTP 面（`/device/api/*`）

| 方法与路径 | 作用 |
|---|---|
| `GET /device/api/bootstrap` | 配置（脱敏）、state、vad（转述）、能力/依赖就绪、endpoints |
| `GET /device/api/events` | **SSE**：`hello` / `state` / `capture/level` / `capture/heard` / `capture/seen` / `command` |
| `POST /device/api/state` | 开关/来源 → `state.json` → 广播（`clientId` 记成 `by: client:<id>`） |
| `POST /device/api/result` | 浏览器回执（`look` / `listen` 的结果，按 `requestId` 配对） |
| `POST /device/api/asr` | `{ base64, mime, sessionId, auto }` → 识别 →（按 `events`）插话 |
| `POST /device/api/vision` | `{ image, prompt?, sessionId, auto }` → 识图 →（同上）插话 |
| `GET/POST /device/api/settings` | 设置页读写（**没有 apiKey 字段**：凭据只有 `mira_media` 一份） |
| `GET /device/api/health` | 存活探针（`features.capture` 齐全，`muse_galaxy` 用它探测） |

**采集口**（只接受本机回环 + `Authorization: Bearer <capture.json 里的 token>`）：

| 方法与路径 | 作用 |
|---|---|
| `POST /device/api/capture/open` | `{label, source, sessionId?, fps?, width?, audio?}` → `{captureId, want, cameraUrl}`；同一 `source` 幂等；`autoSwitch` 时自动切来源 |
| `POST /device/api/capture/frame` | `{captureId, jpeg}`（≤2MB）→ 存最近一帧并分发给面板 |
| `POST /device/api/capture/pcm` | `{captureId, pcm(base64 s16le), sampleRate}` → 宿主按 `vad` 断句 → ASR → 插话；回 `{level}` |
| `POST /device/api/capture/ping` | 纯音频流维持心跳 |
| `POST /device/api/capture/close` | `{captureId, reason}`；之后同 id 回 404，来源回落 |
| `GET /device/api/stream.mjpg?capture=` | `multipart/x-mixed-replace`，面板 `<img>` 直接播（**只读 + 同源**，不要令牌：`<img>` 发不出 Authorization 头） |

## 7. 页面全局契约（给 `muse_vtuber` 用）

```js
window.__miraDevice__ = {
  version, ready(), state(), subscribe(fn), subscribeLog(fn),
  setCamera(on), setMic(on), setSource(kind, source),
  videoStream(), analyser(), level(), frame(quality),
  heard(), seen(), captureUrl(), sessionId(),
}
```

形象页签的视频/音频面板与频谱环都从这里取数据；**采集单例只有一份**（切页签不会重新申请
权限、也不会掉流）。所有 `getUserMedia` 都在这个模块里，形象插件不碰硬件。

## 8. 迁移（从旧 `muse_vtuber`）

1. **配置**：第一次创建 `config.json` 时从旧 `muse_vtuber` 配置迁移
   `camera` / `mic`（不含 `vad`）/ `capture` / `vision` / `events`。
2. **状态**：新建 `state.json`（默认关闭、来源 `device`）；旧 `muse_vtuber/state.json` 里的
   `cameraOn/micOn/cameraSource/micSource` 不再读取（也不会被删除）。
3. **令牌**：`muse_galaxy` 的默认令牌路径已改为 `mira_config/mira_device/capture.json`；
   旧 `muse_vtuber/capture.json` 不再使用（可手工删除）。
4. 回滚：停用 `mira_device`，旧 `muse_vtuber` 3.x 仍自带完整的输入能力（代码在 SVN 历史里）。

## 9. 已知取舍

1. **断句在浏览器侧做**（本机设备），不上传音频流：阿里云只收到"一句一段的 WAV"。
   采集器源的 PCM 由宿主接、宿主按同一套阈值断句。
2. **自动推帧默认关**：定时抓帧会持续消耗额度，要开就显式开（`vision.autoIntervalMs`）。
3. **多页面时摄像头/麦克风是每台设备自己的硬件**：`cameraOn/micOn` 是会话级意图，
   只有发起改动的页面会和自己的硬件对齐（`by: client:<id>`），别的页面只同步外观。
4. **`device_look` 在采集器源下不需要页面**（帧就在宿主内存里）；本机设备源必须有页面。
5. **权限**：这两个不是"控制形象"，所以**不做账号权限判定**（形象账号只约束"形象长什么样"）。
   摄像头/麦克风是用户自己机器上的设备，开关只在页面里生效。
6. 插话消息的 `source.kind = 'mira_device'`（会话格式 v4 要求生产者自己的名字）。

## 10. 验收

```
node test/smoke.mjs                 # → ALL PASS（通过 39 项断言），退出 0
node ..\tool_shared\tools\check-zero-dep.mjs mira_device
node ..\tool_shared\tools\check-kit.mjs
```

手工：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 设置 · 输入 | 三个分组（摄像头/麦克风、采集器、图像识别、事件流）；VAD 一行是只读转述，写着"在「声音」里" |
| 2 | 点输入框「摄像头」 | 形象侧边栏「视频」出画面；再点一次黑屏 |
| 3 | 点「麦克风」说一句话 | 「音频」波形随声音动；停顿后出现「听到：…」；`device_status` 里 ASR 计数 +1 |
| 4 | 把 `vision.autoIntervalMs` 设为 3000，开摄像头 | 每 ~3 秒侧边栏出现「看到：…」（需要 `mira_media` 配了 key） |
| 5 | `muse_galaxy` 播一个视频 | `device_status.capture.sources` 出现一路；侧边栏视频走 MJPEG；播完来源回落 |
| 6 | 对模型说「看看我现在什么样」 | 模型调 `device_look`，返回画面描述（`dsh` 模式 = 它自己看） |
