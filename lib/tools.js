/**
 * mira_device / tools.js —— 5 个 JSON 工具（返回结构按约定4）
 *
 * 设计口径：
 *   · 这里是**输入能力**：开/关摄像头与麦克风、取一帧给 agent 看、录一段送识别。
 *   · 取帧优先用采集器缓存在宿主里的那一帧（不需要页面在场）；本机设备源才让浏览器抓。
 *   · 「看」走哪条路由 `vision.provider` 决定：dsh = 把帧作为图片给当前会话的模型自己看
 *     （走附件库，和 read_image 同一条路）；aliyun = 交给 mira_media 的网关能力换一段文字。
 *   · 识别（ASR）与断句阈值（VAD）都不在这里实现，借 `miraMedia` 服务。
 */

import { textTool, toError } from './kit.mjs'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

export const TOOL_NAMES = [
  'device_status',
  'device_say',
  'device_camera',
  'device_mic',
  'device_look',
  'device_listen',
]

/**
 * @param {object} ctx
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {object} deps.stateStore
 * @param {() => object} deps.audio      miraMedia 服务
 * @param {object} deps.hub
 * @param {object} deps.captureHub
 * @param {() => object} deps.statusView
 * @param {object} [deps.attachments]    宿主附件库（vision.provider=dsh 时用）
 * @param {object} [deps.llm]            宿主模型服务（检查当前模型吃不吃图片）
 * @param {object} [deps.logger]
 */
export function registerTools(ctx, deps) {
  const disposers = []
  /**
   * 会话级操作都要过权限：设备与形象共用一个持有者（miraDevice.authz）。
   * 只读的 device_status 不拦；其余（说话/开关/看/听）必须 taker，首次自动认领。
   */
  const GATED = ['device_say', 'device_camera', 'device_mic', 'device_look', 'device_listen']
  const register = (definition) => {
    if (!GATED.includes(definition.name) || !deps.authorizer) {
      disposers.push(ctx.tools.register(definition))
      return
    }
    const inner = definition.execute
    disposers.push(ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        const sessionId = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id || '') : ''
        const guard = deps.authorizer.requireControl(sessionId, { force: args?.force === true, tool: definition.name })
        if (!guard.ok) {
          return JSON.stringify({ ok: false, error: guard.error }, null, 2)
        }
        return inner(args, exec)
      },
    }))
  }

  register(textTool(
    'device_status',
    '只读：输入侧状态（摄像头/麦克风开关与来源、外部采集器每路流的帧数与断句数、断句阈值、自动推帧间隔、ASR/识图就绪情况、连着的页面数）。排查「为什么没画面/没声音」先调这个。',
    obj({}),
    async () => deps.statusView(),
  ))

  register(textTool(
    'device_say',
    '让设备说话：合成（miraMedia）后在页面播放器里出声（形象页的口型/气泡跟着音量动）。需要页面在场；返回 delivered/clients。',
    obj({
      text: str('要说的话（受媒体侧 tts.maxChars 限制）'),
      voice: str('可选音色覆盖（默认用媒体设置的音色）'),
      force: bool('可选：true = 抢走权限（原持有者让位）'),
    }, ['text']),
    async (args) => {
      const text = String(args?.text ?? '')
      if (text.trim() === '') {
        return { ok: false, error: { code: 'tts/failed', message: 'text 为空', hint: '传要朗读的文字' } }
      }
      if (deps.hub.clientCount === 0) {
        return { ok: false, error: { code: 'delivery/failed', message: '没有页面连着，没地方播', hint: '打开 DSH 页面再试' } }
      }
      return deps.say(deps.configStore.current(), text, String(args?.voice ?? ''))
    },
  ))

  // 摄像头/麦克风开关：只改"输入侧状态"，真正的硬件在页面里（浏览器 getUserMedia）。
  // 这两个不是"控制形象"，是"允不允许输入进来"，所以不做账号权限判定。
  register(textTool(
    'device_camera',
    '打开或关闭输入侧的摄像头（本机设备 / 外部采集器）。关闭时「形象」侧边栏「视频」显示黑屏；打开后显示画面（take-a-frame 也用它）。',
    obj({ on: bool('true=打开，false=关闭；省略 = 切换') }),
    async (args) => {
      const current = deps.stateStore.snapshot().cameraOn
      const on = typeof args?.on === 'boolean' ? args.on : !current
      const result = deps.stateStore.set({ cameraOn: on }, { by: 'tool' })
      deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return {
        ok: true,
        cameraOn: on,
        cameraSource: result.state.cameraSource,
        clients: deps.hub.clientCount,
        note: on ? '本机设备源下需要页面在场才能真的打开摄像头' : '',
      }
    },
  ))

  register(textTool(
    'device_mic',
    '打开或关闭输入侧的麦克风。关闭时不采集、不识别；打开后说话会被断句识别，并按配置作为插话送进会话。',
    obj({ on: bool('true=打开，false=关闭；省略 = 切换') }),
    async (args) => {
      const current = deps.stateStore.snapshot().micOn
      const on = typeof args?.on === 'boolean' ? args.on : !current
      const result = deps.stateStore.set({ micOn: on }, { by: 'tool' })
      deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return { ok: true, micOn: on, micSource: result.state.micSource, clients: deps.hub.clientCount }
    },
  ))

  register(lookTool(deps))

  register(textTool(
    'device_listen',
    '录一段麦克风（本机设备源）→ 交给 mira_media 识别 → 返回文字。需要麦克风已打开且有页面连着；外部采集器源不支持按需回放（它自己会送整句）。',
    obj({
      seconds: num('录多久（秒），默认 5，最多 30'),
      steer: bool('true = 同时把识别结果作为插话送进当前会话（默认 false）'),
    }),
    async (args, exec) => {
      const state = deps.stateStore.snapshot()
      let cfg = null
      try {
        cfg = deps.configStore.current()
      } catch (error) {
        return { ok: false, error: toError(error).error }
      }
      if (cfg.mic.enabled !== true) {
        return { ok: false, error: { code: 'config/missing', message: '麦克风在配置里被禁用（mic.enabled=false）', hint: '在「设置 · 输入」里打开麦克风' } }
      }
      if (!state.micOn) {
        return { ok: false, error: { code: 'mic/closed', message: '麦克风没打开', hint: '先点输入框里的「麦克风」按钮，或调 device_mic on:true' } }
      }
      // 采集器源没有"回放最近 N 秒"的能力（音频由采集端持续推、由 vad 实时断句）：
      // 明确回报，别让模型以为自己在按需录音。
      if (String(state.micSource || 'device') === 'galaxy') {
        return {
          ok: false,
          source: { kind: 'capture' },
          error: {
            code: 'mic/external',
            message: '麦克风来源是外部采集器（muse_galaxy 等），不支持按需回放录音',
            hint: '它会把整句实时送来并自动插话；要看波形/识别请用 device_status 的 capture 段',
          },
        }
      }
      const seconds = Math.max(1, Math.min(30, Number(args?.seconds) || 5))
      const clip = await deps.hub.request('listen', { seconds }, { timeoutMs: (seconds + 20) * 1000 })
      const base64 = String(clip?.base64 ?? '')
      if (base64 === '') {
        return { ok: false, error: { code: 'asr/failed', message: '浏览器没有返回音频', hint: '确认页面上的麦克风波形在动（有声音输入）' } }
      }
      const outcome = await deps.audio().transcribe({
        base64,
        mime: String(clip?.mime || 'audio/wav'),
        sampleRate: Number(clip?.sampleRate) || 0,
      })
      let steer = null
      const sessionId = sessionIdOf(exec)
      if (args?.steer === true && outcome.text !== '') {
        steer = await deps.hub.perceive({ kind: 'voice', text: outcome.text, sessionId, auto: false })
      }
      return { ok: true, text: outcome.text, model: outcome.model, seconds, steered: steer ? steer.delivered === true : false }
    },
  ))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch { /* 退场不抛 */ }
    }
  }
}

