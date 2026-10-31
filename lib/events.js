/**
 * mira_device / events.js —— 输入侧的事件总线（SSE）+ 感知事件投递（插话 steer）
 *
 * 两条方向：
 *   宿主 → 浏览器：`GET /device/api/events`（text/event-stream）。帧类型
 *     state          开关/来源变更（摄像头、麦克风、采集器接入/断开）
 *     capture/level  采集器推来的 PCM 电平（0..1，面板波形用）
 *     capture/heard  采集器断句 → 识别出的句子（侧边栏「听到」用）
 *     capture/seen   自动推帧识别出的画面描述（侧边栏「看到」用）
 *     command        要浏览器做事：{ requestId, kind:'look'|'listen', payload }
 *     hello          连接建立（带 seq 起点，便于前端重连后判断是否断档）
 *   浏览器 → 宿主：`POST /device/api/result`（command 的执行结果，按 requestId 配对）
 *
 * 「事件流直接激活会话」：识别出的文字按模板填好，作为一条用户消息 **steer（插话）**
 * 投给该会话 —— 空闲会话立刻开一轮，正在跑的会话插到最近一步，不排队
 * （排队会让「它听到你说话了」变成「这一轮跑完才听到」）。
 *
 * 为什么这条总线在「输入」而不是「声音」或「形象」：语音与画面都是**感知生产者**，
 * 而"要不要把它变成会话里的一条消息"是生产者的策略（限流、模板、开关都在这）；
 * mira_media 只提供"把音频变成文字"，muse_vtuber 只负责把结果画出来。
 *
 * 防刷屏（照 muse_galaxy 的口径，参数在 config.events）：
 *   minIntervalMs 两条之间最小间隔 / maxPerMin 每分钟上限 / cooldownKeyMs 同一内容冷却。
 * 被限流不是静默丢弃：计数在 status 里可见。
 */

import { randomUUID } from 'node:crypto'

import { MiraError } from './kit.mjs'

/** 造一条用户消息。source.kind 必须是生产者自己的名字（会话格式 v4 的准入规则）。 */
export function perceptionMessage(text, { kind = 'voice', sessionId = '', at = '' } = {}) {
  return {
    id: 'mira-input-' + randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    // 会话格式 v4 的准入规则：source.kind 必须是**生产者自己的**名字（不能是 plugin / 借别人的）
    source: { kind: 'mira_device' },
    meta: { percept: kind, sessionId, at },
  }
}

function template(tpl, values) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
  ))
}

export class EventHub {
  /**
   * @param {object} options
   * @param {object} options.config        规整后的 cfg（事件相关的几项）
   * @param {(sessionId:string)=>Promise<object>} options.resolveAgent  sessionController.resolveAgent 的薄包装
   * @param {object} [options.sessions]     宿主 sessions 服务（投递后 flush）
   * @param {object} [options.logger]
   * @param {object} [options.counters]
   * @param {() => number} [options.now]    注入时钟（自检用）
   */
  constructor({ config, resolveAgent, sessions = null, logger = null, counters = null, now = Date.now }) {
    this.config = config
    this.resolveAgent = resolveAgent
    this.sessions = sessions
    this.logger = logger
    this.counters = counters || { bump() {}, get() { return 0 }, snapshot() { return {} } }
    this.now = now
    this.clients = new Set()
    this.pending = new Map()
    this.seq = 0
    this.lastAt = new Map()
    this.recent = []
    this.cooldowns = new Map()
    this.lastPercept = null
    this.pingTimer = null
    this.disposed = false
  }

  setConfig(config) {
    this.config = config && typeof config === 'object' ? config : {}
  }

  /* ── SSE ─────────────────────────────────────────────── */

