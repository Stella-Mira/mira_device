/**
 * mira_input / config.js —— 「输入」插件的配置：默认值 + 规整 + 落盘（config.json，schemaVersion 1）
 *
 * 两条来源（与 mira_audio / mira_live2d 同口径）：
 *   · cordis patch 里的 config：宿主启动时给的一份基线（升级时会被覆盖的那层）；
 *   · `$DSH_HOME/mira_config/mira_input/config.json`：**权威值**，设置页保存就写这里，热生效。
 * 文件不存在时按「配置 → 内置默认」原子写一份出来（这是唯一会自动创建的文件）。
 *
 * 分工（与 mira_audio 的边界）：**设备与流**归这里（摄像头/麦克风/虚拟采集器/自动推帧），
 * **断句阈值**归 mira_audio（`vad`），**凭据**也归 mira_audio。识图的 base/model 在这里 ——
 * 它决定"看什么/多久看一次"，而调用那份 key 是 miraAudio.describeImage() 的事。
 *
 * 约定2（显式优先）：必填项（API key）不在这里；约定7（配置版本）：schemaVersion 不匹配 →
 * 保留原文件、拒绝使用、给迁移提示，不静默兼容。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  MiraError, checkSchema, deepMerge, ensureDir, miraConfigDir, writeJsonAtomic,
} from './kit.mjs'

export const CONFIG_SCHEMA = 1

const QWEN_API = 'https://token-plan.maas.qianwenaiapi.com/api/v1'

export const DEFAULTS = {
  enabled: true,
  // 摄像头：宽度/高度是请求分辨率（浏览器可能给更接近的档位）
  camera: {
    enabled: true,
    deviceId: '',
    width: 640,
    height: 480,
  },
  // 麦克风：deviceId 留空 = 浏览器默认输入设备；sampleRate 是送识别的目标采样率
  // （浏览器侧重采样）。断句阈值不在这里 —— 那是 mira_audio 的 vad。
  mic: {
    enabled: true,
    deviceId: '',
    sampleRate: 16000,
  },
  // 外部采集器（muse_galaxy 等）：把视频流/直播流包成"虚拟摄像头 / 虚拟麦克风"。
  // 这里只是"设备口径"（要几帧、多宽、要不要音频）与失联判定；取帧/断句策略不在这里。
  capture: {
    enabled: true,
    // 真机看 4fps/480 偏糊：默认抬到 8fps/720（采集器按这个换算 scale 与 fps）
    fps: 8,
    width: 720,
    audio: true,
    autoSwitch: true,
    maxAudioMs: 30000,
    staleMs: 3000,
    lostMs: 15000,
  },
  // 图像识别（帧的"看"法）。provider：
  //   dsh    = 把这一帧作为图片放进工具返回值，交给当前会话的模型自己看（不调第三方、不额外花钱）
  //   aliyun = 服务端调视觉模型返回一段文字（自动推帧必须用它，因为那条路不经过模型）
  // base/model 由本插件决定，key 由 mira_audio 提供（同一份，不在这里重复存）。
  vision: {
    enabled: true,
    provider: 'dsh',
    base: QWEN_API,
    model: 'qwen3.8-flash',
    prompt: '用一句中文说清画面里发生了什么、有谁、在做什么。只描述你真正看到的，不要猜测。',
    timeoutMs: 30000,
    // >0 = 摄像头开着时按这个间隔自动抓帧识别并插话；0 = 只用工具/手动
    autoIntervalMs: 0,
  },
  // 感知事件流：识别结果作为插话（steer）投进会话 + 防刷屏参数
  events: {
    enabled: true,
    steer: true,
    voiceTemplate: '[感知·语音] {text}',
    visionTemplate: '[感知·画面] {text}',
    minIntervalMs: 5000,
    maxPerMin: 6,
    cooldownKeyMs: 30000,
    maxChars: 400,
  },
}

const NUM_RULES = {
  'camera.width': [160, 4096],
  'camera.height': [120, 4096],
  'mic.sampleRate': [8000, 48000],
  'capture.fps': [1, 15],
  'capture.width': [160, 1920],
  'capture.maxAudioMs': [1000, 120000],
  'capture.staleMs': [500, 60000],
  'capture.lostMs': [1000, 300000],
  'vision.timeoutMs': [1000, 120000],
  'vision.autoIntervalMs': [0, 3600000],
  'events.minIntervalMs': [0, 3600000],
  'events.maxPerMin': [1, 600],
  'events.cooldownKeyMs': [0, 86400000],
  'events.maxChars': [1, 4000],
}

const BOOL_KEYS = [
  'enabled',
  'camera.enabled',
  'mic.enabled',
  'capture.enabled',
  'capture.audio',
  'capture.autoSwitch',
  'vision.enabled',
  'events.enabled',
  'events.steer',
]

const STRING_KEYS = [
  'camera.deviceId',
  'mic.deviceId',
  'vision.provider',
  'vision.base',
  'vision.model',
  'vision.prompt',
  'events.voiceTemplate',
  'events.visionTemplate',
]

function getPath(obj, path) {
  let cur = obj
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

function setPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[keys[keys.length - 1]] = value
}

/** `~/x` / 相对路径 都落成绝对路径；空值原样返回空串。 */
export function expandPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(text)
}