/**
 * `device_look`：让 agent 取当前一帧。
 *
 * 两条路（`vision.provider`）：
 *   dsh（默认）—— 把这一帧作为**图片内容块**放进工具结果，交给当前会话的模型自己看。
 *     完全照 `read_image` 的约定：`attachments.saveImage()` → `render` 返回
 *     `[{type:'text'…},{type:'image', attachment}]`。不调第三方、不额外花钱。
 *   aliyun —— 交给 mira_media 的网关能力换一段文字（自动推帧走的就是这条，因为那条路没有模型参与）。
 */
function lookTool(deps) {
  return {
    name: 'device_look',
    description: '取输入侧当前一帧：默认把这一帧直接交给当前会话的模型看（和 read_image 一样是图片输入，不调阿里云）；vision.provider=aliyun 时才服务端识图返回一段文字。摄像头要开着；外部采集器源下不需要页面在场。',
    parameters: obj({
      prompt: str('可选：想问的问题（默认用输入侧配置里的提示词）'),
      steer: bool('仅 aliyun 模式有效：true = 把识别结果作为插话送进当前会话（默认 false）'),
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          provider: { type: 'string' },
          text: { type: 'string' },
          path: { type: 'string' },
          question: { type: 'string' },
          note: { type: 'string' },
          steered: { type: 'boolean' },
          source: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              label: { type: 'string' },
              captureId: { type: 'string' },
            },
          },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              hint: { type: 'string' },
            },
          },
        },
        required: ['ok'],
      },
      render: (_args, value) => renderLook(value),
      presentationMeta: (_args, value) => ({
        provider: value && value.provider,
        path: value && value.path,
      }),
    },
    async execute(args, exec) {
      try {
        return await runLook(deps, args ?? {}, exec)
      } catch (error) {
        return { ok: false, provider: 'unknown', error: toError(error).error }
      }
    },
  }
}

