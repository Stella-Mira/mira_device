/**
 * mira_input / capture.js —— 外部采集器（muse_galaxy 等）接入的"虚拟摄像头 / 虚拟麦克风"
 *
 * 设计口径：
 *   · 采集归外面（galaxy 负责取流、解码），**取帧策略、自动推帧间隔、限流、插话在本插件**；
 *     断句阈值不在这里 —— 那是 mira_audio 的 `vad`（切分器由 `miraAudio.createSegmenter()` 借来）。
 *   · 这里只做四件事：存档最近一帧 → MJPEG 分发给面板 → PCM 断句后送 ASR → 按配置驱动识图。
 *   · 端点只允许本机回环 + capture 令牌（能往输入里喂画面和声音，等于能"喂话"，不能裸奔）。
 *
 * 生命周期：
 *   open{label,source,fps,width,audio} → frame{...}… → pcm{...}… → close{reason}
 *   state.cameraSource / micSource 随之标成 'galaxy'，面板改为消费 /input/api/stream.mjpg。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MiraError, ensureDir, miraConfigDir, toError, writeJsonAtomic,
} from './kit.mjs'

export const CAPTURE_SCHEMA = 1
export const CAPTURE_TOKEN_FILE = (baseDir) => join(baseDir, 'capture.json')
export const MJPEG_BOUNDARY = 'mvframe'

/** 回环地址（含 IPv4-mapped IPv6）。没有 socket 信息时（自检/内嵌调用）视为本机。 */
export function isLoopback(req) {
  const addr = req && req.socket ? String(req.socket.remoteAddress || '') : ''
  if (addr === '') return true
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 读/建采集令牌（600）。读不到就建一个；建不了就把错误交回去，别静默。 */
export function loadOrCreateToken(baseDir) {
  const file = CAPTURE_TOKEN_FILE(baseDir)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw.token === 'string' && raw.token.trim() !== '') {
      return { ok: true, file, token: raw.token.trim(), created: false }
    }
  } catch { /* 不存在或坏了 → 重建 */ }
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  try {
    ensureDir(baseDir)
    writeJsonAtomic(file, { schemaVersion: CAPTURE_SCHEMA, token, createdAt: new Date().toISOString() }, { mode: 0o600 })
    return { ok: true, file, token, created: true }
  } catch (error) {
    return { ok: false, file, error: toError(error, 'config/write-failed', '检查 ' + baseDir + ' 是否可写') }
  }
}

/** 一路外部采集。 */
class Capture {
  constructor(info) {
    this.id = info.captureId
    this.label = info.label
    this.source = info.source
    this.sessionId = info.sessionId
    this.fps = info.fps
    this.width = info.width
    this.audio = info.audio
    this.createdAt = Date.now()
    this.lastFrameAt = 0
    this.lastPcmAt = 0
    this.frames = 0
    this.framesDropped = 0
    this.pcmChunks = 0
    this.audioChunks = 0
    this.audioSteered = 0
    this.state = 'waiting' // waiting | live | stalled | lost
    this.jpeg = null
    this.jpegAt = 0
    this.errors = []
    this.segmenter = null
  }

  get dataUrl() {
    if (!this.jpeg) return ''
    return 'data:image/jpeg;base64,' + this.jpeg.toString('base64')
  }

  get fpsActual() {
    const span = this.lastFrameAt - this.createdAt
    if (span <= 0 || this.frames < 2) return 0
    return Math.round((this.frames / (span / 1000)) * 10) / 10
  }
}

export class CaptureHub {
  /**
   * @param {object} deps
   * @param {() => object} deps.config         当前配置（热加载）
   * @param {() => object} deps.audio          miraAudio 服务（切分/识别/识图都借它）
   * @param {object} deps.hub                  EventHub（broadcast / perceive）
   * @param {object} deps.stateStore
   * @param {string} deps.baseDir              mira_config/mira_input
   * @param {object} [deps.logger]
   * @param {object} [deps.counters]
   */
  constructor({ config, audio, hub, stateStore, baseDir, logger, counters, now = () => Date.now() }) {
    this.config = config
    this.audio = audio
    this.hub = hub
    this.stateStore = stateStore
    this.baseDir = baseDir || miraConfigDir('mira_input')
    this.logger = logger
    this.counters = counters
    this.now = now
    this.items = new Map()      // captureId → Capture
    this.subscribers = new Set() // { res, captureId }
    this.tokenCache = null
    this.visionTimer = null
    this.lostTimer = null
    this.disposed = false
    this.lastVisionAt = 0
    this.lastPercept = null
  }

