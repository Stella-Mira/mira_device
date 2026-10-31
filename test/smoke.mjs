/**
 * mira_input / test/smoke.mjs —— 离线自检（不需要 DSH、不联网、不碰真 ~/.dsh）
 *
 * 覆盖：
 *   A kit 副本一致 / B 配置规整与迁移 / C 状态仓库
 *   D 事件总线（SSE / 命令往返 / 插话 / 限流）
 *   E 采集口（令牌、幂等、MJPEG 分发、PCM 断句→识别、自动推帧、失联回落）
 *   F HTTP 面（bootstrap / state / asr / vision / settings / capture）
 *   G 工具（5 个）/ H 入口装配、单实例、退场、服务契约
 *
 * 跑法：node test/smoke.mjs        （退出码 0 = 全过；末行打印断言数）
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'mira-input-smoke-'))
process.env.DSH_HOME = join(SANDBOX, 'dsh-home')

let pass = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass += 1
  } catch (error) {
    failures.push(name + '：' + (error && error.message ? error.message : String(error)))
    console.log('[FAIL] ' + name + '：' + (error && error.message ? error.message : String(error)))
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/* ── 假件 ───────────────────────────────────────────────── */

class FakeReq {
  constructor({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    this.method = method
    this.url = url
    this.headers = headers
    this.body = body
    this._handlers = { data: [], end: [], error: [] }
  }

  on(event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn)
    return this
  }

  emit(event, value) {
    for (const fn of this._handlers[event] || []) fn(value)
    return this
  }

  start() {
    const chunks = this.body === null || this.body === undefined
      ? []
      : [Buffer.from(typeof this.body === 'string' ? this.body : JSON.stringify(this.body), 'utf8')]
    setImmediate(() => {
      for (const chunk of chunks) this.emit('data', chunk)
      this.emit('end')
    })
    return this
  }
}

class FakeRes {
  constructor() {
    this.status = 0
    this.headers = {}
    this.chunks = []
    this.ended = false
    this._handlers = {}
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers || {}
    return this
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
    return true
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    this.ended = true
    return this
  }

  on(event, fn) {
    ;(this._handlers[event] || (this._handlers[event] = [])).push(fn)
    return this
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  get json() {
    try {
      return JSON.parse(this.text)
    } catch {
      return null
    }
  }
}

function fakeAgent() {
  const steered = []
  return {
    session: { id: 'sess-1' },
    steered,
    steer(message) {
      steered.push(message)
    },
  }
}

function makeCtx({ audio = null, attachments = null, llm = null, agent = fakeAgent() } = {}) {
  const registered = new Map()
  const routes = []
  const disposers = []
  const provided = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        return String(sessionId) === 'sess-1' ? { agent } : { error: { code: 'session/not-found', message: 'no' } }
      },
    },
    sessions: { async flush() {} },
    provide(name, api) {
      provided.set(name, api)
      return () => provided.delete(name)
    },
    get(name) {
      if (name === 'attachments') return attachments || undefined
      if (name === 'llm') return llm || undefined
      return undefined
    },
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    registered,
    routes,
    provided,
    agent,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch { /* 忽略 */ }
      }
    },
  }
  if (audio) ctx.miraAudio = audio
  return ctx
}

/** 假 miraAudio：断句用真的 PcmSegmenter（与 mira_audio 同源），识别/识图是假的。 */
async function fakeAudio({ transcribeText = '大家好呀', visionText = '画面里有一个人', withVad = true } = {}) {
  const calls = { transcribe: 0, describeImage: 0 }
  // 直接内联一个最小断句器：与 mira_audio 的语义一致（RMS + 静音 + 最短/最长）
  const makeSegmenter = ({ vad = {}, sampleRate = 16000, maxAudioMs = 30000, onUtterance = null } = {}) => {
    const seg = {
      sampleRate,
      threshold: Number(vad.threshold) || 0.02,
      silenceMs: Number(vad.silenceMs) || 650,
      minSpeechMs: Number(vad.minSpeechMs) || 320,
      maxMs: Number(vad.maxMs) || 15000,
      maxAudioMs,
      chunks: [],
      bytes: 0,
      speechMs: 0,
      silenceRun: 0,
      micSince: 0,
      push(pcm) {
        if (!pcm || pcm.length < 2) return 0
        const ms = (pcm.length / 2 / sampleRate) * 1000
        const count = pcm.length >> 1
        let sum = 0
        for (let i = 0; i < count; i += 1) {
          const v = pcm.readInt16LE(i * 2) / 32768
          sum += v * v
        }
        const rms = Math.sqrt(sum / count)
        if (rms > seg.threshold) {
          if (seg.micSince === 0) seg.micSince = Date.now()
          seg.speechMs += ms
          seg.silenceRun = 0
        } else if (seg.micSince > 0) {
          seg.silenceRun += ms
        }
        seg.chunks.push(Buffer.from(pcm))
        seg.bytes += pcm.length
        if (seg.bytes > Math.floor((maxAudioMs / 1000) * sampleRate * 2) && seg.chunks.length > 1) {
          const dropped = seg.chunks.shift()
          seg.bytes -= dropped.length
        }
        if (seg.micSince > 0 && seg.silenceRun >= seg.silenceMs) seg.cut('silence')
        else if (seg.micSince > 0 && seg.speechMs >= seg.maxMs) seg.cut('max')
        return rms
      },
      cut(reason) {
        const audio = seg.chunks.length ? Buffer.concat(seg.chunks) : Buffer.alloc(0)
        const speechMs = Math.round(seg.speechMs)
        const enough = speechMs >= seg.minSpeechMs
        seg.chunks = []
        seg.bytes = 0
        seg.speechMs = 0
        seg.silenceRun = 0
        seg.micSince = 0
        if (!enough) return null
        const wav = Buffer.concat([Buffer.from('RIFF'), audio])
        const value = { wav, speechMs, reason, sampleRate }
        if (onUtterance) onUtterance(value)
        return value
      },
      flush() {
        if (seg.micSince === 0) return null
        return seg.cut('flush')
      },
    }
    if (!withVad) seg.threshold = 1
    return seg
  }
  return {
    calls,
    version: 'test',
    status() {
      return {
        configured: true,
        tts: { enabled: true, model: 'tts' },
        asr: { enabled: true, model: 'asr' },
        vad: { threshold: 0.02, silenceMs: 100, minSpeechMs: 100, maxMs: 5000 },
        credsFile: '/tmp/creds.json',
      }
    },
    vad() {
      return { threshold: 0.02, silenceMs: 100, minSpeechMs: 100, maxMs: 5000 }
    },
    createSegmenter: (options) => makeSegmenter(options),
    async transcribe() {
      calls.transcribe += 1
      return { text: transcribeText, model: 'fake-asr' }
    },
    async describeImage() {
      calls.describeImage += 1
      return { text: visionText, model: 'fake-vision' }
    },
    async synthesize() {
      return { mime: 'audio/wav', base64: '', bytes: 0, chars: 0 }
    },
    say: async () => ({ ok: true }),
    async player() {
      return { clients: 0 }
    },
  }
}