async function runLook(deps, args, exec) {
  let cfg = null
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    return { ok: false, error: toError(error).error }
  }
  if (cfg.camera.enabled !== true) {
    return { ok: false, error: { code: 'config/missing', message: '摄像头在配置里被禁用（camera.enabled=false）', hint: '在「设置 · 输入」里打开摄像头' } }
  }
  const state = deps.stateStore.snapshot()
  if (!state.cameraOn) {
    return { ok: false, error: { code: 'camera/closed', message: '摄像头没打开', hint: '先点输入框里的「摄像头」按钮，或调 device_camera on:true' } }
  }
  const question = String(args?.prompt ?? '').trim()

  // 采集器源：帧就在宿主内存里，直接用 —— 不需要页面在场，也不用再让浏览器抓一次
  let dataUrl = ''
  let fromCapture = null
  if (String(state.cameraSource || 'device') === 'galaxy' && deps.captureHub) {
    const frame = deps.captureHub.currentFrame?.() || null
    if (frame) {
      dataUrl = frame.dataUrl
      fromCapture = { captureId: frame.captureId, label: frame.label, at: frame.at }
    }
  }
  if (dataUrl === '') {
    const shot = await deps.hub.request('look', { prompt: question }, { timeoutMs: 20000 })
    dataUrl = String(shot?.image ?? '')
  }
  if (dataUrl === '') {
    return { ok: false, error: { code: 'vision/failed', message: '浏览器没有返回图像帧', hint: '确认摄像头预览有画面（点一下「摄像头」按钮）' } }
  }

  if (cfg.vision.provider === 'aliyun') {
    const outcome = await deps.audio().describeImage({
      dataUrl,
      prompt: question,
      base: String(cfg.vision.base || ''),
      model: String(cfg.vision.model || ''),
      timeoutMs: Number(cfg.vision.timeoutMs) || 30000,
    })
    let steer = null
    if (args?.steer === true && outcome.text !== '') {
      steer = await deps.hub.perceive({ kind: 'vision', text: outcome.text, sessionId: sessionIdOf(exec), auto: false })
    }
    return {
      ok: true,
      provider: 'aliyun',
      text: outcome.text,
      source: fromCapture ? { kind: 'capture', label: fromCapture.label, captureId: fromCapture.captureId } : { kind: 'device' },
      note: '（vision.provider=aliyun：这是服务端识别出的文字）',
      steered: steer ? steer.delivered === true : undefined,
    }
  }

  // ── dsh：把帧交给当前会话的模型 ──
  const attachments = deps.attachments
  if (!attachments || typeof attachments.saveImage !== 'function') {
    return {
      ok: false,
      provider: 'dsh',
      error: {
        code: 'platform/unsupported',
        message: 'DSH 没有挂载附件服务（attachments），没法把画面作为图片交给模型',
        hint: '确认宿主加载了 dsh-attachment-local；或在「设置 · 输入」里把「图像识别」改成 aliyun',
      },
    }
  }
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) {
    return { ok: false, provider: 'dsh', error: { code: 'vision/failed', message: '浏览器返回的帧不是 data:image/...;base64,...', hint: '刷新页面后重试' } }
  }
  // 能力检查（照 read_image 的做法）：当前会话模型必须声明 image 输入，否则让用户换模型/换 provider
  const model = exec && exec.agent && exec.agent.options ? String(exec.agent.options.model || '') : ''
  const providerId = exec && exec.agent && exec.agent.options ? String(exec.agent.options.provider || '') : ''
  const llm = deps.llm
  if (llm && typeof llm.resolveModelInfo === 'function' && providerId && model) {
    let modalities
    try {
      const info = await llm.resolveModelInfo(providerId, model, exec.signal)
      modalities = info && info.inputModalities
    } catch { /* 解析不到就别拦，让宿主自己报 */ }
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      return {
        ok: false,
        provider: 'dsh',
        error: {
          code: 'vision/unsupported',
          message: '当前模型 ' + model + ' 不接受图像输入（inputModalities 里没有 image）',
          hint: '换一个多模态模型，或在「设置 · 输入」里把「图像识别」改成 aliyun（服务端识图）',
        },
      }
    }
  }
  let ref
  try {
    ref = await attachments.saveImage({
      data: parsed.data,
      mediaType: parsed.mediaType,
      name: 'input-look-' + Date.now() + '.jpg',
    })
  } catch (error) {
    return {
      ok: false,
      provider: 'dsh',
      error: {
        code: 'vision/failed',
        message: '把画面存成附件失败：' + (error && error.message ? error.message : String(error)),
        hint: '图片可能超过宿主的尺寸/字节上限；在设置里调小摄像头分辨率后重试',
      },
    }
  }
  return {
    ok: true,
    provider: 'dsh',
    path: fromCapture ? 'input://capture/' + fromCapture.captureId : 'input://camera/current',
    question,
    source: fromCapture ? { kind: 'capture', label: fromCapture.label, captureId: fromCapture.captureId } : { kind: 'device' },
    image: {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType || parsed.mediaType),
      bytes: Number(ref.bytes) || parsed.data.length,
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
    },
    note: '（vision.provider=dsh：画面已作为图片附在本次工具结果里，由你自己看）',
  }
}