  /** 挂一个 SSE 客户端；返回关闭函数。 */
  attach(req, res) {
    if (this.disposed) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('plugin disposed')
      return () => {}
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      // 反向代理（mira_proxy）后面必须关掉缓冲，否则事件要攒满一屏才到
      'x-accel-buffering': 'no',
    })
    const client = { res, id: randomUUID(), at: this.now() }
    this.clients.add(client)
    this.send(client, 'hello', { seq: this.seq, clientId: client.id, at: new Date(this.now()).toISOString() })
    this.ensurePing()
    const drop = () => {
      this.clients.delete(client)
    }
    try {
      req.on?.('close', drop)
      req.on?.('error', drop)
      res.on?.('close', drop)
      res.on?.('error', drop)
    } catch {
      drop()
    }
    this.counters.bump('sse.connect')
    return drop
  }

  get clientCount() {
    return this.clients.size
  }

  ensurePing() {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.res.write(': ping ' + this.now() + '\n\n')
        } catch {
          this.clients.delete(client)
        }
      }
    }, 15000)
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref()
  }

  send(client, type, payload) {
    this.seq += 1
    const frame = { seq: this.seq, type, at: new Date(this.now()).toISOString(), ...(payload || {}) }
    try {
      client.res.write('data: ' + JSON.stringify(frame) + '\n\n')
      return true
    } catch {
      this.clients.delete(client)
      return false
    }
  }

  /** 广播一帧给所有浏览器页签。返回送达的客户端数。 */
  broadcast(type, payload) {
    let sent = 0
    for (const client of [...this.clients]) {
      if (this.send(client, type, payload)) sent += 1
    }
    return sent
  }

  /* ── 宿主 → 浏览器 的命令（要等结果） ──────────────────── */

  /**
   * 让浏览器做一件事并等结果（vtuber_look / vtuber_listen 用）。
   * 没连浏览器 → delivery/failed 并说清怎么办。
   */
  request(kind, payload = {}, { timeoutMs = 10000 } = {}) {
    if (this.disposed) return Promise.reject(new MiraError('plugin/disabled', '插件已卸载', '重载插件后重试'))
    if (this.clients.size === 0) {
      return Promise.reject(new MiraError('delivery/failed',
        '没有浏览器页签连着（' + kind + ' 需要页面在场）',
        '打开 DSH 界面（任一页签），并让摄像头/麦克风开着；这类操作必须有页面在场'))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.counters.bump(kind + '.timeout')
        reject(new MiraError('delivery/failed', '浏览器在 ' + timeoutMs + 'ms 内没有回应：' + kind,
          '页面可能被切到后台（浏览器会冻结定时器）；切回该页签后重试'))
      }, Math.max(1000, timeoutMs))
      // 这个定时器**不能 unref**：它的唯一作用就是把等结果的 Promise 收尾，
      // unref 之后进程里没别的事时会在超时前就退出（自检踩到过：unsettled top-level await）。
      this.pending.set(requestId, { resolve, reject, timer, at: this.now(), kind })
      this.broadcast('command', { requestId, kind, payload, timeoutMs })
    })
  }

  /** 浏览器回执：POST /vtuber/api/result。 */
  resolveResult({ requestId, ok, value, error }) {
    const pending = this.pending.get(String(requestId || ''))
    if (!pending) {
      this.counters.bump('command.orphan')
      return { ok: false, error: { code: 'command/unknown', message: '没有这个 requestId（可能已超时）', hint: '刷新页面后重试' } }
    }
    this.pending.delete(pending.requestId)
    clearTimeout(pending.timer)
    if (ok === false) {
      const err = error && typeof error === 'object' ? error : {}
      pending.reject(new MiraError(err.code || 'delivery/failed', err.message || '浏览器侧失败', err.hint))
    } else {
      pending.resolve(value ?? {})
    }
    return { ok: true }
  }

  /* ── 感知事件：识别结果 → 插话 ────────────────────────── */

  /**
   * 收到一条感知结果（语音识别 / 图像识别）：
   *   限流 → 填模板 → steer 投递。返回 { ok, delivered, reason?, text? }。
   * @param {object} input
   * @param {'voice'|'vision'} input.kind
   * @param {string} input.text
   * @param {string} input.sessionId
   * @param {boolean} [input.auto]  true = 来自界面自动事件流（受限流约束）；false = 工具显式调用
   */
  async perceive({ kind, text, sessionId, auto = true }) {
    const cfg = this.config?.events || {}
    const body = String(text ?? '').trim()
    if (body === '') return { ok: true, delivered: false, reason: 'empty' }
    if (auto && cfg.enabled !== true) {
      this.counters.bump('percept.disabled')
      return { ok: true, delivered: false, reason: 'events-disabled' }
    }
    const maxChars = Number(cfg.maxChars) || 400
    const clipped = Array.from(body).slice(0, maxChars).join('')
    const rendered = Array.from(template(kind === 'voice' ? cfg.voiceTemplate : cfg.visionTemplate, {
      kind,
      text: clipped,
      time: new Date(this.now()).toLocaleTimeString('zh-CN', { hour12: false }),
      date: new Date(this.now()).toLocaleDateString('zh-CN'),
      sessionId: String(sessionId ?? ''),
    })).slice(0, Math.max(maxChars * 2, 600)).join('')

    if (auto) {
      const blocked = this.rateLimited(kind, clipped)
      if (blocked) {
        this.counters.bump('percept.' + blocked)
        return { ok: true, delivered: false, reason: blocked, text: clipped }
      }
    }

    if (cfg.steer !== true) {
      this.counters.bump('percept.steer-off')
      this.lastPercept = { kind, text: clipped, at: new Date(this.now()).toISOString(), delivered: false, reason: 'steer-off' }
      return { ok: true, delivered: false, reason: 'steer-off', text: clipped }
    }

    const target = String(sessionId ?? '').trim()
    if (target === '') {
      this.counters.bump('percept.no-session')
      return { ok: false, error: { code: 'config/missing', message: '没有 sessionId，无法投递感知事件', hint: '界面应当把当前会话 id 一起发过来' } }
    }

    try {
      const agent = await this.resolveAgent(target)
      if (!agent) throw new MiraError('delivery/failed', '会话不存在或拿不到 live agent：' + target, '会话可能已删除；在界面里重新打开该会话')
      if (typeof agent.steer !== 'function') {
        throw new MiraError('delivery/failed', 'agent.steer 不可用（宿主版本不支持插话）', '升级 DSH')
      }
      agent.steer(perceptionMessage(rendered, { kind, sessionId: target, at: new Date(this.now()).toISOString() }))
      try {
        if (this.sessions && typeof this.sessions.flush === 'function' && agent.session) await this.sessions.flush(agent.session)
      } catch { /* flush 失败不影响已投递 */ }
      this.counters.bump('percept.delivered')
      this.lastPercept = { kind, text: clipped, at: new Date(this.now()).toISOString(), delivered: true, sessionId: target }
      if (auto) this.markDelivered(kind, clipped)
      return { ok: true, delivered: true, text: clipped, sessionId: target }
    } catch (error) {
      this.counters.bump('percept.failed')
      this.lastPercept = { kind, text: clipped, at: new Date(this.now()).toISOString(), delivered: false, reason: 'steer-failed' }
      const err = error instanceof MiraError ? error : new MiraError('delivery/failed', error?.message || String(error), '检查会话是否还活着')
      return { ok: false, error: { code: err.code, message: err.message, hint: err.hint } }
    }
  }

  /** 限流判定：返回 null（放行）或原因字符串。 */
  rateLimited(kind, text) {
    const cfg = this.config?.events || {}
    const now = this.now()
    const minGap = Number(cfg.minIntervalMs) || 0
    const last = this.lastAt.get(kind) || 0
    if (minGap > 0 && now - last < minGap) return 'min-interval'
    const windowMs = 60000
    this.recent = this.recent.filter((item) => now - item < windowMs)
    const maxPerMin = Number(cfg.maxPerMin) || 6
    if (this.recent.length >= maxPerMin) return 'max-per-minute'
    const cooldown = Number(cfg.cooldownKeyMs) || 0
    if (cooldown > 0) {
      const key = kind + '|' + text
      const at = this.cooldowns.get(key) || 0
      if (now - at < cooldown) return 'cooldown'
    }
    return null
  }

  markDelivered(kind, text) {
    const now = this.now()
    this.lastAt.set(kind, now)
    this.recent.push(now)
    const cooldown = Number(this.config?.events?.cooldownKeyMs) || 0
    if (cooldown > 0) {
      const key = kind + '|' + text
      this.cooldowns.set(key, now)
      // 冷却表不许无限长：过期项顺手清掉
      if (this.cooldowns.size > 256) {
        for (const [k, at] of this.cooldowns) {
          if (now - at > cooldown) this.cooldowns.delete(k)
        }
      }
    }
  }

  status() {
    const cfg = this.config?.events || {}
    return {
      clients: this.clients.size,
      seq: this.seq,
      pending: [...this.pending.values()].map((p) => ({ kind: p.kind, waitedMs: this.now() - p.at })),
      events: {
        enabled: cfg.enabled === true,
        steer: cfg.steer === true,
        minIntervalMs: cfg.minIntervalMs,
        maxPerMin: cfg.maxPerMin,
        cooldownKeyMs: cfg.cooldownKeyMs,
      },
      lastPercept: this.lastPercept,
      counters: this.counters.snapshot(),
    }
  }

  dispose() {
    this.disposed = true
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      try {
        pending.reject(new MiraError('plugin/disabled', '插件卸载，等待中的请求已取消', '重载插件后重试'))
      } catch { /* 忽略 */ }
    }
    this.pending.clear()
    for (const client of [...this.clients]) {
      try {
        client.res.end('data: {"type":"bye"}\n\n')
      } catch { /* 忽略 */ }
    }
    this.clients.clear()
  }
}