/** 规整配置（不抛）：返回 { value, warnings }。 */
export function normalizeConfig(raw, { configFile = '' } = {}) {
  const warnings = []
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('配置不是 JSON 对象，已整体回落到默认值')
  }
  const value = deepMerge(structuredClone(DEFAULTS), input)

  for (const [path, [min, max]] of Object.entries(NUM_RULES)) {
    const current = getPath(value, path)
    const num = typeof current === 'number' ? current : Number(current)
    if (current === '' || current === null || current === undefined || Number.isNaN(num)) {
      setPath(value, path, getPath(DEFAULTS, path))
      warnings.push(path + ' 不是数字，已用默认值 ' + getPath(DEFAULTS, path))
      continue
    }
    if (num < min || num > max) {
      const clamped = Math.min(max, Math.max(min, num))
      setPath(value, path, clamped)
      warnings.push(path + '=' + num + ' 超出 [' + min + ',' + max + ']，已改成 ' + clamped)
      continue
    }
    setPath(value, path, num)
  }

  for (const path of BOOL_KEYS) {
    const current = getPath(value, path)
    if (typeof current !== 'boolean') {
      setPath(value, path, getPath(DEFAULTS, path))
      warnings.push(path + ' 不是布尔值，已用默认值 ' + getPath(DEFAULTS, path))
    }
  }

  for (const path of STRING_KEYS) {
    const current = getPath(value, path)
    if (typeof current === 'string') continue
    if (current === undefined || current === null) {
      setPath(value, path, getPath(DEFAULTS, path))
      continue
    }
    setPath(value, path, String(current))
    warnings.push(path + ' 不是字符串，已按字符串处理')
  }

  value.vision.base = String(value.vision.base || '').replace(/\/+$/, '')
  value.vision.provider = String(value.vision.provider || 'dsh').toLowerCase()
  if (value.vision.provider !== 'dsh' && value.vision.provider !== 'aliyun') {
    warnings.push('vision.provider 只支持 dsh / aliyun，已回落到 dsh（vision.provider=' + JSON.stringify(value.vision.provider) + '）')
    value.vision.provider = 'dsh'
  }
  if (configFile) value.configFile = configFile
  return { value, warnings }
}

/**
 * 从旧 muse_vtuber 的 config.json 里捞迁移基线（只在**本插件首次创建配置**时用）。
 * 旧版把这些键都写在 muse_vtuber 的配置里；不搬的话用户会看到"摄像头/麦克风全变默认"。
 * 只读不删；`mic.vad` 不搬（那一段属于 mira_audio）。
 */
export function legacySeed() {
  const file = join(miraConfigDir('muse_vtuber'), 'config.json')
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { patch: {}, source: '' }
  }
  if (!raw || typeof raw !== 'object') return { patch: {}, source: '' }
  const patch = {}
  if (raw.camera && typeof raw.camera === 'object') patch.camera = raw.camera
  if (raw.mic && typeof raw.mic === 'object') {
    const { vad, ...rest } = raw.mic
    void vad
    patch.mic = rest
  }
  for (const key of ['capture', 'vision', 'events']) {
    if (raw[key] && typeof raw[key] === 'object') patch[key] = raw[key]
  }
  return { patch, source: Object.keys(patch).length ? file : '' }
}