/** `render`：带图片的值渲染成 [说明文字, image 块]；其余情况退回 JSON 文本。 */
function renderLook(value) {
  const image = value && value.image
  if (image && typeof image.attachmentId === 'string' && image.attachmentId !== '') {
    const lines = [
      '<source>mira_device / 输入侧摄像头，当前一帧</source>',
    ]
    if (value.question) lines.push('<question>' + value.question + '</question>')
    lines.push('<type>image</type>')
    lines.push('<content>' + image.mediaType + ' image, ' + image.width + 'x' + image.height + ' px, ' + image.bytes + ' bytes</content>')
    lines.push('（这是刚刚抓到的画面，按你真正看到的回答；看不见的细节不要编。）')
    return [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', attachment: image },
    ]
  }
  return [{ type: 'text', text: JSON.stringify(value ?? {}, null, 2) }]
}

/** `data:image/jpeg;base64,...` → { mediaType, data }（不是 data URL 返回 null）。 */
function parseDataUrl(dataUrl) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''))
  if (!match) return null
  return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], 'base64') }
}

/**
 * 取当前会话 id：`agent.session.id` 才是权威（Agent.id 与 Session.id 不同源）。
 * 拿不到就返回空串 —— 不猜、不借「最后一个会话」。
 */
function sessionIdOf(exec) {
  const agent = exec && exec.agent
  const id = agent && agent.session && agent.session.id ? String(agent.session.id) : ''
  return id
}

/** device_status 的返回体（只读、可自证）。 */
export function statusView(deps) {
  const status = deps.configStore.status()
  let cfg = null
  try {
    cfg = deps.configStore.current()
  } catch { /* 已经记在 status.error 里 */ }
  const stateView = deps.stateStore.status()
  let mediaStatus = null
  try {
    const audio = deps.audio()
    if (audio && typeof audio.status === 'function') mediaStatus = audio.status()
  } catch { /* mira_media 不可用：下面如实标出来 */ }
  let vad = null
  try {
    const audio = deps.audio()
    if (audio && typeof audio.vad === 'function') vad = audio.vad()
  } catch { /* 同上 */ }
  return {
    ok: true,
    plugin: 'mira_device',
    configFile: status.file,
    stateFile: stateView.file,
    configError: status.error,
    configWarnings: status.warnings,
    seededFrom: status.seededFrom || '',
    stateError: stateView.error,
    state: stateView.state,
    // 断句阈值属于 mira_media：这里只转述，改了要在「设置 · 声音」里改
    vad,
    audio: mediaStatus
      ? { configured: mediaStatus.configured, tts: mediaStatus.tts, asr: mediaStatus.asr, credsFile: mediaStatus.credsFile }
      : { available: false, error: 'mira_media 没加载（ASR/识图/断句都用不了）' },
    vision: {
      enabled: cfg ? cfg.vision.enabled === true : null,
      provider: cfg ? cfg.vision.provider : null,
      autoIntervalMs: cfg ? cfg.vision.autoIntervalMs : 0,
      attachmentsReady: !!(deps.attachments && typeof deps.attachments.saveImage === 'function'),
      // 自动推帧那条路不经过模型，所以即使 provider=dsh 也仍然需要阿里云 key
      autoNeedsCreds: !!(cfg && cfg.vision.autoIntervalMs > 0 && mediaStatus && mediaStatus.configured !== true),
    },
    player: { clients: deps.hub.clientCount },
    security: deps.authorizer ? deps.authorizer.describe('') : null,
    capture: deps.captureHub ? deps.captureHub.status() : null,
    events: {
      enabled: cfg ? cfg.events.enabled === true : null,
      steer: cfg ? cfg.events.steer === true : null,
      clients: deps.hub.clientCount,
      lastPercept: deps.hub.status().lastPercept,
      pending: deps.hub.status().pending,
    },
    endpoints: {
      api: '/device/api/',
      events: '/device/api/events',
      stream: '/device/api/stream.mjpg',
      say: '/device/api/say',
      audio: '/device/api/audio/',
    },
    counters: deps.counters ? deps.counters.snapshot() : {},
  }
}