  /** 读当前配置；坏了（config/schema 之类）就当空配置，绝不让采集器把别的工具带崩。 */
  #cfg() {
    try {
      const value = this.config && this.config()
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  /** 取 miraAudio（拿不到就把明确的错误抛给调用方，别静默降级）。 */
  #audio() {
    const svc = this.audio && this.audio()
    if (!svc || typeof svc.createSegmenter !== 'function' || typeof svc.transcribe !== 'function') {
      throw new MiraError('audio/absent', 'mira_audio 没有装配（miraAudio 服务不可用）',
        '确认 mira_audio 已启用并加载；断句/识别/识图都借它的能力')
    }
    return svc
  }

  /* ── 令牌 ─────────────────────────────────────────────── */

  token() {
    if (this.tokenCache && this.tokenCache.ok) return this.tokenCache
    this.tokenCache = loadOrCreateToken(this.baseDir)
    return this.tokenCache
  }

  /** 采集口的鉴权：必须本机回环 + Bearer 令牌。返回 null 表示通过。 */
  authorize(req) {
    if (!isLoopback(req)) {
      return {
        status: 403,
        error: { code: 'capture/forbidden', message: '采集口只接受本机连接', hint: '只允许 127.0.0.1 / ::1；不要把它暴露到局域网' },
      }
    }
    const token = this.token()
    if (!token.ok) {
      return { status: 503, error: { code: 'config/write-failed', message: '采集令牌文件不可用：' + token.error.error.message, hint: token.error.error.hint } }
    }
    const headers = (req && req.headers) || {}
    const raw = String(headers.authorization || headers.Authorization || '')
    const presented = /^Bearer\s+(.+)$/i.exec(raw.trim())
    if (!presented || presented[1].trim() !== token.token) {
      return {
        status: 401,
        error: {
          code: 'capture/unauthorized',
          message: '采集口需要 Bearer 令牌',
          hint: '读 ' + token.file + ' 里的 token（600，只在本机），放进 Authorization: Bearer <token>',
        },
      }
    }
    return null
  }

  /* ── 生命周期 ─────────────────────────────────────────── */