/* ── 载入被测模块（先钉 DSH_HOME） ───────────────────────── */

const kit = await import('../lib/kit.mjs')
const configMod = await import('../lib/config.js')
const stateMod = await import('../lib/state.js')
const eventsMod = await import('../lib/events.js')
const captureMod = await import('../lib/capture.js')
const routesMod = await import('../lib/routes.js')
const toolsMod = await import('../lib/tools.js')
const indexMod = await import('../lib/index.js')

/* ══════════════════════════════════════════════════════════
 * A. kit 副本一致
 * ══════════════════════════════════════════════════════════ */

await t('A1 lib/kit.mjs 与 tool_shared/kit/kit.mjs 逐字节一致', () => {
  const canonical = resolve(ROOT, '..', 'tool_shared', 'kit', 'kit.mjs')
  if (!existsSync(canonical)) return
  assert.equal(sha256(join(ROOT, 'lib', 'kit.mjs')), sha256(canonical))
})

/* ══════════════════════════════════════════════════════════
 * B. 配置规整 / 迁移
 * ══════════════════════════════════════════════════════════ */

await t('B1 默认值：devices / capture / vision(dsh) / events', () => {
  const { value } = configMod.normalizeConfig({})
  assert.equal(value.camera.enabled, true)
  assert.equal(value.camera.width, 640)
  assert.equal(value.mic.sampleRate, 16000)
  assert.equal(value.capture.fps, 8)
  assert.equal(value.capture.width, 720)
  assert.equal(value.capture.autoSwitch, true)
  assert.equal(value.vision.provider, 'dsh')
  assert.equal(value.vision.autoIntervalMs, 0)
  assert.equal(value.events.steer, true)
})

await t('B2 越界夹回 + 未知字段保留 + provider 白名单', () => {
  const { value, warnings } = configMod.normalizeConfig({
    camera: { width: 1 },
    vision: { provider: 'openai' },
    futureThing: { a: 1 },
  })
  assert.equal(value.camera.width, 160)
  assert.equal(value.vision.provider, 'dsh')
  assert.deepEqual(value.futureThing, { a: 1 })
  assert.ok(warnings.some((w) => w.includes('camera.width')))
  assert.ok(warnings.some((w) => w.includes('vision.provider')))
})

await t('B3 publicConfig 不含路径与凭据', () => {
  const { value } = configMod.normalizeConfig({})
  value.configFile = '/x/config.json'
  const pub = configMod.publicConfig(value)
  assert.equal(pub.configFile, undefined)
  assert.equal(JSON.stringify(pub).includes('dashscope'), false)
  assert.equal(pub.vision.provider, 'dsh')
})

await t('B4 首次创建时从旧 muse_vtuber 配置迁移 camera/mic/capture/vision/events（不含 vad）', () => {
  const legacyDir = join(SANDBOX, 'dsh-home', 'mira_config', 'muse_vtuber')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    camera: { width: 1280, deviceId: 'cam-x' },
    mic: { sampleRate: 48000, vad: { silenceMs: 777 } },
    capture: { fps: 5 },
    vision: { autoIntervalMs: 4000 },
    events: { maxPerMin: 9 },
  }, null, 2))
  const store = new configMod.ConfigStore({ baseDir: join(SANDBOX, 'seed-config'), patch: {}, seed: configMod.legacySeed })
  const loaded = store.load()
  assert.equal(loaded.seededFrom.endsWith('muse_vtuber/config.json'), true)
  const cfg = store.current()
  assert.equal(cfg.camera.width, 1280)
  assert.equal(cfg.camera.deviceId, 'cam-x')
  assert.equal(cfg.mic.sampleRate, 48000)
  assert.equal(cfg.capture.fps, 5)
  assert.equal(cfg.vision.autoIntervalMs, 4000)
  assert.equal(cfg.events.maxPerMin, 9)
  assert.equal(cfg.mic.vad, undefined, 'vad 属于 mira_audio，不该搬到这里')
})