/** 配置仓库：读 config.json（权威）→ 规整；写回原子替换；文件改动按内容热生效（约定9）。 */
export class ConfigStore {
  /**
   * @param {object} options
   * @param {string} options.baseDir  `$DSH_HOME/mira_config/mira_input`
   * @param {object} [options.patch]  cordis patch 里的 config（基线）
   * @param {object} [options.logger]
   * @param {() => {patch:object, source:string}} [options.seed] 首次创建时的迁移基线
   */
  constructor({ baseDir, patch = {}, logger = null, seed = null }) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'config.json')
    this.patch = patch && typeof patch === 'object' ? patch : {}
    this.logger = logger
    this.seed = seed
    this.cache = null
    this.cacheRaw = null
    this.fatalError = null
    this.createdFile = false
    this.seededFrom = ''
    this.warnings = []
  }

  load() {
    ensureDir(this.baseDir)
    const text = this.readText()
    if (text === null) {
      let base = this.patch
      if (typeof this.seed === 'function') {
        try {
          const seeded = this.seed()
          if (seeded && seeded.patch && Object.keys(seeded.patch).length) {
            base = deepMerge(structuredClone(this.patch), seeded.patch)
            this.seededFrom = String(seeded.source || '')
          }
        } catch { /* 迁移失败不挡创建 */ }
      }
      const { value, warnings } = normalizeConfig(base, { configFile: this.file })
      const payload = { schemaVersion: CONFIG_SCHEMA, ...stripRuntime(value) }
      this.createdFile = writeJsonAtomic(this.file, payload)
      this.cache = value
      this.warnings = warnings
      this.cacheRaw = this.createdFile ? JSON.stringify(payload, null, 2) + '\n' : null
      return { created: true, warnings, seededFrom: this.seededFrom }
    }
    return this.applyRaw(text)
  }

  readText() {
    try {
      return readFileSync(this.file, 'utf8')
    } catch {
      return null
    }
  }

  applyRaw(text) {
    this.cacheRaw = text
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.fatalError = {
        code: 'config/corrupt',
        message: '配置文件不可用：' + this.file + '（' + (error?.message || error) + '）',
        hint: '修好这个 JSON 文件（或删掉它让插件按默认重建），然后重载插件',
      }
      return { created: false, error: this.fatalError }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fatalError = {
        code: 'config/corrupt',
        message: '配置文件不是 JSON 对象：' + this.file,
        hint: '顶层必须是对象（{ "schemaVersion": 1, ... }）',
      }
      return { created: false, error: this.fatalError }
    }
    const checked = checkSchema(parsed, CONFIG_SCHEMA, this.file)
    if (!checked.ok) {
      this.fatalError = checked.error?.error || checked.error
      return { created: false, error: this.fatalError }
    }
    const { value, warnings } = normalizeConfig(parsed, { configFile: this.file })
    this.cache = value
    this.warnings = warnings
    this.fatalError = null
    return { created: false, warnings }
  }

  current() {
    const text = this.readText()
    if (text !== this.cacheRaw) {
      const result = this.load()
      if (result.error) this.fatalError = result.error
    }
    if (this.fatalError) {
      throw new MiraError(this.fatalError.code, this.fatalError.message, this.fatalError.hint)
    }
    if (!this.cache) {
      const { value } = normalizeConfig(this.patch, { configFile: this.file })
      this.cache = value
    }
    return this.cache
  }

  save(patch) {
    const before = this.current()
    const { value, warnings } = normalizeConfig(deepMerge(structuredClone(before), patch || {}), {
      configFile: this.file,
    })
    const payload = { schemaVersion: CONFIG_SCHEMA, ...stripRuntime(value) }
    const written = writeJsonAtomic(this.file, payload)
    if (!written) {
      throw new MiraError('config/write-failed', '写配置失败：' + this.file,
        '检查目录权限；文件会被原样保留，不会写坏的半截 JSON')
    }
    this.cache = value
    this.warnings = warnings
    this.fatalError = null
    this.cacheRaw = JSON.stringify(payload, null, 2) + '\n'
    return { value, warnings }
  }

  status() {
    return {
      file: this.file,
      createdFile: this.createdFile,
      seededFrom: this.seededFrom,
      warnings: this.warnings.slice(),
      error: this.fatalError ? { ...this.fatalError } : null,
    }
  }
}

function stripRuntime(value) {
  const { configFile, ...rest } = value
  return rest
}

/** 给浏览器的一份配置（不含路径与凭据）。 */
export function publicConfig(cfg) {
  return {
    camera: { enabled: cfg.camera.enabled, deviceId: cfg.camera.deviceId, width: cfg.camera.width, height: cfg.camera.height },
    mic: { enabled: cfg.mic.enabled, deviceId: cfg.mic.deviceId, sampleRate: cfg.mic.sampleRate },
    capture: { enabled: cfg.capture.enabled, fps: cfg.capture.fps, width: cfg.capture.width, audio: cfg.capture.audio, autoSwitch: cfg.capture.autoSwitch },
    // 前端要按这个间隔决定「自动识图」定时器（0 = 不自动抓帧）
    vision: { enabled: cfg.vision.enabled, provider: cfg.vision.provider, autoIntervalMs: cfg.vision.autoIntervalMs, prompt: cfg.vision.prompt },
    events: { enabled: cfg.events.enabled, steer: cfg.events.steer, minIntervalMs: cfg.events.minIntervalMs },
    features: { vision: cfg.vision.enabled === true },
  }
}
