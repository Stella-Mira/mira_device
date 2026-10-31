/**
 * mira_input / routes.js —— 宿主侧的 HTTP 面（`/input/api/*`）
 *
 * 数据流（一眼看懂）：
 *   浏览器 → 宿主：bootstrap / state / asr / vision / result / settings
 *   宿主 → 浏览器：events（SSE：state / capture.* / command）
 *   采集器（muse_galaxy 等）→ 宿主：capture/open|frame|pcm|ping|close（本机回环 + 令牌）
 *   面板 ← 宿主：stream.mjpg（multipart JPEG，一个 <img> 就能播）
 *
 * 安全：
 *   · 所有 /input/api/* 只接受同源请求（这些接口能改状态、烧 ASR/识图额度、往会话里插话）；
 *   · capture/* 额外要求**本机回环 + capture 令牌**（它们能把别处的画面/声音喂进来）；
 *     stream.mjpg 是只读显示，只要同源（`<img>` 发不出 Authorization 头）。
 */

import { MiraError, fail, okObj, toError } from './kit.mjs'
import { publicConfig } from './config.js'

export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

export function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8')
}

/** 同源守卫：`Sec-Fetch-Site: cross-site` 一律拒；`Origin` 与 `Host` 不同源一律拒；无 Origin 放行。 */
export function isSameOriginRequest(req) {
  const headers = req && req.headers ? req.headers : {}
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const rawOrigin = headers.origin
  if (rawOrigin === undefined || rawOrigin === null) return true
  const origin = String(rawOrigin).trim()
  if (origin === '') return true
  if (origin.toLowerCase() === 'null') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = String(headers.host || '').trim().toLowerCase()
  if (host === '') return false
  return parsed.host.toLowerCase() === host
}

export function readJsonBody(req, maxBytes) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let finished = false
    const done = (value) => {
      if (finished) return
      finished = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        done({
          ok: false,
          status: 413,
          error: {
            code: 'payload/too-large',
            message: '请求体超过上限 ' + maxBytes + ' 字节',
            hint: '音频/图像请缩短或降分辨率；常规 API 请求应小于 64 KiB',
          },
        })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        done({ ok: true, value: {} })
        return
      }
      try {
        done({ ok: true, value: JSON.parse(raw) })
      } catch {
        done({
          ok: false,
          status: 400,
          error: { code: 'payload/invalid', message: '请求体不是合法 JSON', hint: '用 Content-Type: application/json 并检查拼写' },
        })
      }
    })
    req.on('error', (error) => {
      done({
        ok: false,
        status: 400,
        error: { code: 'payload/read-failed', message: '读取请求体失败：' + (error?.message || error), hint: '重试' },
      })
    })
  })
}

/**
 * 主处理器。
 *
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {object} deps.stateStore
 * @param {() => object} deps.audio   miraAudio 服务（每次取新的，拿它做 ASR / 识图 / VAD 参数）
 * @param {object} deps.hub
 * @param {object} deps.captureHub
 * @param {object} [deps.logger]
 * @param {object} [deps.counters]
 */
export function createHandler(deps) {
  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url, 'http://x')
    } catch {
      send(res, 400, 'bad url')
      return undefined
    }
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      pathname = url.pathname
    }
    if (!pathname.startsWith('/input/api/')) {
      send(res, 404, 'not found')
      return undefined
    }
    return handleApi(pathname.slice('/input/api/'.length), url, req, res, deps)
  }
}