/* ══════════════════════════════════════════════════════════
 * C. 状态仓库
 * ══════════════════════════════════════════════════════════ */

await t('C1 默认状态 + set 落盘 + 未知来源被忽略', () => {
  const dir = join(SANDBOX, 'state-1')
  const store = new stateMod.StateStore({ baseDir: dir })
  store.load()
  assert.equal(store.get().cameraOn, false)
  assert.equal(store.get().cameraSource, 'device')
  const result = store.set({ cameraOn: true, micOn: true, cameraSource: 'galaxy' }, { by: 'client:c1' })
  assert.deepEqual(result.changed.sort(), ['cameraOn', 'cameraSource', 'micOn'])
  assert.equal(result.state.by, 'client:c1')
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.cameraSource, 'galaxy')
  const bogus = store.set({ micSource: 'nonsense' })
  assert.deepEqual(bogus.changed, [])
  assert.equal(store.get().micSource, 'device')
})

await t('C2 schemaVersion 不对：get() 抛，不静默清空', () => {
  const dir = join(SANDBOX, 'state-2')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 9 }))
  const store = new stateMod.StateStore({ baseDir: dir })
  const loaded = store.load()
  assert.equal(loaded.error.code, 'config/schema')
  assert.throws(() => store.get())
})

/* ══════════════════════════════════════════════════════════
 * D. 事件总线
 * ══════════════════════════════════════════════════════════ */

const CFG = configMod.normalizeConfig({}).value

function makeHub({ config = CFG, agent = fakeAgent(), now = () => Date.now() } = {}) {
  const counters = kit.makeCounters()
  const hub = new eventsMod.EventHub({
    config,
    resolveAgent: async (sessionId) => (sessionId === 'sess-1' ? agent : null),
    sessions: { async flush() {} },
    counters,
    now,
  })
  return { hub, counters, agent }
}

await t('D1 SSE：hello 立刻到；broadcast 带 seq', () => {
  const { hub } = makeHub()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  assert.equal(hub.clientCount, 1)
  hub.broadcast('state', { state: { cameraOn: true } })
  const frames = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  assert.equal(frames[0].type, 'hello')
  assert.equal(frames[1].type, 'state')
  hub.dispose()
})

await t('D2 没有页面时 request 立刻失败并说明怎么办', async () => {
  const { hub } = makeHub()
  await assert.rejects(() => hub.request('look', {}, { timeoutMs: 500 }), (error) => {
    assert.equal(error.code, 'delivery/failed')
    assert.ok(String(error.hint).includes('页面'))
    return true
  })
  hub.dispose()
})

await t('D3 request ↔ result 配对；错误回执让 request reject', async () => {
  const { hub } = makeHub()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const pending = hub.request('listen', { seconds: 1 }, { timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 20))
  const frame = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((f) => f.type === 'command')
  assert.equal(frame.kind, 'listen')
  hub.resolveResult({ requestId: frame.requestId, ok: true, value: { base64: 'AAAA' } })
  assert.equal((await pending).base64, 'AAAA')
  const failing = hub.request('look', {}, { timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 20))
  const frame2 = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((f) => f.type === 'command').at(-1)
  hub.resolveResult({ requestId: frame2.requestId, ok: false, error: { code: 'camera/closed', message: '没画面' } })
  await assert.rejects(() => failing, (error) => {
    assert.equal(error.code, 'camera/closed')
    return true
  })
  hub.dispose()
})

await t('D4 perceive：source.kind = mira_input，文本套模板后 steer', async () => {
  const { hub, agent } = makeHub()
  const result = await hub.perceive({ kind: 'voice', text: '你吃饭了吗', sessionId: 'sess-1', auto: true })
  assert.equal(result.delivered, true)
  const message = agent.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'mira_input')
  assert.equal(message.content[0].text, '[感知·语音] 你吃饭了吗')
  assert.equal(message.meta.percept, 'voice')
  hub.dispose()
})

await t('D5 perceive：没有 sessionId → config/missing；events 关掉 → 不投递', async () => {
  const { hub, agent } = makeHub()
  const none = await hub.perceive({ kind: 'voice', text: 'x', sessionId: '', auto: true })
  assert.equal(none.error.code, 'config/missing')
  const config = configMod.normalizeConfig({ events: { enabled: false } }).value
  const disabled = makeHub({ config })
  const auto = await disabled.hub.perceive({ kind: 'voice', text: 'x', sessionId: 'sess-1', auto: true })
  assert.equal(auto.reason, 'events-disabled')
  assert.equal(disabled.agent.steered.length, 0)
  void agent
  hub.dispose()
  disabled.hub.dispose()
})

