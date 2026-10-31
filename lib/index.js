/**
 * mira_input —— DSH 的「输入」插件（三件套拆分后的第 2 件）
 *
 * 一句话：把**摄像头 / 麦克风 / 虚拟采集器**（muse_galaxy 等外部流）统一成一路"输入"：
 * 自动把语音按 VAD 切句、按间隔自动推帧识图，并把识别结果作为插话送进会话；
 * 同时暴露 `miraInput` 服务与 `input_*` 工具，别的插件也能复用"拿一帧 / 开关输入"。
 *
 * 结构（每个模块一件事）：
 *   config.js   配置默认值 / 规整 / config.json 原子写 / 热生效（schemaVersion 1）
 *               首次创建时从旧 muse_vtuber 配置迁移 camera/mic/capture/vision/events
 *   state.js    输入实况（摄像头/麦克风开关、来源）落 state.json
 *   events.js   SSE 事件总线 + 感知事件投递（插话 steer）+ 限流
 *   capture.js  外部采集器接入（虚拟摄像头/麦克风）：令牌、MJPEG 分发、断句→识别、自动推帧
 *   routes.js   /input/api/*（bootstrap / state / events / asr / vision / settings / capture/*）
 *   tools.js    input_status / input_camera / input_mic / input_look / input_listen
 *   client.js   （浏览器侧）采集单例 + 输入框按钮 + 设置页「输入」
 *
 * 依赖方向（箭头 = "依赖"）：
 *   muse_vtuber ──┐
 *                 ├─→ mira_input ──→ mira_audio
 *   muse_galaxy ──┘   （本插件）      （TTS/ASR/VAD/凭据）
 *
 * 分工边界：
 *   · 断句阈值（vad）、语音识别、语音合成、识图所用的 key → mira_audio
 *   · 设备与流（摄像头/麦克风/采集器/自动推帧间隔/限流与插话） → 这里
 *   · 画出来（LIVE2D 与右侧栏） → muse_vtuber
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  claimInstance, ensureDir, fail, makeCounters, miraConfigDir, warnCount,
} from './kit.mjs'
import { ConfigStore, legacySeed, publicConfig } from './config.js'
import { StateStore } from './state.js'
import { EventHub } from './events.js'
import { CaptureHub } from './capture.js'
import { createHandler, buildSettingsView } from './routes.js'
import { registerTools, statusView, TOOL_NAMES } from './tools.js'

export const name = 'mira_input'

/**
 * 硬依赖（缺了插件不加载，比「一半可用」好排查）：
 *   tools             注册 input_* 工具
 *   webServer         /input/api/* 与采集口
 *   sessionController 把感知事件 steer 进会话
 *   sessions          投递后 flush
 *   miraAudio         断句（VAD）/ 识别（ASR）/ 识图（同一份 key）—— 本插件**依赖**声音插件
 */
export const inject = ['tools', 'webServer', 'sessionController', 'sessions', 'miraAudio']

const INSTANCE_ID = 'mira_input'
const SERVICE_NAME = 'miraInput'
const VERSION = '1.0.0'