  open(input = {}) {
    const cfg = this.#cfg()
    const cap = cfg.capture || {}
    const source = String(input.source || input.label || 'capture').trim()
    const label = String(input.label || source).trim()
    const sessionId = String(input.sessionId || '').trim()
    const want = {
      fps: clampInt(input.fps, cap.fps, 1, 15, 4),
      width: clampInt(input.width, cap.width, 160, 1920, 480),
      audio: input.audio === undefined ? cap.audio !== false : input.audio !== false,
    }

    // 幂等：同一个 source 再开一次，沿用旧 captureId（避免同一路流被推两遍）
    for (const item of this.items.values()) {
      if (item.source === source) {
        item.label = label
        item.sessionId = sessionId || item.sessionId
        item.fps = want.fps
        item.width = want.width
        item.audio = want.audio
        this.#ensureSegmenter(item)
        this.#applySources()
        return { captureId: item.id, want, reused: true, selected: this.selected() }
      }
    }

    const info = {
      captureId: 'cap-' + randomUUID().slice(0, 8),
      label,
      source,
      sessionId,
      fps: want.fps,
      width: want.width,
      audio: want.audio,
    }
    const item = new Capture(info)
    this.items.set(item.id, item)
    this.#ensureSegmenter(item)
    this.#applySources()
    this.#ensureTimers()
    this.logger?.info?.('[mira_input] 采集器接入：' + label + '（' + item.id + '，' + want.fps + 'fps，音频' + (want.audio ? '开' : '关') + '）')
    this.hub?.broadcast?.('state', { state: this.#stateView(), changed: ['cameraSource', 'micSource'], by: 'capture' })
    return { captureId: item.id, want, reused: false, selected: this.selected() }
  }

  frame(captureId, dataUrl) {
    const item = this.#require(captureId)
    const raw = String(dataUrl || '')
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw)
    if (!match) {
      throw new MiraError('capture/frame-invalid', '帧不是 data:image/jpeg;base64,…',
        '把这一帧按 canvas.toDataURL("image/jpeg", 0.7) 的形式送来')
    }
    const buf = Buffer.from(match[2], 'base64')
    if (buf.length === 0) throw new MiraError('capture/frame-invalid', '帧是空的', '检查采集端是否真的解出了画面')
    if (buf.length > 2 * 1024 * 1024) {
      throw new MiraError('capture/frame-too-big', '单帧超过 2MB（' + buf.length + '）', '降分辨率或提高 JPEG 压缩率')
    }
    item.jpeg = buf
    item.jpegAt = this.now()
    item.lastFrameAt = item.jpegAt
    item.frames += 1
    item.state = 'live'
    this.#fanout(item)
    return { selected: this.isSelectedCamera(item.id), frames: item.frames, state: item.state }
  }

  pcm(captureId, base64, sampleRate) {
    const item = this.#require(captureId)
    if (!item.audio) return { ok: true, skipped: 'audio-disabled' }
    const buf = Buffer.from(String(base64 || ''), 'base64')
    if (buf.length === 0) throw new MiraError('capture/audio-invalid', 'PCM 是空的', '送 16bit 单声道小端 PCM（base64）')
    item.lastPcmAt = this.now()
    item.pcmChunks += 1
    if (item.state === 'waiting') item.state = 'live'
    const rate = clampInt(sampleRate, 16000, 8000, 48000, 16000)
    if (item.segmenter && item.segmenter.sampleRate !== rate) item.segmenter.sampleRate = rate
    const level = item.segmenter ? item.segmenter.push(buf) : 0
    this.hub?.broadcast?.('capture/level', { captureId: item.id, level: Math.round(level * 1000) / 1000, at: this.now() })
    return { ok: true, level: Math.round(level * 1000) / 1000, chunks: item.pcmChunks }
  }

  /** 纯音频流（电台）没有帧可推时用它维持心跳，否则会被判 stalled/lost。 */
  ping(captureId) {
    const item = this.#require(captureId)
    item.lastPcmAt = this.now()
    if (item.state === 'stalled' || item.state === 'waiting') item.state = 'live'
    return { ok: true, state: item.state, at: item.lastPcmAt }
  }

  close(captureId, reason) {
    const item = this.items.get(String(captureId || ''))
    if (!item) return { ok: true, already: true }
    // 先判定"它是不是当前选中源"——删掉之后 cameraCapture() 就找不到它了
    const state = this.#state()
    const wasSelected = String(state.cameraSource || '') === 'galaxy' || String(state.micSource || '') === 'galaxy'
    try {
      item.segmenter?.flush?.()
    } catch { /* 收尾失败不影响关闭 */ }
    this.items.delete(item.id)
    for (const sub of [...this.subscribers]) {
      if (sub.captureId === item.id) this.#dropSubscriber(sub, 'closed')
    }
    if (wasSelected) {
      this.#setSources(this.#firstOtherSources(item.id))
    }
    this.logger?.info?.('[mira_input] 采集器断开：' + item.label + '（' + item.id + '，' + (reason || 'closed') + '）')
    this.hub?.broadcast?.('state', { state: this.#stateView(), changed: ['cameraSource', 'micSource'], by: 'capture' })
    if (this.items.size === 0) this.#clearTimers()
    return { ok: true, removed: item.id }
  }

  /* ── 面板显示（MJPEG） ─────────────────────────────────── */

  attachMjpeg(req, res, captureId) {
    const wanted = String(captureId || '').trim()
    const item = wanted ? this.items.get(wanted) : this.cameraCapture()
    if (!item) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no capture')
      return
    }
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=' + MJPEG_BOUNDARY,
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'close',
      'x-capture-id': item.id,
      'x-capture-label': encodeURIComponent(item.label),
    })
    const sub = { res, captureId: item.id, at: Date.now() }
    this.subscribers.add(sub)
    if (item.jpeg) this.#writeFrame(sub, item)
    const cleanup = () => this.#dropSubscriber(sub, 'gone')
    try {
      req.on?.('close', cleanup)
      req.on?.('aborted', cleanup)
      res.on?.('close', cleanup)
      res.on?.('error', cleanup)
    } catch { /* 忽略 */ }
  }