async function handleApi(sub, url, req, res, deps) {
  const method = (req.method || 'GET').toUpperCase()

  /* ── 外部采集器（muse_galaxy 等）：虚拟摄像头 / 虚拟麦克风 ──────────────
   * 只接受本机回环 + capture 令牌。放在同源校验之前：采集器不是浏览器页面，
   * 没有 Origin 头；它靠令牌证明身份（令牌只在本机 600 文件里）。
   */
  if (sub === 'capture/open' || sub === 'capture/frame' || sub === 'capture/pcm'
    || sub === 'capture/close' || sub === 'capture/ping') {
    if (method !== 'POST') {
      return sendJson(res, 405, fail('http/method', '采集口只接受 POST', '读取画面请用 GET /input/api/stream.mjpg'))
    }
    if (!deps.captureHub) return sendJson(res, 503, fail('capture/absent', '采集器未装配', '看启动日志'))
    const denied = deps.captureHub.authorize(req)
    if (denied) return sendJson(res, denied.status, { ok: false, error: denied.error })
    let cfg = null
    try {
      cfg = deps.configStore.current()
    } catch { /* 配置坏了：照旧收流（画面还能看），识别会报配置错误 */ }
    if (cfg && cfg.capture && cfg.capture.enabled === false) {
      return sendJson(res, 503, fail('config/missing', '采集器已关闭：capture.enabled=false',
        '在「设置 · 输入」里打开，或把 config.json 的 capture.enabled 改成 true'))
    }
    const parsed = await readJsonBody(req, 8 * 1024 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const body = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
    try {
      if (sub === 'capture/open') {
        const opened = deps.captureHub.open(body)
        return sendJson(res, 200, okObj({
          captureId: opened.captureId,
          want: opened.want,
          reused: opened.reused,
          selected: opened.selected,
          cameraUrl: '/input/api/stream.mjpg?capture=' + opened.captureId,
          events: '/input/api/events',
        }))
      }
      if (sub === 'capture/frame') {
        const out = deps.captureHub.frame(body.captureId, body.jpeg ?? body.image ?? body.dataUrl)
        return sendJson(res, 200, okObj(out))
      }
      if (sub === 'capture/pcm') {
        const out = deps.captureHub.pcm(body.captureId, body.pcm ?? body.base64, body.sampleRate)
        return sendJson(res, 200, okObj(out))
      }
      if (sub === 'capture/close') {
        return sendJson(res, 200, okObj(deps.captureHub.close(body.captureId, String(body.reason || 'closed'))))
      }
      return sendJson(res, 200, okObj(deps.captureHub.ping(body.captureId)))
    } catch (error) {
      const normalized = toError(error)
      const code = normalized.error.code
      const status = code === 'capture/not-found' ? 404
        : code === 'capture/frame-too-big' ? 413
          : code === 'capture/forbidden' ? 403
            : 400
      return sendJson(res, status, normalized)
    }
  }

  if (!isSameOriginRequest(req)) {
    return sendJson(res, 403, fail('http/forbidden',
      '拒绝跨站请求：/input/api/' + sub + ' 只接受同源请求',
      '这些接口能改状态、烧 ASR/识图额度、往会话里插话；别的站点不能调用'))
  }

  // 面板显示：multipart JPEG（浏览器一个 <img> 就能播）。**只读 + 同源**，不要令牌 ——
  // `<img src>` 发不出 Authorization 头，要它等于让面板永远打不开画面。
  if (sub === 'stream.mjpg' && method === 'GET') {
    if (!deps.captureHub) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no capture')
      return undefined
    }
    return deps.captureHub.attachMjpeg(req, res, url.searchParams.get('capture'))
  }

  // 配置坏了：除了 settings（要能把「为什么不可用」显示出来）与 health，其余一律拒
  let cfg = null
  let configError = null
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configError = toError(error)
    if (sub !== 'settings' && sub !== 'health') return sendJson(res, 503, configError)
  }

  if (sub === 'health' && method === 'GET') {
    const capture = deps.captureHub ? deps.captureHub.status() : null
    const audioStatus = safeAudioStatus(deps)
    return sendJson(res, 200, okObj({
      plugin: 'mira_input',
      clients: deps.hub.clientCount,
      configError: configError ? configError.error : null,
      configFile: deps.configStore.file,
      stateFile: deps.stateStore.file,
      // 采集器探测：muse_galaxy 用它判断输入侧是否实现了采集口
      features: {
        capture: capture
          ? { open: true, frame: true, pcm: true, close: true, ping: true, stream: true, enabled: capture.enabled }
          : null,
        asr: audioStatus ? audioStatus.asr.enabled === true : null,
        vad: audioStatus ? true : null,
      },
      capture,
    }))
  }

  if (sub === 'bootstrap' && method === 'GET') {
    const stateView = safeState(deps)
    const audioStatus = safeAudioStatus(deps)
    let vad = null
    try {
      const audio = deps.audio()
      vad = typeof audio?.vad === 'function' ? audio.vad() : null
    } catch { /* mira_audio 不可用：vad 留空，前端用默认值 */ }
    return sendJson(res, 200, okObj({
      config: cfg ? publicConfig(cfg) : null,
      state: stateView.state,
      stateError: stateView.error,
      // 断句阈值由 mira_audio 决定（切分属于声音能力），这里只是转给前端用
      vad,
      features: {
        configured: audioStatus ? audioStatus.configured === true : false,
        tts: audioStatus ? audioStatus.tts : null,
        asr: audioStatus ? audioStatus.asr : null,
        vision: cfg ? { enabled: cfg.vision.enabled === true, provider: cfg.vision.provider, autoIntervalMs: cfg.vision.autoIntervalMs } : null,
      },
      configError: configError ? configError.error : null,
      configFile: deps.configStore.file,
      stateFile: deps.stateStore.file,
      endpoints: {
        events: '/input/api/events',
        state: '/input/api/state',
        asr: '/input/api/asr',
        vision: '/input/api/vision',
        result: '/input/api/result',
        settings: '/input/api/settings',
        capture: '/input/api/capture/open',
        stream: '/input/api/stream.mjpg',
      },
    }))
  }

  if (sub === 'events' && method === 'GET') {
    deps.hub.attach(req, res)
    return undefined
  }

  if (sub === 'state' && method === 'GET') {
    const view = safeState(deps)
    return sendJson(res, view.error ? 503 : 200, view.error ? { ok: false, error: view.error } : okObj({ state: view.state }))
  }

  if (sub === 'state' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    try {
      const body = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
      // 记下是哪个页面改的：多设备时只有发起方该去动本机摄像头/麦克风
      const clientId = String(body.clientId ?? '').slice(0, 64)
      const by = clientId ? 'client:' + clientId : 'client'
      const result = deps.stateStore.set(body, { by })
      if (result.changed.length) {
        deps.hub.broadcast('state', { state: result.state, changed: result.changed, by })
      }
      return sendJson(res, 200, okObj({ state: result.state, changed: result.changed, by }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'result' && method === 'POST') {
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const outcome = deps.hub.resolveResult(parsed.value || {})
    return sendJson(res, outcome.ok ? 200 : 404, outcome)
  }

  if (sub === 'asr' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 16 * 1024 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const value = parsed.value || {}
    try {
      const audio = deps.audio()
      const outcome = await audio.transcribe({
        base64: String(value.base64 ?? value.audio ?? ''),
        mime: String(value.mime || 'audio/wav'),
        // 原生识别口要 sample_rate（浏览器按 mic.sampleRate 录的）
        sampleRate: Number(value.sampleRate) || 0,
      })
      const auto = value.auto !== false
      const sessionId = String(value.sessionId ?? '')
      // 自动事件流（auto:true，界面里连续识别）→ 按 events 配置投递；
      // 显式调用（auto:false）默认**只回文本**，要投递必须再传 steer:true。
      const wantSteer = auto || value.steer === true
      let steer = null
      if (outcome.text !== '' && wantSteer) {
        steer = await deps.hub.perceive({ kind: 'voice', text: outcome.text, sessionId, auto })
      }
      return sendJson(res, 200, okObj({
        text: outcome.text,
        model: outcome.model,
        chars: Array.from(outcome.text || '').length,
        durationMs: Number(value.durationMs) || 0,
        steered: steer ? steer.delivered === true : false,
        steer: steer && steer.reason ? { reason: steer.reason } : undefined,
      }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'vision' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    if (cfg && cfg.vision && cfg.vision.enabled === false) {
      return sendJson(res, 503, fail('config/missing', '图像识别被禁用：vision.enabled=false',
        '在「设置 · 输入」里打开'))
    }
    const parsed = await readJsonBody(req, 16 * 1024 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const value = parsed.value || {}
    try {
      const audio = deps.audio()
      const vision = (cfg && cfg.vision) || {}
      const outcome = await audio.describeImage({
        dataUrl: String(value.image ?? ''),
        prompt: String(value.prompt ?? vision.prompt ?? ''),
        base: String(vision.base || ''),
        model: String(vision.model || ''),
        timeoutMs: Number(vision.timeoutMs) || 30000,
      })
      const auto = value.auto !== false
      const sessionId = String(value.sessionId ?? '')
      const wantSteer = auto || value.steer === true
      let steer = null
      if (outcome.text !== '' && wantSteer) {
        steer = await deps.hub.perceive({ kind: 'vision', text: outcome.text, sessionId, auto })
      }
      return sendJson(res, 200, okObj({
        text: outcome.text,
        model: outcome.model,
        chars: Array.from(outcome.text || '').length,
        steered: steer ? steer.delivered === true : false,
        steer: steer && steer.reason ? { reason: steer.reason } : undefined,
      }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'settings' && method === 'GET') {
    return sendJson(res, 200, buildSettingsView(deps))
  }

  if (sub === 'settings' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 256 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    try {
      return sendJson(res, 200, writeSettings(deps, parsed.value || {}))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  return sendJson(res, 404, fail('http/not-found', '未知接口：/input/api/' + sub, '见 GET /input/api/bootstrap 的 endpoints'))
}

function safeState(deps) {
  try {
    return { state: deps.stateStore.get(), error: null }
  } catch (error) {
    return { state: deps.stateStore.snapshot(), error: toError(error).error }
  }
}

/** 声音侧的状态（拿不到就 null：输入插件不该因为声音插件坏了而崩）。 */
function safeAudioStatus(deps) {
  try {
    const audio = deps.audio()
    return audio && typeof audio.status === 'function' ? audio.status() : null
  } catch {
    return null
  }
}

/** 设置页 GET：只回可编辑项 + 「key 配没配」（key 在 mira_audio，只报状态）。 */
export function buildSettingsView(deps) {
  const status = deps.configStore.status()
  let cfg = null
  let configError = status.error
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configError = toError(error).error
  }
  const effective = cfg || deps.configStore.cache || null
  const audioStatus = safeAudioStatus(deps)
  const view = {
    ok: true,
    configFile: deps.configStore.file,
    // 凭据不在这里：只把「声音插件那份 key 配没配」显示出来，避免用户以为输入侧也要再填一次
    keyConfigured: audioStatus ? audioStatus.configured === true : false,
    credsFile: audioStatus ? audioStatus.credsFile : '',
    warnings: status.warnings.slice(),
    seededFrom: status.seededFrom || '',
    configError: configError || null,
  }
  if (effective) {
    view.values = {
      camera: { ...effective.camera },
      mic: { ...effective.mic },
      capture: {
        enabled: effective.capture.enabled,
        fps: effective.capture.fps,
        width: effective.capture.width,
        audio: effective.capture.audio,
        autoSwitch: effective.capture.autoSwitch,
        staleMs: effective.capture.staleMs,
        lostMs: effective.capture.lostMs,
      },
      vision: {
        enabled: effective.vision.enabled,
        provider: effective.vision.provider,
        base: effective.vision.base,
        model: effective.vision.model,
        prompt: effective.vision.prompt,
        autoIntervalMs: effective.vision.autoIntervalMs,
      },
      events: {
        enabled: effective.events.enabled,
        steer: effective.events.steer,
        minIntervalMs: effective.events.minIntervalMs,
        maxPerMin: effective.events.maxPerMin,
        cooldownKeyMs: effective.events.cooldownKeyMs,
        voiceTemplate: effective.events.voiceTemplate,
        visionTemplate: effective.events.visionTemplate,
      },
    }
    view.runtime = {
      capture: deps.captureHub ? deps.captureHub.status() : null,
      vad: audioStatus ? audioStatus.vad : null,
    }
  }
  return view
}

/** 设置页 POST：白名单字段深合并写回 config.json（没有 apiKey —— 凭据只有 mira_audio 一份）。 */
export function writeSettings(deps, body) {
  const values = body && typeof body === 'object' && body.values && typeof body.values === 'object'
    ? body.values
    : body
  const patch = pickSettings(values)
  const changed = []
  const before = deps.configStore.current()
  const after = deps.configStore.save(patch)
  for (const key of Object.keys(patch)) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after.value?.[key])) changed.push(key)
  }
  // events 的限流参数是事件总线自己缓存的：保存后立刻换一份，不用等重载
  try {
    deps.hub?.setConfig?.(after.value)
  } catch { /* 配置坏了也不挡保存 */ }
  return okObj({ ...buildSettingsView(deps), changed })
}

const SETTINGS_SHAPE = {
  camera: ['enabled', 'deviceId', 'width', 'height'],
  mic: ['enabled', 'deviceId', 'sampleRate'],
  capture: ['enabled', 'fps', 'width', 'audio', 'autoSwitch', 'maxAudioMs', 'staleMs', 'lostMs'],
  vision: ['enabled', 'provider', 'base', 'model', 'prompt', 'timeoutMs', 'autoIntervalMs'],
  events: ['enabled', 'steer', 'minIntervalMs', 'maxPerMin', 'cooldownKeyMs', 'voiceTemplate', 'visionTemplate', 'maxChars'],
}

/** 只收设置页认得的字段（其余一律忽略，避免前端把 runtime 字段写进配置）。 */
export function pickSettings(values) {
  const patch = {}
  if (!values || typeof values !== 'object') return patch
  for (const [group, keys] of Object.entries(SETTINGS_SHAPE)) {
    const source = values[group]
    if (!source || typeof source !== 'object') continue
    const target = {}
    for (const key of keys) {
      if (source[key] !== undefined) target[key] = source[key]
    }
    if (Object.keys(target).length) patch[group] = target
  }
  return patch
}

export { MiraError }