export function apply(ctx, config) {
  const logger = ctx.logger || null
  const counters = makeCounters()
  counters.pluginName = 'mira_input'

  if (config && config.enabled === false) {
    logger?.info?.('[mira_input] 已禁用（config.enabled = false），不注册工具与路由')
    return fail('plugin/disabled', 'mira_input 被 config.enabled=false 禁用', '把配置里的 enabled 改回 true 再重载')
  }

  // 约定6：两个实例 = 两套 SSE 客户端表 + 两份路由 = 事件重复投递
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[mira_input] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '两个实例会让同一个感知事件被投递两次。检查 profile 是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'mira_input 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_input 挂了两遍；一个进程只允许一个实例')
  }

  const baseDir = miraConfigDir('mira_input')
  const configStore = new ConfigStore({ baseDir, patch: config || {}, logger, seed: legacySeed })
  let stateStore = null
  let hub = null
  let captureHub = null
  let disposeTools = null
  let routeDisposer = null
  let disposeProvide = null

  const releaseAll = () => {
    try { disposeProvide?.() } catch { /* 退场不抛 */ }
    try { disposeTools?.() } catch { /* noop */ }
    try { routeDisposer?.() } catch { /* noop */ }
    try { captureHub?.dispose() } catch { /* noop */ }
    try { hub?.dispose() } catch { /* noop */ }
    try { stateStore?.flush() } catch { /* noop */ }
    try { claim.release() } catch { /* noop */ }
  }

  let sessionControllerSvc = null
  let sessionsSvc = null
  try { sessionControllerSvc = ctx.sessionController || null } catch { sessionControllerSvc = null }
  try { sessionsSvc = ctx.sessions || null } catch { sessionsSvc = null }

  // 软取（没有也不能拦住整个插件）：input_look 默认要把帧交给模型自己看，靠这两个服务。
  // attachments = 宿主附件库（saveImage，和 read_image 同一条路）；llm = 查当前模型吃不吃图片输入。
  const softGet = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  const attachmentsSvc = softGet('attachments')
  const llmSvc = softGet('llm')

  async function resolveAgent(sessionId) {
    if (!sessionControllerSvc || typeof sessionControllerSvc.resolveAgent !== 'function') {
      throw new Error('sessionController.resolveAgent 不可用')
    }
    const result = await sessionControllerSvc.resolveAgent(sessionId)
    if (result && result.agent) return result.agent
    const err = result && result.error
    throw new Error('resolveAgent 失败：' + (err && (err.message || err.code) ? (err.message || err.code) : String(err)))
  }

  const currentCfg = () => {
    try {
      return configStore.current()
    } catch {
      return configStore.cache || { camera: {}, mic: {}, capture: {}, vision: {}, events: {} }
    }
  }

  try {
    ensureDir(baseDir)
    const loaded = configStore.load()
    if (loaded.error) {
      logger?.warn?.('[mira_input] 配置不可用（' + loaded.error.code + '）：' + loaded.error.message
        + '；工具会拒绝使用，文件原样保留')
    }
    for (const warning of loaded.warnings || []) logger?.warn?.('[mira_input] 配置：' + warning)
    if (loaded.seededFrom) {
      logger?.info?.('[mira_input] 首次创建配置：已从旧 muse_vtuber 配置迁移 camera/mic/capture/vision/events（' + loaded.seededFrom + '）')
    }

    stateStore = new StateStore({ baseDir, logger })
    const stateLoaded = stateStore.load()
    if (stateLoaded.error) {
      warnCount(logger, counters, stateLoaded.error.code,
        'state.json 不可用，界面状态按默认值展示（原文件保留）：' + stateLoaded.error.message)
    }

    hub = new EventHub({ config: null, resolveAgent, sessions: sessionsSvc, logger, counters })
    try {
      hub.setConfig(configStore.current())
    } catch { /* 配置坏了：hub 用默认值撑住，投递时会拿到明确错误 */ }

    // miraAudio 服务：断句/识别/识图都借它（inject 已声明，这里再取一次最新引用）
    const audioOf = () => ctx.miraAudio

    captureHub = new CaptureHub({
      config: currentCfg,
      audio: audioOf,
      hub,
      stateStore,
      baseDir,
      logger,
      counters,
    })

    const deps = {
      configStore,
      stateStore,
      audio: audioOf,
      hub,
      captureHub,
      attachments: attachmentsSvc || null,
      llm: llmSvc || null,
      logger,
      counters,
      statusView: () => statusView(deps),
    }

    /**
     * 对外服务（别的插件 `inject: ['miraInput']` 拿到的就是它）。
     * 契约写进 README「§3 服务契约」：拿帧、开关输入、看采集状态、把一条感知结果送进会话。
     */
    const service = {
      version: VERSION,
      /** 只读状态（含采集器、ASR/识图就绪、限流参数、计数）。 */
      status: () => statusView(deps),
      /** 输入实况：{ cameraOn, micOn, cameraSource, micSource, updatedAt, by }。 */
      state: () => stateStore.snapshot(),
      /** 写输入实况（白名单字段），返回 { state, changed } 并广播给页面。 */
      setState: (patch, options = {}) => {
        const result = stateStore.set(patch, { by: String(options?.by || 'service') })
        if (result.changed.length) hub.broadcast('state', { state: result.state, changed: result.changed, by: 'service' })
        return result
      },
      /** 切输入来源：kind = 'camera' | 'mic'，source = 'device' | 'galaxy' | 'none'。 */
      setSource: (kind, source) => {
        const value = ['device', 'galaxy', 'none'].includes(String(source)) ? String(source) : 'device'
        const key = kind === 'camera' ? 'cameraSource' : 'micSource'
        return service.setState({ [key]: value }, { by: 'service' })
      },
      /** 采集器缓存里的最近一帧（外部源才有；本机设备源请用工具 input_look）。 */
      frame: () => (captureHub ? captureHub.currentFrame() : null),
      /** 采集器（虚拟摄像头/麦克风）状态与统计。 */
      capture: () => (captureHub ? captureHub.status() : null),
      /** 面板用的 MJPEG 地址（采集器源）。 */
      streamUrl: () => '/input/api/stream.mjpg',
      /** 把一条感知结果按输入侧的策略（模板/限流/开关）送进会话。 */
      percept: (input = {}) => hub.perceive({
        kind: input.kind === 'vision' ? 'vision' : 'voice',
        text: String(input.text ?? ''),
        sessionId: String(input.sessionId ?? ''),
        auto: input.auto !== false,
      }),
      /** 公开配置（不含路径与凭据）。 */
      publicConfig: () => publicConfig(currentCfg()),
      /** 设置页视图（同一份数据，别的插件想展示也能用）。 */
      settingsView: () => buildSettingsView(deps),
    }

    disposeProvide = ctx.provide(SERVICE_NAME, service)

    disposeTools = registerTools(ctx, deps)

    routeDisposer = ctx.webServer.register({
      kind: 'prefix',
      path: '/input',
      handler: createHandler(deps),
    })

    ctx.effect(() => () => releaseAll())

    const status = configStore.status()
    const cap = captureHub.status()
    logger?.info?.('[mira_input] 已加载：服务 ' + SERVICE_NAME + '，工具 ' + TOOL_NAMES.length + ' 个，'
      + '摄像头 ' + (currentCfg().camera.enabled ? '开' : '关') + '，麦克风 ' + (currentCfg().mic.enabled ? '开' : '关')
      + '，采集口 ' + (cap.enabled ? '开' : '关') + '（' + cap.tokenFile + '，现在 ' + cap.sources.length + ' 路）'
      + '，自动推帧 ' + (currentCfg().vision.autoIntervalMs > 0 ? currentCfg().vision.autoIntervalMs + 'ms' : '关')
      + '，接口 /input/api/')
    if (status.error) {
      logger?.warn?.('[mira_input] config.json 处于错误状态（' + status.error.code + '）：' + status.error.message)
    }

    return {
      ok: true,
      service: SERVICE_NAME,
      configFile: configStore.file,
      stateFile: stateStore.file,
      seededFrom: status.seededFrom || '',
      tools: TOOL_NAMES.length,
      api: '/input/api/',
      captureTokenFile: cap.tokenFile,
      configError: status.error,
    }
  } catch (error) {
    // 装配失败必须回滚干净：服务/工具/路由/采集器/单实例认领都要释放，否则只能重启进程
    releaseAll()
    logger?.warn?.('[mira_input] 加载失败，已回滚服务/工具/路由/采集器/单实例认领：' + (error?.message || error))
    throw error
  }
}

/** 供自检脚本使用（不是 DSH 接口）。 */
export const __testing = {
  TOOL_NAMES,
  SERVICE_NAME,
  VERSION,
  root: dirname(fileURLToPath(import.meta.url)),
}