  #writeFrame(sub, item) {
    if (!item.jpeg) return
    try {
      sub.res.write('--' + MJPEG_BOUNDARY + '\r\n')
      sub.res.write('Content-Type: image/jpeg\r\n')
      sub.res.write('Content-Length: ' + item.jpeg.length + '\r\n\r\n')
      sub.res.write(item.jpeg)
      sub.res.write('\r\n')
    } catch {
      this.#dropSubscriber(sub, 'write-failed')
    }
  }

  #fanout(item) {
    if (!this.isSelectedCamera(item.id)) return
    for (const sub of [...this.subscribers]) {
      if (sub.captureId === item.id) this.#writeFrame(sub, item)
    }
  }

  #dropSubscriber(sub, why) {
    if (!this.subscribers.has(sub)) return
    this.subscribers.delete(sub)
    try {
      sub.res.end()
    } catch { /* 忽略 */ }
    if (why !== 'gone') this.logger?.debug?.('[mira_input] MJPEG 订阅结束：' + why)
  }

  /* ── 识别：自动推帧 + 断句识别 ─────────────────────────── */

  #ensureTimers() {
    if (this.visionTimer || this.disposed) return
    // 自动推帧：读 vision.autoIntervalMs，0 = 不做
    this.visionTimer = setInterval(() => this.#visionTick(), 1000)
    this.visionTimer.unref?.()
    // 超时巡检：stalled / lost
    this.lostTimer = setInterval(() => this.#sweep(), 1000)
    this.lostTimer.unref?.()
  }

  #clearTimers() {
    if (this.visionTimer) clearInterval(this.visionTimer)
    if (this.lostTimer) clearInterval(this.lostTimer)
    this.visionTimer = null
    this.lostTimer = null
  }

  async #visionTick() {
    if (this.disposed) return
    const cfg = this.#cfg()
    const vision = cfg.vision || {}
    if (vision.enabled !== true) return
    const intervalMs = Number(vision.autoIntervalMs) || 0
    if (intervalMs <= 0) return
    if (this.now() - this.lastVisionAt < intervalMs) return
    const item = this.cameraCapture()
    if (!item || !item.jpeg) return
    if (this.now() - item.jpegAt > Math.max(3000, (1000 / Math.max(1, item.fps)) * 3)) return
    this.lastVisionAt = this.now()
    try {
      // 自动推帧不经过模型（那条路必须有文字），所以交给 mira_audio 的网关能力识图
      const outcome = await this.#audio().describeImage({
        dataUrl: item.dataUrl,
        prompt: String(vision.prompt || ''),
        base: String(vision.base || ''),
        model: String(vision.model || ''),
        timeoutMs: Number(vision.timeoutMs) || 30000,
      })
      const text = String(outcome.text || '').trim()
      if (text === '') return
      this.counters?.bump?.('capture.vision')
      const steer = await this.hub.perceive({
        kind: 'vision',
        text: '[' + item.label + '] ' + text,
        sessionId: item.sessionId,
        auto: true,
      })
      this.lastPercept = { kind: 'capture/vision', text, at: this.now(), steered: steer && steer.delivered === true }
      this.hub?.broadcast?.('capture/seen', {
        captureId: item.id,
        text,
        steered: steer && steer.delivered === true,
        reason: steer && steer.reason ? steer.reason : '',
        at: this.now(),
      })
    } catch (error) {
      this.counters?.bump?.('capture.vision.fail')
      const normalized = toError(error, 'vision/failed')
      item.errors.push({ at: this.now(), code: normalized.error.code, message: normalized.error.message })
      if (item.errors.length > 5) item.errors.shift()
      this.logger?.warn?.('[mira_input] 采集画面识别失败：' + normalized.error.code + ' ' + normalized.error.message)
    }
  }

  #sweep() {
    if (this.disposed) return
    const cfg = this.#cfg()
    const cap = cfg.capture || {}
    const staleMs = Number(cap.staleMs) || 3000
    const lostMs = Number(cap.lostMs) || 15000
    const now = this.now()
    for (const item of [...this.items.values()]) {
      const lastAt = Math.max(item.lastFrameAt, item.lastPcmAt)
      // 从来没收到过任何数据：按"注册后多久还没动静"来判，否则这种采集会永远挂着
      if (lastAt === 0) {
        if (now - item.createdAt >= lostMs) {
          item.state = 'lost'
          this.logger?.warn?.('[mira_input] 采集器注册后一直没有数据：' + item.label + '（已清理）')
          this.close(item.id, 'never-arrived')
        }
        continue
      }
      const gap = now - lastAt
      if (gap >= lostMs) {
        item.state = 'lost'
        this.logger?.warn?.('[mira_input] 采集器失联：' + item.label + '（' + Math.round(gap / 1000) + 's 没有数据）')
        this.close(item.id, 'lost')
      } else if (gap >= staleMs) {
        item.state = 'stalled'
      } else if (item.state === 'stalled') {
        item.state = 'live'
      }
    }
  }

  #ensureSegmenter(item) {
    if (!item.audio) {
      item.segmenter = null
      return
    }
    if (item.segmenter) return
    const cfg = this.#cfg()
    const cap = cfg.capture || {}
    const sampleRate = Number(cfg.mic && cfg.mic.sampleRate) || 16000
    try {
      const audio = this.#audio()
      item.segmenter = audio.createSegmenter({
        // 阈值统一听 mira_audio 的 vad（切分属于声音能力）
        vad: audio.vad ? audio.vad() : undefined,
        sampleRate,
        maxAudioMs: Number(cap.maxAudioMs) || 30000,
        now: this.now,
        onUtterance: (utterance) => { void this.#onUtterance(item, utterance) },
      })
    } catch (error) {
      item.segmenter = null
      const normalized = toError(error, 'audio/absent')
      item.errors.push({ at: this.now(), code: normalized.error.code, message: normalized.error.message })
      this.logger?.warn?.('[mira_input] 建断句器失败（采集只剩画面）：' + normalized.error.code + ' ' + normalized.error.message)
    }
  }

  async #onUtterance(item, utterance) {
    const cfg = this.#cfg()
    const events = cfg.events || {}
    if (events.enabled === false) return
    try {
      const outcome = await this.#audio().transcribe({
        base64: utterance.wav.toString('base64'),
        mime: 'audio/wav',
        sampleRate: utterance.sampleRate,
      })
      const text = String(outcome.text || '').trim()
      item.audioChunks += 1
      if (text === '') {
        this.counters?.bump?.('capture.asr.empty')
        return
      }
      this.counters?.bump?.('capture.asr.ok')
      const steer = await this.hub.perceive({
        kind: 'voice',
        text: '[' + item.label + '] ' + text,
        sessionId: item.sessionId,
        auto: true,
      })
      if (steer && steer.delivered === true) item.audioSteered += 1
      this.lastPercept = { kind: 'capture/voice', text, at: this.now(), steered: steer && steer.delivered === true }
      this.hub?.broadcast?.('capture/heard', {
        captureId: item.id,
        text,
        steered: steer && steer.delivered === true,
        reason: steer && steer.reason ? steer.reason : '',
        at: this.now(),
      })
    } catch (error) {
      this.counters?.bump?.('capture.asr.fail')
      const normalized = toError(error, 'asr/failed')
      item.errors.push({ at: this.now(), code: normalized.error.code, message: normalized.error.message })
      if (item.errors.length > 5) item.errors.shift()
      this.logger?.warn?.('[mira_input] 采集语音识别失败：' + normalized.error.code + ' ' + normalized.error.message)
    }
  }

  /* ── 选中与状态 ───────────────────────────────────────── */

  cameraCapture() {
    const list = [...this.items.values()]
    if (list.length === 0) return null
    const state = this.#state()
    const wanted = String(state.cameraSource || '')
    if (wanted === 'galaxy') return list.find((item) => item.state !== 'lost') || list[0]
    return null
  }

  micCapture() {
    if (String(this.#state().micSource || '') !== 'galaxy') return null
    const list = [...this.items.values()]
    return list.find((item) => item.state !== 'lost') || list[0] || null
  }

  isSelectedCamera(captureId) {
    const item = this.cameraCapture()
    return !!item && item.id === captureId
  }

  isSelectedMic(captureId) {
    const item = this.micCapture()
    return !!item && item.id === captureId
  }

  selected() {
    const cam = this.cameraCapture()
    const mic = this.micCapture()
    return { camera: cam ? cam.id : '', mic: mic ? mic.id : '' }
  }

  /** 采集器可用的帧（agent 取一帧用；没有画面时返回 null）。 */
  currentFrame() {
    const item = this.cameraCapture()
    if (!item || !item.jpeg) return null
    return { captureId: item.id, label: item.label, at: item.jpegAt, dataUrl: item.dataUrl }
  }

  /**
   * 采集器接入后，把 state 的 cameraSource / micSource 切到 'galaxy'（`capture.autoSwitch` 才切）。
   * 同时把 cameraOn / micOn 置 true —— 外部源下这两个开关的语义是"要不要接收这路流"，
   * 采集器一开始推就应当看得到画面/听得到声音，不该让用户再点一次按钮。
   */
  #applySources() {
    const cfg = this.#cfg()
    if (cfg.capture && cfg.capture.autoSwitch === false) return
    const live = [...this.items.values()].filter((item) => item.state !== 'lost')
    if (live.length === 0) return
    const state = this.#state()
    const patch = {}
    if (String(state.cameraSource || 'device') !== 'galaxy') patch.cameraSource = 'galaxy'
    if (String(state.micSource || 'device') !== 'galaxy') patch.micSource = 'galaxy'
    if (state.cameraOn !== true) patch.cameraOn = true
    if (live.some((item) => item.audio) && state.micOn !== true) patch.micOn = true
    if (Object.keys(patch).length) this.#setSources(patch)
  }

  #firstOtherSources(excludingId) {
    const rest = [...this.items.values()].filter((item) => item.id !== excludingId)
    const live = rest.some((item) => item.state !== 'lost')
    // 源没了：来源回落，开关也关掉（外部源下 cameraOn/micOn 表示"正在接收"，没得接收就该是关）
    return {
      cameraSource: live ? 'galaxy' : 'none',
      micSource: live ? 'galaxy' : 'none',
      cameraOn: live,
      micOn: live,
    }
  }

  #setSources(patch) {
    try {
      const result = this.stateStore.set(patch, { by: 'capture' })
      this.hub?.broadcast?.('state', { state: result.state, changed: result.changed, by: 'capture' })
    } catch (error) {
      this.logger?.warn?.('[mira_input] 写采集来源失败：' + (error && error.message ? error.message : error))
    }
  }

  #state() {
    try {
      return this.stateStore.snapshot()
    } catch {
      return {}
    }
  }

  #stateView() {
    try {
      return this.stateStore.snapshot()
    } catch {
      return { cameraSource: 'none', micSource: 'none' }
    }
  }

  #require(captureId) {
    const id = String(captureId || '').trim()
    if (id === '') throw new MiraError('capture/not-found', '缺少 captureId', '先调 /input/api/capture/open 拿 id')
    const item = this.items.get(id)
    if (!item) {
      throw new MiraError('capture/not-found', '采集流不存在或已关闭：' + id,
        'mira_input 重启后 captureId 会失效，重新 open 一次即可')
    }
    return item
  }

  /** 给 /input/api/state 与 input_status 用。 */
  status() {
    const cfg = this.#cfg()
    const cap = cfg.capture || {}
    const sources = [...this.items.values()].map((item) => ({
      captureId: item.id,
      label: item.label,
      source: item.source,
      sessionId: item.sessionId,
      fps: item.fps,
      fpsActual: item.fpsActual,
      width: item.width,
      audio: item.audio,
      state: item.state,
      frames: item.frames,
      pcmChunks: item.pcmChunks,
      audioChunks: item.audioChunks,
      audioSteered: item.audioSteered,
      lastFrameAt: item.lastFrameAt,
      lastPcmAt: item.lastPcmAt,
      errors: item.errors.slice(-3),
    }))
    return {
      enabled: cap.enabled !== false,
      tokenFile: this.token().file,
      autoSwitch: cap.autoSwitch !== false,
      selected: this.selected(),
      mjpeg: '/input/api/stream.mjpg',
      sources,
      subscribers: this.subscribers.size,
      lastPercept: this.lastPercept,
    }
  }

  dispose() {
    this.disposed = true
    this.#clearTimers()
    for (const sub of [...this.subscribers]) this.#dropSubscriber(sub, 'dispose')
    this.items.clear()
  }
}

function clampInt(value, fallback, min, max, dflt) {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) {
    const f = Number(fallback)
    if (Number.isFinite(f) && f > 0) return Math.min(max, Math.max(min, Math.round(f)))
    return dflt
  }
  return Math.min(max, Math.max(min, Math.round(n)))
}