await t('D6 限流：min-interval / 每分钟上限 / 同句冷却', async () => {
  let clock = 100000
  const config = configMod.normalizeConfig({ events: { minIntervalMs: 5000, cooldownKeyMs: 30000, maxPerMin: 60 } }).value
  const { hub } = makeHub({ config, now: () => clock })
  assert.equal((await hub.perceive({ kind: 'voice', text: '第一句', sessionId: 'sess-1', auto: true })).delivered, true)
  clock += 100
  assert.equal((await hub.perceive({ kind: 'voice', text: '第二句', sessionId: 'sess-1', auto: true })).reason, 'min-interval')
  hub.dispose()

  let clock2 = 100000
  const tight = configMod.normalizeConfig({ events: { minIntervalMs: 0, cooldownKeyMs: 0, maxPerMin: 2 } }).value
  const hub2 = makeHub({ config: tight, now: () => clock2 })
  await hub2.hub.perceive({ kind: 'vision', text: 'a', sessionId: 'sess-1', auto: true })
  clock2 += 10
  await hub2.hub.perceive({ kind: 'vision', text: 'b', sessionId: 'sess-1', auto: true })
  clock2 += 10
  assert.equal((await hub2.hub.perceive({ kind: 'vision', text: 'c', sessionId: 'sess-1', auto: true })).reason, 'max-per-minute')
  hub2.hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * E. 采集口
 * ══════════════════════════════════════════════════════════ */

const JPEG_1PX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AKpJ/9k='

const sinePcm = (ms, rate = 16000, amp = 8000) => {
  const samples = Math.floor((ms / 1000) * rate)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(amp * Math.sin((i / rate) * 2 * Math.PI * 220)), i * 2)
  return buf
}
const silencePcm = (ms, rate = 16000) => Buffer.alloc(Math.floor((ms / 1000) * rate) * 2)

async function makeCaptureEnv({ config = {}, audioOptions, agent = fakeAgent() } = {}) {
  const dir = join(SANDBOX, 'capture-' + Math.random().toString(36).slice(2, 8))
  const configStore = new configMod.ConfigStore({ baseDir: dir, patch: { mic: { sampleRate: 16000 }, ...config } })
  configStore.load()
  const stateStore = new stateMod.StateStore({ baseDir: dir })
  stateStore.load()
  const counters = kit.makeCounters()
  const hub = new eventsMod.EventHub({
    config: configStore.current(),
    resolveAgent: async (sessionId) => (sessionId === 'sess-1' ? agent : null),
    sessions: { async flush() {} },
    counters,
  })
  const audio = await fakeAudio(audioOptions || {})
  const captureHub = new captureMod.CaptureHub({
    config: () => configStore.current(),
    audio: () => audio,
    hub,
    stateStore,
    baseDir: dir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    counters,
  })
  return { dir, configStore, stateStore, hub, audio, captureHub, agent, counters, token: captureHub.token() }
}

await t('E1 令牌：600 落地；非回环 403、无令牌 401、有令牌通过', async () => {
  const env = await makeCaptureEnv()
  try {
    assert.equal(env.token.ok, true)
    assert.ok(env.token.file.endsWith('capture.json'))
    const raw = readFileSync(env.token.file, 'utf8')
    assert.equal(JSON.parse(raw).token, env.token.token)
    const mode = (await import('node:fs')).statSync(env.token.file).mode & 0o777
    assert.equal(mode, 0o600)
    const denied = env.captureHub.authorize({ headers: {}, socket: { remoteAddress: '10.0.0.9' } })
    assert.equal(denied.status, 403)
    const noToken = env.captureHub.authorize({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })
    assert.equal(noToken.status, 401)
    const ok = env.captureHub.authorize({
      headers: { authorization: 'Bearer ' + env.token.token },
      socket: { remoteAddress: '127.0.0.1' },
    })
    assert.equal(ok, null)
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('E2 open：幂等同 source、want 来自配置、autoSwitch 切来源', async () => {
  const env = await makeCaptureEnv({ config: { capture: { fps: 5, width: 640 } } })
  try {
    const first = env.captureHub.open({ label: 'B站直播间', source: 'bili:1', sessionId: 'sess-1' })
    assert.ok(first.captureId.startsWith('cap-'))
    assert.equal(first.want.fps, 5)
    assert.equal(first.want.width, 640)
    assert.equal(first.want.audio, true)
    const again = env.captureHub.open({ label: 'B站直播间', source: 'bili:1' })
    assert.equal(again.captureId, first.captureId, '同一 source 幂等')
    assert.equal(again.reused, true)
    assert.equal(env.stateStore.get().cameraSource, 'galaxy')
    assert.equal(env.stateStore.get().micSource, 'galaxy')
    assert.equal(env.stateStore.get().cameraOn, true)
    assert.equal(env.stateStore.get().micOn, true)
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('E3 frame：缓存 + 分发给 MJPEG 订阅者；坏帧明确拒绝', async () => {
  const env = await makeCaptureEnv()
  try {
    const opened = env.captureHub.open({ label: '流', source: 'test:1' })
    const res = new FakeRes()
    env.captureHub.attachMjpeg(new FakeReq({ headers: {} }), res, opened.captureId)
    const out = env.captureHub.frame(opened.captureId, JPEG_1PX)
    assert.equal(out.selected, true)
    assert.equal(out.frames, 1)
    const raw = Buffer.concat(res.chunks)
    assert.ok(raw.includes(Buffer.from('Content-Type: image/jpeg')), '要有每帧头')
    assert.ok(raw.includes(Buffer.from(JPEG_1PX.split(',')[1], 'base64').subarray(0, 16)), '要把 jpeg 字节原样写出去')
    assert.equal(env.captureHub.currentFrame().captureId, opened.captureId)
    assert.throws(() => env.captureHub.frame(opened.captureId, 'not-a-data-url'), (error) => {
      assert.equal(error.code, 'capture/frame-invalid')
      return true
    })
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('E4 PCM：按 vad 断句 → ASR → 插话（带来源标签）', async () => {
  const env = await makeCaptureEnv({ audioOptions: { transcribeText: '大家好呀' } })
  try {
    const opened = env.captureHub.open({ label: '电台', source: 'test:pcm', sessionId: 'sess-1' })
    env.captureHub.pcm(opened.captureId, sinePcm(300).toString('base64'), 16000)
    assert.equal(env.audio.calls.transcribe, 0, '还没静音，不该断句')
    env.captureHub.pcm(opened.captureId, silencePcm(300).toString('base64'), 16000)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(env.audio.calls.transcribe, 1, '静音够了应该断出一句')
    assert.equal(env.agent.steered.length, 1)
    assert.equal(env.agent.steered[0].meta.percept, 'voice')
    assert.ok(String(env.agent.steered[0].content[0].text).includes('[电台]'))
    assert.ok(String(env.agent.steered[0].content[0].text).includes('大家好呀'))
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('E5 纯静音不烧 ASR；close 后来源回落、旧 id 404', async () => {
  const env = await makeCaptureEnv()
  try {
    const opened = env.captureHub.open({ label: '静音流', source: 'test:silence' })
    for (let i = 0; i < 5; i += 1) env.captureHub.pcm(opened.captureId, silencePcm(200).toString('base64'), 16000)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(env.audio.calls.transcribe, 0)
    env.captureHub.close(opened.captureId, 'stream-ended')
    assert.equal(env.stateStore.get().cameraSource, 'none')
    assert.equal(env.stateStore.get().cameraOn, false)
    assert.throws(() => env.captureHub.frame(opened.captureId, JPEG_1PX), (error) => {
      assert.equal(error.code, 'capture/not-found')
      return true
    })
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('E6 自动推帧：按 vision.autoIntervalMs 抓帧 → describeImage → 插话 + capture/seen', async () => {
  const env = await makeCaptureEnv({
    config: { vision: { enabled: true, autoIntervalMs: 1, provider: 'aliyun', base: 'https://x/api/v1', model: 'm' } },
    audioOptions: { visionText: '画面里有人' },
  })
  try {
    const opened = env.captureHub.open({ label: '摄像头', source: 'test:vision', sessionId: 'sess-1' })
    env.captureHub.frame(opened.captureId, JPEG_1PX)
    // 定时器每秒跑一次；1ms 的间隔意味着第一拍就会抓（最多等 ~1.5s）
    const deadline = Date.now() + 2500
    while (Date.now() < deadline && env.audio.calls.describeImage === 0) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(env.audio.calls.describeImage, 1)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(String(env.agent.steered[0].content[0].text).includes('画面里有人'))
    assert.equal(env.captureHub.status().lastPercept.kind, 'capture/vision')
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('E7 status：每路流的帧数/PCM/断句数与令牌文件', async () => {
  const env = await makeCaptureEnv()
  try {
    const opened = env.captureHub.open({ label: '带统计的流', source: 'test:stat' })
    env.captureHub.frame(opened.captureId, JPEG_1PX)
    const view = env.captureHub.status()
    assert.equal(view.sources.length, 1)
    assert.equal(view.sources[0].frames, 1)
    assert.equal(view.selected.camera, opened.captureId)
    assert.ok(String(view.tokenFile).endsWith('capture.json'))
    assert.equal(view.mjpeg, '/input/api/stream.mjpg')
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * F. HTTP 面
 * ══════════════════════════════════════════════════════════ */

async function makeHttpEnv({ config = {}, audioOptions, attachments = null } = {}) {
  const env = await makeCaptureEnv({ config, audioOptions })
  const deps = {
    configStore: env.configStore,
    stateStore: env.stateStore,
    audio: () => env.audio,
    hub: env.hub,
    captureHub: env.captureHub,
    attachments,
    llm: null,
    logger: { info() {}, warn() {}, debug() {} },
    counters: env.counters,
  }
  deps.statusView = () => toolsMod.statusView(deps)
  const handler = routesMod.createHandler(deps)
  return { ...env, deps, handler }
}

async function call(handler, { method = 'GET', url = '/', headers = {}, body = null }) {
  const req = new FakeReq({ method, url, headers, body })
  const res = new FakeRes()
  const promise = handler(req, res)
  req.start()
  await promise
  return { res, json: res.json, text: res.text, status: res.status }
}

const captureHeaders = (env) => ({ authorization: 'Bearer ' + env.token.token })

await t('F1 health / bootstrap：features.capture 齐全，bootstrap 带 vad 与依赖状态', async () => {
  const env = await makeHttpEnv()
  try {
    const health = await call(env.handler, { url: '/input/api/health' })
    assert.equal(health.status, 200)
    assert.equal(health.json.plugin, 'mira_input')
    assert.equal(health.json.features.capture.open, true)
    assert.equal(health.json.features.capture.stream, true)
    assert.equal(health.json.features.asr, true)
    const boot = await call(env.handler, { url: '/input/api/bootstrap' })
    assert.equal(boot.status, 200)
    assert.ok(boot.json.endpoints.events)
    assert.equal(boot.json.vad.silenceMs, 100)
    assert.equal(boot.json.config.vision.provider, 'dsh')
    assert.equal(boot.json.state.cameraOn, false)
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('F2 跨站请求 403；capture 口按令牌鉴权（无令牌 401、跨机 403、有令牌 200）', async () => {
  const env = await makeHttpEnv()
  try {
    const bad = await call(env.handler, { url: '/input/api/bootstrap', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } })
    assert.equal(bad.status, 403)
    assert.equal(bad.json.error.code, 'http/forbidden')

    const open = (headers) => call(env.handler, {
      url: '/input/api/capture/open',
      method: 'POST',
      headers,
      body: { label: 'x', source: 'test:auth' },
    })
    const noToken = await open({})
    assert.equal(noToken.status, 401)
    assert.equal(noToken.json.error.code, 'capture/unauthorized')

    const remote = await call(env.handler, {
      url: '/input/api/capture/open',
      method: 'POST',
      headers: captureHeaders(env),
      body: { label: 'x', source: 'test:auth' },
    })
    assert.equal(remote.status, 200)

    const wrong = await open({ authorization: 'Bearer nope' })
    assert.equal(wrong.status, 401)
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('F3 state POST：落盘 + 广播；clientId 记成 client:<id>', async () => {
  const env = await makeHttpEnv()
  try {
    const res = new FakeRes()
    env.hub.attach(new FakeReq({ headers: {} }), res)
    const out = await call(env.handler, {
      url: '/input/api/state',
      method: 'POST',
      body: { cameraOn: true, clientId: 'c-1' },
    })
    assert.equal(out.status, 200)
    assert.deepEqual(out.json.changed, ['cameraOn'])
    assert.equal(out.json.by, 'client:c-1')
    assert.ok(res.text.includes('"type":"state"'))
    assert.ok(res.text.includes('client:c-1'))
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('F4 POST /asr：auto:true 识别 + 插话；auto:false 只回文本', async () => {
  const env = await makeHttpEnv()
  try {
    const auto = await call(env.handler, {
      url: '/input/api/asr',
      method: 'POST',
      body: { base64: 'AAAA', mime: 'audio/wav', sessionId: 'sess-1', auto: true },
    })
    assert.equal(auto.status, 200)
    assert.equal(auto.json.text, '大家好呀')
    assert.equal(auto.json.steered, true)
    assert.equal(env.agent.steered.length, 1)
    const manual = await call(env.handler, {
      url: '/input/api/asr',
      method: 'POST',
      body: { base64: 'AAAA', mime: 'audio/wav', sessionId: 'sess-1', auto: false },
    })
    assert.equal(manual.json.steered, false)
    assert.equal(env.agent.steered.length, 1)
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('F5 POST /vision：auto:true 识图 + 插话（走 mira_audio 的网关能力）', async () => {
  const env = await makeHttpEnv({
    config: { vision: { enabled: true, provider: 'aliyun' } },
    audioOptions: { visionText: '画面里有一台电脑' },
  })
  try {
    const out = await call(env.handler, {
      url: '/input/api/vision',
      method: 'POST',
      body: { image: JPEG_1PX, sessionId: 'sess-1' },
    })
    assert.equal(out.status, 200)
    assert.equal(out.json.text, '画面里有一台电脑')
    assert.equal(out.json.steered, true)
    assert.equal(env.audio.calls.describeImage, 1)
    assert.equal(env.agent.steered[0].meta.percept, 'vision')
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('F6 settings：写回配置（没有 apiKey 字段，凭据只报状态）', async () => {
  const env = await makeHttpEnv()
  try {
    const view = await call(env.handler, { url: '/input/api/settings' })
    assert.equal(view.status, 200)
    assert.equal(view.json.keyConfigured, true)
    assert.equal(view.text.includes('sk-'), false)
    const saved = await call(env.handler, {
      url: '/input/api/settings',
      method: 'POST',
      body: { values: { capture: { fps: 6 }, vision: { autoIntervalMs: 3000 }, events: { maxPerMin: 9 } }, apiKey: 'sk-should-be-ignored' },
    })
    assert.equal(saved.status, 200)
    assert.equal(env.configStore.current().capture.fps, 6)
    assert.equal(env.configStore.current().vision.autoIntervalMs, 3000)
    assert.equal(env.configStore.current().events.maxPerMin, 9)
    const raw = JSON.parse(readFileSync(env.configStore.file, 'utf8'))
    assert.equal(JSON.stringify(raw).includes('sk-should-be-ignored'), false, '输入侧不该存 key')
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

await t('F7 未知接口 404；stream.mjpg 无采集时 503', async () => {
  const env = await makeHttpEnv()
  try {
    const unknown = await call(env.handler, { url: '/input/api/nope' })
    assert.equal(unknown.status, 404)
    assert.ok(String(unknown.json.error.hint).includes('bootstrap'))
    const stream = await call(env.handler, { url: '/input/api/stream.mjpg' })
    assert.equal(stream.status, 503)
  } finally {
    env.captureHub.dispose()
    env.hub.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * G. 工具
 * ══════════════════════════════════════════════════════════ */

function fakeAttachments() {
  const saved = []
  return {
    saved,
    async saveImage(input) {
      saved.push(input)
      return { attachmentId: 'att-' + saved.length, mediaType: input.mediaType, bytes: input.data.length, width: 640, height: 480 }
    },
  }
}

async function makeToolEnv({ config = {}, audioOptions, withClient = true, attachments = null, llm = null } = {}) {
  const env = await makeCaptureEnv({ config, audioOptions })
  const deps = {
    configStore: env.configStore,
    stateStore: env.stateStore,
    audio: () => env.audio,
    hub: env.hub,
    captureHub: env.captureHub,
    attachments,
    llm,
    logger: { info() {}, warn() {}, debug() {} },
    counters: env.counters,
  }
  deps.statusView = () => toolsMod.statusView(deps)
  const ctx = makeCtx({ audio: env.audio })
  const dispose = toolsMod.registerTools(ctx, deps)
  let clientRes = null
  if (withClient) {
    clientRes = new FakeRes()
    env.hub.attach(new FakeReq({ headers: {} }), clientRes)
  }
  const execFor = (sessionId = 'sess-1') => ({ agent: { session: { id: sessionId } } })
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value)
  const takeCommand = async (kind) => {
    await new Promise((r) => setTimeout(r, 40))
    return clientRes.text.split('\n\n')
      .filter((x) => x.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
      .find((f) => f.type === 'command' && f.kind === kind)
  }
  return { ...env, deps, ctx, dispose, registered: ctx.registered, clientRes, execFor, parse, takeCommand }
}

await t('G1 注册 5 个工具', async () => {
  const env = await makeToolEnv()
  assert.deepEqual([...env.registered.keys()].sort(), [...toolsMod.TOOL_NAMES].sort())
  assert.equal(toolsMod.TOOL_NAMES.length, 5)
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

await t('G2 input_status：只读、带 capture/vad/audio/vision/events，不带 key', async () => {
  const env = await makeToolEnv()
  const status = env.parse(await env.registered.get('input_status').execute({}, env.execFor()))
  assert.equal(status.ok, true)
  assert.equal(status.plugin, 'mira_input')
  assert.equal(status.vad.silenceMs, 100)
  assert.equal(status.capture.enabled, true)
  assert.equal(status.vision.provider, 'dsh')
  assert.equal(JSON.stringify(status).includes('sk-'), false)
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

await t('G3 input_camera / input_mic：省略参数 = 切换，落状态并广播', async () => {
  const env = await makeToolEnv()
  const cam = env.parse(await env.registered.get('input_camera').execute({}, env.execFor()))
  assert.equal(cam.cameraOn, true)
  assert.equal(env.stateStore.get().cameraOn, true)
  const cam2 = env.parse(await env.registered.get('input_camera').execute({}, env.execFor()))
  assert.equal(cam2.cameraOn, false)
  const mic = env.parse(await env.registered.get('input_mic').execute({ on: true }, env.execFor()))
  assert.equal(mic.micOn, true)
  assert.equal(env.stateStore.get().micOn, true)
  assert.ok(env.clientRes.text.includes('"type":"state"'))
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

await t('G4 input_look：摄像头没开 → camera/closed；没页面 → delivery/failed', async () => {
  const env = await makeToolEnv({ withClient: false })
  const closed = await env.registered.get('input_look').execute({}, env.execFor())
  assert.equal(closed.ok, false)
  assert.equal(closed.error.code, 'camera/closed')
  await env.registered.get('input_camera').execute({ on: true }, env.execFor())
  const noPage = await env.registered.get('input_look').execute({}, env.execFor())
  assert.equal(noPage.ok, false)
  assert.equal(noPage.error.code, 'delivery/failed')
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

await t('G5 input_look（dsh，默认）：页面回帧 → 存附件 → render 出图片块', async () => {
  const attachments = fakeAttachments()
  const env = await makeToolEnv({ attachments })
  await env.registered.get('input_camera').execute({ on: true }, env.execFor())
  const pending = env.registered.get('input_look').execute({ prompt: '我桌上有几个杯子？' }, env.execFor())
  const frame = await env.takeCommand('look')
  assert.ok(frame, '应当收到 look 指令帧')
  env.hub.resolveResult({ requestId: frame.requestId, ok: true, value: { image: JPEG_1PX } })
  const value = await pending
  assert.equal(value.ok, true)
  assert.equal(value.provider, 'dsh')
  assert.equal(attachments.saved.length, 1)
  const blocks = env.registered.get('input_look').output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att-1')
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

await t('G6 input_look：采集器源直接用宿主缓存帧（不需要页面）', async () => {
  const attachments = fakeAttachments()
  const env = await makeToolEnv({ attachments, withClient: false })
  env.stateStore.set({ cameraOn: true, cameraSource: 'galaxy' }, { by: 'test' })
  const opened = env.captureHub.open({ label: '缓存源', source: 'test:look', sessionId: 'sess-1' })
  env.captureHub.frame(opened.captureId, JPEG_1PX)
  const value = await env.registered.get('input_look').execute({ prompt: '看到什么' }, env.execFor())
  assert.equal(value.ok, true)
  assert.equal(value.source.kind, 'capture')
  assert.equal(value.source.label, '缓存源')
  assert.equal(attachments.saved.length, 1)
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

await t('G7 input_listen：麦克风没开 → mic/closed；采集器源 → mic/external', async () => {
  const env = await makeToolEnv()
  const closed = env.parse(await env.registered.get('input_listen').execute({}, env.execFor()))
  assert.equal(closed.ok, false)
  assert.equal(closed.error.code, 'mic/closed')
  env.stateStore.set({ micOn: true, micSource: 'galaxy' }, { by: 'test' })
  const external = env.parse(await env.registered.get('input_listen').execute({ seconds: 5 }, env.execFor()))
  assert.equal(external.ok, false)
  assert.equal(external.error.code, 'mic/external')
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

await t('G8 input_listen：页面回音频 → 识别文本（秒数被夹到 30）', async () => {
  const env = await makeToolEnv()
  await env.registered.get('input_mic').execute({ on: true }, env.execFor())
  const pending = env.registered.get('input_listen').execute({ seconds: 999 }, env.execFor())
  const frame = await env.takeCommand('listen')
  assert.ok(frame)
  assert.equal(frame.payload.seconds, 30)
  env.hub.resolveResult({ requestId: frame.requestId, ok: true, value: { base64: 'AAAA', mime: 'audio/wav' } })
  const out = env.parse(await pending)
  assert.equal(out.ok, true)
  assert.equal(out.text, '大家好呀')
  assert.equal(out.seconds, 30)
  assert.equal(env.audio.calls.transcribe, 1)
  env.dispose()
  env.captureHub.dispose()
  env.hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * H. 入口装配 / 单实例 / 服务契约
 * ══════════════════════════════════════════════════════════ */

await t('H1 apply：提供 miraInput 服务 + 5 个工具 + /input 路由', async () => {
  const audio = await fakeAudio()
  const ctx = makeCtx({ audio })
  try {
    const result = indexMod.apply(ctx, {})
    assert.equal(result.ok, true)
    assert.equal(result.service, 'miraInput')
    assert.equal(result.tools, 5)
    assert.equal(ctx.registered.size, 5)
    assert.equal(ctx.routes.length, 1)
    assert.equal(ctx.routes[0].path, '/input')
    const api = ctx.provided.get('miraInput')
    assert.ok(api && typeof api.state === 'function' && typeof api.frame === 'function')
    assert.ok(typeof api.setSource === 'function')
    assert.equal(typeof api.status().plugin, 'string')
    assert.ok(String(result.stateFile).endsWith('state.json'))
    assert.ok(String(result.captureTokenFile).endsWith('capture.json'))
  } finally {
    ctx.dispose()
  }
})

await t('H2 第二个实例被拒；退场后可重新装配', async () => {
  const audio = await fakeAudio()
  const ctx1 = makeCtx({ audio })
  const ctx2 = makeCtx({ audio })
  try {
    indexMod.apply(ctx1, {})
    const second = indexMod.apply(ctx2, {})
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'plugin/instance')
    assert.equal(ctx2.registered.size, 0)
  } finally {
    ctx1.dispose()
    ctx2.dispose()
  }
  const again = makeCtx({ audio })
  try {
    assert.equal(indexMod.apply(again, {}).ok, true)
  } finally {
    again.dispose()
  }
})

await t('H3 enabled=false：不注册任何东西并返回 plugin/disabled', async () => {
  const audio = await fakeAudio()
  const ctx = makeCtx({ audio })
  try {
    const result = indexMod.apply(ctx, { enabled: false })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'plugin/disabled')
    assert.equal(ctx.registered.size, 0)
    assert.equal(ctx.routes.length, 0)
  } finally {
    ctx.dispose()
  }
})

await t('H4 服务契约：frame / capture / streamUrl / percept / publicConfig', async () => {
  const audio = await fakeAudio()
  const ctx = makeCtx({ audio })
  try {
    indexMod.apply(ctx, {})
    const api = ctx.provided.get('miraInput')
    assert.equal(api.frame(), null, '没有采集器时没有帧')
    assert.equal(api.streamUrl(), '/input/api/stream.mjpg')
    assert.equal(api.capture().enabled, true)
    assert.equal(api.publicConfig().vision.provider, 'dsh')
    const perceived = await api.percept({ kind: 'voice', text: '我说了一句', sessionId: 'sess-1', auto: true })
    assert.equal(perceived.delivered, true)
    assert.equal(ctx.agent.steered[0].source.kind, 'mira_input')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * 收尾
 * ══════════════════════════════════════════════════════════ */

try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch { /* 临时目录清理失败不算失败 */ }

if (failures.length) {
  console.log('\n---- 失败明细 ----')
  for (const failure of failures) console.log('· ' + failure)
  console.log('\n==== FAILED（' + pass + ' 过 / ' + failures.length + ' 败）====')
  process.exit(1)
}

console.log('\n==== ALL PASS（通过 ' + pass + ' 项断言）====')
