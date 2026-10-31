/**
 * mira_device — 客户端模块（浏览器侧）
 *
 * 两个注册点：
 *   1) `conversation.input.right` → 输入框里「模型选择」与「发送」之间的两个按钮（摄像头 / 麦克风）。
 *      这里同时是**采集中枢**：getUserMedia、本地 VAD 断句、波形电平、抓帧、按需录音都在这个
 *      模块级单例里，跨页签保持（切到「形象」页签不会重新申请权限、也不会掉流）。
 *   2) `settings.section` → 设置页「输入」：设备、采集器、自动推帧与事件流（key 在「声音」里）。
 *
 * 对别的插件的契约（页面全局对象，README §4）：
 *   window.__miraDevice__ = {
 *     version, ready(), state(), subscribe(fn),
 *     setCamera(on), setMic(on), setSource(kind, source),
 *     videoStream(), analyser(), level(), frame(quality),
 *     heard(), seen(), subscribeLog(fn), captureUrl(),
 *   }
 * 为什么要这个全局对象：插件各自独立打包，`require()` 拿不到别人的模块；而「形象」页签要显示
 * 这里采集到的画面/波形，还要读"最近听到/看到"的记录 —— 页面全局是唯一稳定的交接点。
 *
 * 事实源：识别、断句阈值、合成都在宿主（`/device/api/*` + miraMedia 服务），浏览器只做采集。
 */

function miraDeviceClient(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/device/api'
    const REGISTRY_VERSION = 1

    /* ══════════════════════════════════════════════════════════
     * 0. 小工具
     * ══════════════════════════════════════════════════════════ */

    function errorText(error, status) {
      if (!error) return '请求失败（HTTP ' + status + '）'
      const code = error.code ? '[' + error.code + '] ' : ''
      const hint = error.hint ? '；' + error.hint : ''
      return code + (error.message || '未知错误') + hint
    }

    async function postJson(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json || json.ok !== true) {
        throw new Error(errorText(json && json.error, response.status))
      }
      return json
    }

    async function getJson(path) {
      const response = await fetch(API + path, { headers: { accept: 'application/json' } })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json || json.ok !== true) {
        throw new Error(errorText(json && json.error, response.status))
      }
      return json
    }

    /* ══════════════════════════════════════════════════════════
     * 1. 共享状态（模块级单例：按钮、设置页、别的插件都读它）
     * ══════════════════════════════════════════════════════════ */

    const store = {
      ready: false,
      bootError: null,
      cameraOn: false,
      micOn: false,
      // 来源：device（本机设备）| galaxy（外部采集器）| none
      cameraSource: 'device',
      micSource: 'device',
      // 麦克风"正在一句里"（VAD 判到有人说话）
      listening: false,
      // 外部采集器推来的 PCM 电平（0..1），面板波形用它
      captureLevel: 0,
      // 本机麦克风的实时 RMS（0..1）
      micLevel: 0,
      vad: null,
      config: null,
      features: { asr: null, vision: null },
      sessionId: '',
      clientId: '',
      // 最近识别到的语音 / 画面
      heard: [], // [{ text, at, steered, reason }]
      seen: [],
      notice: null, // { kind:'info'|'error'|'success', text }
    }

    const listeners = new Set()
    function emit(patch) {
      if (patch) Object.assign(store, patch)
      for (const fn of [...listeners]) {
        try {
          fn()
        } catch (error) {
          console.error('[mira_device] listener 出错', error)
        }
      }
      publishLogs()
    }

    function notice(kind, text) {
      emit({ notice: text ? { kind, text } : null })
      if (kind === 'error') console.warn('[mira_device] ' + text)
    }

    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      }, [])
      return store
    }

    /** 给别的插件看的一份状态快照（不含 DOM 对象）。 */
    function publicState() {
      return {
        ready: store.ready,
        bootError: store.bootError,
        cameraOn: store.cameraOn,
        micOn: store.micOn,
        cameraSource: store.cameraSource,
        micSource: store.micSource,
        listening: store.listening,
        level: store.captureLevel || store.micLevel || 0,
        vad: store.vad,
        features: store.features,
        notice: store.notice,
      }
    }

    const logListeners = new Set()
    function publishLogs() {
      const payload = { heard: store.heard.slice(), seen: store.seen.slice() }
      for (const fn of [...logListeners]) {
        try {
          fn(payload)
        } catch (error) {
          console.error('[mira_device] 日志订阅者出错', error)
        }
      }
    }

    /* ══════════════════════════════════════════════════════════
     * 2. 采集：摄像头 / 麦克风（模块级单例，跨页签保持）
     * ══════════════════════════════════════════════════════════ */

    /** Float32（-1..1）→ 16bit 单声道 WAV（阿里云识别吃 wav 最稳）。 */
    function encodeWav(float32, sampleRate) {
      const length = float32.length
      const buffer = new ArrayBuffer(44 + length * 2)
      const view = new DataView(buffer)
      const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
      }
      writeString(0, 'RIFF')
      view.setUint32(4, 36 + length * 2, true)
      writeString(8, 'WAVE')
      writeString(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true) // PCM
      view.setUint16(22, 1, true) // 单声道
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeString(36, 'data')
      view.setUint32(40, length * 2, true)
      let offset = 44
      for (let i = 0; i < length; i++) {
        const sample = Math.max(-1, Math.min(1, float32[i]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Uint8Array(buffer)
    }

    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return window.btoa(binary)
    }

    /** 线性降到目标采样率（浏览器不一定按我们请求的 sampleRate 建 AudioContext）。 */
    function resample(input, from, to) {
      if (from === to || input.length === 0) return input
      const ratio = from / to
      const length = Math.max(1, Math.round(input.length / ratio))
      const out = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const pos = i * ratio
        const left = Math.floor(pos)
        const right = Math.min(input.length - 1, left + 1)
        const frac = pos - left
        out[i] = (input[left] || 0) * (1 - frac) + (input[right] || 0) * frac
      }
      return out
    }

    class Capture {
      constructor() {
        this.videoStream = null
        this.audioStream = null
        this.audioCtx = null
        this.sourceNode = null
        this.analyser = null
        this.processor = null
        this.levelBuf = null
        this.level = 0
        this.utterance = [] // 当前这句的 Float32 片段
        this.ring = [] // 预录（避免吞字）
        this.inSpeech = false
        this.silenceSince = 0
        this.startedAt = 0
        this.mode = 'idle' // idle | auto | manual
        this.manual = null
        this.lastError = null
        this.listening = false
      }

      get cameraLive() {
        return !!this.videoStream
      }

      get micLive() {
        return !!this.audioStream
      }

      /* ── 摄像头 ── */
      async startCamera(cfg) {
        if (this.videoStream) return this.videoStream
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('这个浏览器不支持 getUserMedia（需要 https 或 localhost）')
        }
        const video = {}
        if (cfg && cfg.width) video.width = { ideal: cfg.width }
        if (cfg && cfg.height) video.height = { ideal: cfg.height }
        if (cfg && cfg.deviceId) video.deviceId = { exact: cfg.deviceId }
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
        this.videoStream = stream
        this.attachFrameVideo()
        this.emit()
        return stream
      }

      stopCamera() {
        if (!this.videoStream) return
        for (const track of this.videoStream.getTracks()) {
          try {
            track.stop()
          } catch { /* 忽略 */ }
        }
        this.videoStream = null
        if (this.frameVideo) {
          try {
            this.frameVideo.srcObject = null
          } catch { /* 忽略 */ }
        }
        this.emit()
      }

      /**
       * 抓帧用的 `<video>`：**不依赖页面上那个预览元素**。
       * 「形象」页签的预览元素只在那一页存在；用户在「对话」页里开着摄像头时，
       * 自动推帧 / device_look 也照样要能抓到画面，所以这里自己维护一个隐藏的 video。
       */
      attachFrameVideo() {
        if (!this.frameVideo) {
          const video = document.createElement('video')
          video.muted = true
          video.playsInline = true
          video.setAttribute('playsinline', '')
          video.autoplay = true
          this.frameVideo = video
        }
        if (this.videoStream && this.frameVideo.srcObject !== this.videoStream) {
          this.frameVideo.srcObject = this.videoStream
          const played = this.frameVideo.play?.()
          if (played && typeof played.catch === 'function') played.catch(() => {})
        }
        return this.frameVideo
      }

      /** 当前一帧 → data:image/jpeg；没有可用画面返回空串。 */
      frameImage(quality = 0.72) {
        if (!this.videoStream) return ''
        const video = this.attachFrameVideo()
        if (!video.videoWidth) return ''
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return ''
        ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', quality)
      }

      /* ── 麦克风 ── */
      async startMic(cfg) {
        if (this.audioStream) return this.audioStream
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('这个浏览器不支持 getUserMedia（需要 https 或 localhost）')
        }
        // deviceId 与摄像头同口径：留空 = 默认设备；填了就精确匹配（填错会 NotFoundError）
        const deviceId = String((cfg && cfg.deviceId) || '').trim()
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId !== '' ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        this.audioStream = stream
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) throw new Error('这个浏览器没有 Web Audio')
        const target = Math.max(8000, Math.min(48000, Number(cfg && cfg.sampleRate) || 16000))
        this.targetRate = target
        try {
          this.audioCtx = new AC({ sampleRate: target })
        } catch {
          this.audioCtx = new AC()
        }
        if (this.audioCtx.state === 'suspended') {
          try {
            await this.audioCtx.resume()
          } catch { /* 用户还没点过页面，等一次手势 */ }
        }
        this.sourceNode = this.audioCtx.createMediaStreamSource(stream)
        this.analyser = this.audioCtx.createAnalyser()
        this.analyser.fftSize = 1024
        this.analyser.smoothingTimeConstant = 0.4
        this.sourceNode.connect(this.analyser)
        this.levelBuf = new Uint8Array(this.analyser.fftSize)

        // ScriptProcessor 取 PCM：只用来 VAD/编码 WAV（display 走 analyser，两者互不影响）
        const bufferSize = 2048
        this.processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1)
        this.processor.onaudioprocess = (event) => this.onAudio(event)
        this.sourceNode.connect(this.processor)
        // 必须接到 destination 才会被驱动（静音连接，不产生回声：输出零）
        const mute = this.audioCtx.createGain()
        mute.gain.value = 0
        this.processor.connect(mute)
        mute.connect(this.audioCtx.destination)

        // 断句阈值来自 mira_media（bootstrap 里的 vad），这里只照着用
        this.vad = (cfg && cfg.vad) || (store.vad || {})
        this.mode = 'auto'
        this.startedAt = Date.now()
        this.emit()
        return stream
      }

      stopMic() {
        if (this.processor) {
          try {
            this.processor.disconnect()
          } catch { /* 忽略 */ }
          this.processor.onaudioprocess = null
          this.processor = null
        }
        if (this.sourceNode) {
          try {
            this.sourceNode.disconnect()
          } catch { /* 忽略 */ }
          this.sourceNode = null
        }
        if (this.audioStream) {
          for (const track of this.audioStream.getTracks()) {
            try {
              track.stop()
            } catch { /* 忽略 */ }
          }
        }
        this.audioStream = null
        this.analyser = null
        this.utterance = []
        this.ring = []
        this.inSpeech = false
        this.level = 0
        this.mode = 'idle'
        this.manual = null
        this.listening = false
        this.emit()
      }

      emit() {
        emit({
          cameraOn: this.cameraLive,
          micOn: this.micLive,
          micLevel: this.level || 0,
          listening: this.listening === true,
        })
      }

      /** 录一段固定时长（宿主 device_listen 用）。 */
      recordFor(seconds) {
        if (!this.micLive) return Promise.reject(new Error('麦克风没打开'))
        return new Promise((resolve) => {
          const chunks = []
          this.manual = {
            until: Date.now() + Math.max(1, seconds) * 1000,
            chunks,
            resolve,
          }
          this.mode = 'manual'
          this.listening = true
          emit({ listening: true })
        })
      }

      onAudio(event) {
        const input = event.inputBuffer.getChannelData(0)
        const copy = new Float32Array(input.length)
        copy.set(input)

        // 电平（VAD 用 + 面板波形用）
        let sum = 0
        for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i]
        const rms = Math.sqrt(sum / copy.length)
        this.level = rms
        if (this.mode === 'idle') return

        if (this.mode === 'manual' && this.manual) {
          this.manual.chunks.push(copy)
          if (Date.now() >= this.manual.until) {
            const merged = concat(this.manual.chunks)
            const seconds = merged.length / this.audioCtx.sampleRate
            const payload = this.pack(merged, seconds)
            const resolve = this.manual.resolve
            this.manual = null
            this.mode = 'auto'
            this.listening = false
            emit({ listening: false })
            resolve(payload)
          }
          return
        }

        if (this.mode !== 'auto') return
        const quiet = Number(this.vad.silenceMs) || 650
        const threshold = Number(this.vad.threshold) || 0.02
        const minSpeech = Number(this.vad.minSpeechMs) || 320
        const maxMs = Number(this.vad.maxMs) || 15000

        // 预录环：保留最近 ~300ms（不吞首字）
        this.ring.push(copy)
        const ringMax = Math.max(2, Math.round(0.3 * this.audioCtx.sampleRate / copy.length))
        while (this.ring.length > ringMax) this.ring.shift()

        if (rms > threshold) {
          if (!this.inSpeech) {
            this.inSpeech = true
            this.utterance = this.ring.slice()
            this.silenceSince = 0
            this.listening = true
            emit({ listening: true })
          } else {
            this.silenceSince = 0
          }
          this.utterance.push(copy)
          return
        }

        if (!this.inSpeech) {
          // 静音时也把电平推给界面（波形要能画一条安静的线）
          emit({ micLevel: this.level })
          return
        }
        this.utterance.push(copy)
        if (!this.silenceSince) this.silenceSince = Date.now()
        const speechMs = this.utterance.length * copy.length / this.audioCtx.sampleRate * 1000
        const silentFor = Date.now() - this.silenceSince
        if (silentFor >= quiet || speechMs >= maxMs) {
          const merged = concat(this.utterance)
          this.utterance = []
          this.inSpeech = false
          this.silenceSince = 0
          this.listening = false
          emit({ listening: false })
          if (speechMs < minSpeech) return
          const payload = this.pack(merged, speechMs / 1000)
          void onUtterance(payload)
        }
      }

      /** Float32（设备采样率）→ 目标采样率的 WAV。 */
      pack(float32, seconds) {
        const from = this.audioCtx ? this.audioCtx.sampleRate : this.targetRate
        const to = this.targetRate || from
        const data = resample(float32, from, to)
        const wav = encodeWav(data, to)
        return {
          base64: toBase64(wav),
          mime: 'audio/wav',
          sampleRate: to,
          durationMs: Math.round((seconds || data.length / to) * 1000),
          peak: this.peakOf(float32),
          bytes: wav.length,
        }
      }

      peakOf(float32) {
        let peak = 0
        for (let i = 0; i < float32.length; i += 8) {
          const value = Math.abs(float32[i])
          if (value > peak) peak = value
        }
        return peak
      }
    }

    function concat(chunks) {
      let total = 0
      for (const chunk of chunks) total += chunk.length
      const out = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    }

    const capture = new Capture()

    /** 一段话识别完：交给宿主（它会识别 + 按配置可能直接 steer）。 */
    async function onUtterance(payload) {
      try {
        const result = await postJson('/asr', {
          base64: payload.base64,
          mime: payload.mime,
          sessionId: store.sessionId || '',
          auto: true,
          durationMs: payload.durationMs,
          // 原生识别口要用它填 parameters.sample_rate（浏览器按 mic.sampleRate 录的）
          sampleRate: payload.sampleRate || (store.config && store.config.mic ? store.config.mic.sampleRate : 0),
        })
        const text = String(result.text || '').trim()
        if (text === '') {
          emit({ heard: [{ text: '（没听清）', at: new Date().toISOString(), steered: false }, ...store.heard].slice(0, 5) })
          return
        }
        emit({
          heard: [{
            text,
            at: new Date().toISOString(),
            steered: result.steered === true,
            reason: result.steer && result.steer.reason ? result.steer.reason : '',
          }, ...store.heard].slice(0, 5),
        })
      } catch (error) {
        notice('error', '语音识别失败：' + (error && error.message ? error.message : error))
      }
    }

    /* ══════════════════════════════════════════════════════════
     * 3. SSE：宿主 → 浏览器
     * ══════════════════════════════════════════════════════════ */

    let stream = null
    let streamWarned = false

    function ensureStream() {
      if (stream || typeof window.EventSource !== 'function') return stream
      stream = new window.EventSource(API + '/events')
      stream.addEventListener('message', (event) => {
        let frame
        try {
          frame = JSON.parse(event.data)
        } catch {
          return
        }
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'say') {
          playerEmit({ text: String(frame.text || ''), url: String(frame.url || '') })
          if (frame.url) void playUrl(String(frame.url))
          return
        }
        if (frame.type === 'hello') {
          if (typeof frame.clientId === 'string') emit({ clientId: frame.clientId })
          return
        }
        if (frame.type === 'state' && frame.state) {
          applyHostState(frame.state, frame.by)
        } else if (frame.type === 'capture/level') {
          const level = Number(frame.level)
          emit({ captureLevel: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0 })
        } else if (frame.type === 'capture/heard') {
          const text = String(frame.text || '').trim()
          if (text !== '') {
            emit({
              heard: [{
                text,
                at: new Date().toISOString(),
                steered: frame.steered === true,
                reason: frame.reason ? String(frame.reason) : '',
              }, ...store.heard].slice(0, 5),
            })
          }
        } else if (frame.type === 'capture/seen') {
          const text = String(frame.text || '').trim()
          if (text !== '') {
            emit({
              seen: [{
                text,
                at: new Date().toISOString(),
                steered: frame.steered === true,
                reason: frame.reason ? String(frame.reason) : '',
              }, ...store.seen].slice(0, 5),
            })
          }
        } else if (frame.type === 'command') {
          void handleCommand(frame)
        }
      })
      stream.addEventListener('error', () => {
        // EventSource 自己会重连；这里只提醒一次，别刷屏
        if (!streamWarned) {
          streamWarned = true
          notice('info', '与宿主的事件流断开，浏览器会自动重连…')
        }
      })
      stream.addEventListener('open', () => {
        streamWarned = false
      })
      return stream
    }

    /**
     * 应用宿主广播的状态。
     *
     * 多设备的关键点：`cameraOn/micOn` 是**会话级意图**，但摄像头/麦克风是**每台设备的本地硬件**。
     * 所以只有「自己改的」或「工具改的」才去真正开关本机硬件；别的设备改了，这里只同步开关外观，
     * 不会顺手把本机摄像头也打开（否则两台设备互相抢同一颗摄像头，还会互相报错）。
     */
    function applyHostState(state, by) {
      const patch = {}
      if (typeof state.cameraOn === 'boolean') patch.cameraOn = state.cameraOn
      if (typeof state.micOn === 'boolean') patch.micOn = state.micOn
      if (typeof state.cameraSource === 'string') patch.cameraSource = state.cameraSource
      if (typeof state.micSource === 'string') patch.micSource = state.micSource
      emit(patch)
      const mine = 'client:' + (store.clientId || '')
      const fromOtherDevice = typeof by === 'string' && by.startsWith('client:') && by !== mine
      if (!fromOtherDevice) void reconcileCapture()
    }

    /** 让硬件跟状态一致（按钮与工具都能改状态，渲染以状态为准）。 */
    async function reconcileCapture() {
      // 采集器源：画面/声音由 muse_galaxy 等推进来，本机不需要 getUserMedia
      const cameraExternal = String(store.cameraSource || 'device') === 'galaxy'
      const micExternal = String(store.micSource || 'device') === 'galaxy'
      try {
        if (cameraExternal) {
          if (capture.cameraLive) capture.stopCamera()
        } else if (store.cameraOn && !capture.cameraLive) {
          await capture.startCamera(store.config?.camera)
        }
        if (!store.cameraOn && capture.cameraLive) capture.stopCamera()
      } catch (error) {
        // 没有摄像头不是"故障"，是这台机器没有：提示一次并把来源切成「不用」，别每次重渲染都再试
        if (isMissingDevice(error)) {
          notice('info', '这台设备没有可用的摄像头：已把摄像头来源切成「不用」（外部采集器不受影响）')
          emit({ cameraOn: false, cameraSource: 'none' })
          void postJson('/state', { cameraOn: false, cameraSource: 'none', clientId: store.clientId || '' })
            .catch(() => { /* 宿主不在就算了，界面已经回退 */ })
        } else {
          notice('error', '摄像头：' + explainMediaError(error, 'camera'))
          emit({ cameraOn: false })
        }
      }
      try {
        if (micExternal) {
          if (capture.micLive) capture.stopMic()
        } else if (store.micOn && !capture.micLive) {
          await capture.startMic({ ...(store.config?.mic || {}), vad: store.vad || undefined })
        }
        if (!store.micOn && capture.micLive) capture.stopMic()
      } catch (error) {
        if (isMissingDevice(error)) {
          notice('info', '这台设备没有可用的麦克风：已把麦克风来源切成「不用」（外部采集器不受影响）')
          emit({ micOn: false, micSource: 'none' })
          void postJson('/state', { micOn: false, micSource: 'none', clientId: store.clientId || '' })
            .catch(() => { /* 同上 */ })
        } else {
          notice('error', '麦克风：' + explainMediaError(error, 'mic'))
          emit({ micOn: false })
        }
      }
    }

    /** 宿主发来的 command：look（抓帧）/ listen（录一段）。 */
    async function handleCommand(frame) {
      const requestId = frame.requestId
      const payload = frame.payload || {}
      try {
        if (frame.kind === 'look') {
          // 抓帧走 Capture 自己的隐藏 video，不依赖「形象」页签是否在前台
          const image = capture.frameImage()
          if (!image) throw new Error('摄像头没有画面（未打开或还没出帧）')
          await postJson('/result', { requestId, ok: true, value: { image } })
          return
        }
        if (frame.kind === 'listen') {
          const seconds = Math.max(1, Math.min(30, Number(payload.seconds) || 5))
          const clip = await capture.recordFor(seconds)
          await postJson('/result', {
            requestId,
            ok: true,
            value: { base64: clip.base64, mime: clip.mime, durationMs: clip.durationMs, sampleRate: clip.sampleRate },
          })
          return
        }
        await postJson('/result', {
          requestId,
          ok: false,
          error: { code: 'command/unsupported', message: '客户端不认识这个指令：' + frame.kind, hint: '升级插件版本' },
        })
      } catch (error) {
        try {
          await postJson('/result', {
            requestId,
            ok: false,
            error: { code: 'delivery/failed', message: error && error.message ? error.message : String(error), hint: '' },
          })
        } catch { /* 宿主可能已经超时 */ }
      }
    }

    /* ══════════════════════════════════════════════════════════
     * 4. 启动：bootstrap + 事件流 + 自动推帧
     * ══════════════════════════════════════════════════════════ */

    let bootPromise = null
    function bootstrap() {
      if (bootPromise) return bootPromise
      bootPromise = (async () => {
        try {
          const boot = await getJson('/bootstrap')
          const state = boot.state || {}
          emit({
            ready: true,
            bootError: null,
            config: boot.config,
            vad: boot.vad || null,
            features: {
              asr: boot.features ? boot.features.asr : null,
              vision: boot.features ? boot.features.vision : null,
              configured: boot.features ? boot.features.configured : false,
            },
            cameraOn: state.cameraOn === true,
            micOn: state.micOn === true,
            cameraSource: state.cameraSource || 'device',
            micSource: state.micSource || 'device',
          })
          if (boot.features && boot.features.configured !== true) {
            notice('info', '还没配置阿里云 API key：语音识别 / 自动识图会报 creds/missing。到「设置 · 声音」里填。')
          }
          ensureStream()
          await reconcileCapture()
        } catch (error) {
          emit({ ready: true, bootError: error && error.message ? error.message : String(error) })
          notice('error', '输入接口读不到：' + (error && error.message ? error.message : error))
        }
      })()
      return bootPromise
    }

    function ensureBoot() {
      if (bootPromise) return bootPromise
      const promise = bootstrap()
      return promise.then(() => {
        startAutoVision()
        return promise
      })
    }

    let autoVisionTimer = null
    let autoVisionAt = 0
    /**
     * 自动推帧调度：每轮**重新读**配置里的 `vision.autoIntervalMs`，所以设置页改完
     * （哪怕改成 0 = 关）不用刷新页面，下一轮就按新值走。默认 0 = 关。
     * 只负责**本机设备**源；采集器源由宿主侧驱动（帧就在宿主内存里）。
     */
    function startAutoVision() {
      if (autoVisionTimer) return
      const loop = () => {
        const vision = (store.config && store.config.vision) || {}
        const interval = Number(vision.autoIntervalMs) || 0
        // 关着的时候慢速轮询，只为发现「设置页把它打开了」
        const wait = interval > 0 ? Math.max(1500, interval) : 5000
        autoVisionTimer = window.setTimeout(async () => {
          if (interval > 0 && capture.cameraLive && store.sessionId) {
            try {
              await autoVisionTick(interval)
            } catch { /* 单次失败不打断调度 */ }
          }
          loop()
        }, wait)
      }
      loop()
    }

    async function autoVisionTick(interval) {
      // 采集器源时由宿主侧驱动识图，浏览器别再抢着抓一次
      if (String(store.cameraSource || 'device') === 'galaxy') return
      if (store.features && store.features.vision && store.features.vision.enabled === false) return
      if (Date.now() - autoVisionAt < interval) return
      // 用隐藏 video 抓帧，页签在不在「形象」都能抓
      const image = capture.frameImage()
      if (!image) return
      autoVisionAt = Date.now()
      try {
        const result = await postJson('/vision', { image, sessionId: store.sessionId, auto: true })
        const text = String(result.text || '').trim()
        if (text === '') return
        emit({
          seen: [{
            text,
            at: new Date().toISOString(),
            steered: result.steered === true,
            reason: result.steer && result.steer.reason ? result.steer.reason : '',
          }, ...store.seen].slice(0, 5),
        })
      } catch (error) {
        notice('error', '图像识别失败：' + (error && error.message ? error.message : error))
      }
    }

    /**
     * 「这台机器没有这个设备」——与权限被拒/被占用不同：不是故障，该提示一次就停手
     * （否则每次重渲染再调一次 getUserMedia，控制台和界面都会被同一条错误刷满）。
     */
    function isMissingDevice(error) {
      const name = error && error.name ? String(error.name) : ''
      const raw = error && error.message ? String(error.message) : String(error)
      return name === 'NotFoundError' || name === 'DevicesNotFoundError'
        || /Requested device not found/i.test(raw)
        || /no (audio|video) (input|source)/i.test(raw)
    }

    /** 把 getUserMedia 的 DOMException 翻成人话（不同名称对应完全不同的处置）。 */
    function explainMediaError(error, kind) {
      const name = error && error.name ? String(error.name) : ''
      const raw = error && error.message ? String(error.message) : String(error)
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || /Requested device not found/i.test(raw)) {
        return (kind === 'camera' ? '这台设备没有可用的摄像头' : '这台设备没有可用的麦克风')
          + '（插上设备后在设置里重新打开即可）'
      }
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return (kind === 'camera' ? '摄像头' : '麦克风') + '权限被拒绝：在浏览器地址栏的权限图标里允许一次'
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        return (kind === 'camera' ? '摄像头' : '麦克风') + '被别的程序占用（会议/直播软件常见）：关掉那个程序再试'
      }
      if (name === 'OverconstrainedError') {
        return '设置里的设备参数不被支持：把「设备 deviceId / 分辨率」清空后重试'
      }
      return (kind === 'camera' ? '摄像头' : '麦克风') + '打开失败：' + raw
    }

    /* ══════════════════════════════════════════════════════════
     * 5. 样式（只吃主题变量）
     * ══════════════════════════════════════════════════════════ */

    const CSS = [
      '.mi-btn{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:4px;width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm, 8px);border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary, inherit);cursor:pointer;}',
      '.mi-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18));color:var(--dsw-alias-label-primary, inherit);}',
      '.mi-btn[data-on="1"]{color:var(--dsw-alias-state-success-primary, #2a2);background:var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.26));border-color:var(--dsw-alias-border-l2, currentColor);}',
      '.mi-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color, currentColor);outline-offset:1px;}',
      '.mi-btn svg{width:16px;height:16px;display:block;}',
      '.mi-set{display:flex;flex-direction:column;gap:16px;font:inherit;color:inherit;max-width:760px;}',
      '.mi-set-title{margin:0;font-size:16px;font-weight:600;}',
      '.mi-set-sub{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.mi-set-group{margin:0;padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2, currentColor);border-radius:var(--dsw-radius-md, 8px);min-width:0;}',
      '.mi-set-legend{padding:0 4px;margin:0 0 2px;font-size:13px;font-weight:600;}',
      '.mi-set-row{display:grid;grid-template-columns:132px minmax(0, 1fr);gap:6px 12px;align-items:start;font-size:13px;min-width:0;}',
      '.mi-set-mid{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.mi-set-label{padding-top:6px;font-size:13px;}',
      '.mi-set-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary, inherit);}',
      '.mi-set-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;padding:5px 8px;border-radius:var(--dsw-radius-sm, 6px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:inherit;}',
      '.mi-set-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding-top:5px;}',
      '.mi-set-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;}',
      '.mi-set-button{font:inherit;font-size:13px;padding:6px 16px;border-radius:var(--dsw-radius-md, 8px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:inherit;cursor:pointer;}',
      '.mi-set-button:disabled{opacity:.55;cursor:default;}',
      '.mi-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.mi-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary, #d25);}',
      '.mi-notice[data-kind="success"]{color:var(--dsw-alias-state-success-primary, #2a2);}',
      '.mi-err{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary, #d25);word-break:break-word;}',
    ].join('\n')

    /* ══════════════════════════════════════════════════════════
     * 6. 输入框按钮：摄像头 / 麦克风
     * ══════════════════════════════════════════════════════════ */

    function CameraIcon(props) {
      // 显式给 width/height：输入框里的按钮天然拿不到别处那份 <style>，
      // 只靠 CSS 定尺寸时会被浏览器画成默认尺寸的空框（用户看到的就是两个空框框）。
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...props,
      },
      h('rect', { x: 2.5, y: 6.5, width: 13, height: 11, rx: 2.5 }),
      h('path', { d: 'M15.5 10.5l6-3v9l-6-3z' }))
    }

    function MicIcon(props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...props,
      },
      h('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
      h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5' }))
    }

    function CameraButton() {
      const state = useStore()
      const busy = React.useRef(false)
      // 采集器源（muse_galaxy 等）：这个按钮只切"要不要接收那路流"，不去碰本机摄像头
      const external = String(state.cameraSource || 'device') === 'galaxy'
      const toggle = async () => {
        if (busy.current) return
        busy.current = true
        const next = !state.cameraOn
        try {
          if (!external) {
            if (next) await capture.startCamera(store.config?.camera)
            else capture.stopCamera()
          }
          emit({ cameraOn: next })
          await postJson('/state', { cameraOn: next, clientId: store.clientId || '' })
        } catch (error) {
          // 失败**只**回退开关，不碰别的东西（形象页签的舞台不归这里管）
          notice('error', '摄像头：' + explainMediaError(error, 'camera'))
          emit({ cameraOn: capture.cameraLive })
        } finally {
          busy.current = false
        }
      }
      const label = external ? (state.cameraOn ? '停止接收外部采集' : '接收外部采集') : (state.cameraOn ? '关闭摄像头' : '打开摄像头')
      return h('button', {
        type: 'button',
        className: 'mi-btn',
        'data-on': state.cameraOn ? '1' : '0',
        title: label,
        'aria-label': label,
        'aria-pressed': state.cameraOn,
        onClick: () => { void toggle() },
      }, h(CameraIcon))
    }

    function MicButton() {
      const state = useStore()
      const busy = React.useRef(false)
      // 采集器源：只切"要不要接收那路音频"，不碰本机麦克风（断句在宿主侧按 vad 做）
      const external = String(state.micSource || 'device') === 'galaxy'
      const toggle = async () => {
        if (busy.current) return
        busy.current = true
        const next = !state.micOn
        try {
          if (!external) {
            if (next) await capture.startMic({ ...(store.config?.mic || {}), vad: store.vad || undefined })
            else capture.stopMic()
          }
          emit({ micOn: next })
          await postJson('/state', { micOn: next, clientId: store.clientId || '' })
        } catch (error) {
          notice('error', '麦克风：' + explainMediaError(error, 'mic'))
          emit({ micOn: capture.micLive })
        } finally {
          busy.current = false
        }
      }
      const label = external ? (state.micOn ? '停止接收外部音频' : '接收外部音频') : (state.micOn ? '关闭麦克风' : '打开麦克风')
      return h('button', {
        type: 'button',
        className: 'mi-btn',
        'data-on': state.micOn ? '1' : '0',
        title: label,
        'aria-label': label,
        'aria-pressed': state.micOn,
        onClick: () => { void toggle() },
      }, h(MicIcon))
    }

    /** 输入框右侧的两个按钮（该槽位渲染在模型选择之后、提交按钮之前）。 */
    function DeviceButtons(props) {
      const state = useStore()
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      React.useEffect(() => {
        void ensureBoot()
      }, [])
      React.useEffect(() => {
        if (sessionId) emit({ sessionId })
      }, [sessionId])
      if (!state.ready) return h('span', { style: { display: 'none' } })
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '2px' },
          'data-mira-input': 'device-buttons',
        }, [h(CameraButton, { key: 'camera' }), h(MicButton, { key: 'mic' })]))
    }

    /* ══════════════════════════════════════════════════════════
     * 7. 设置页「输入」
     * ══════════════════════════════════════════════════════════ */

    function toDraft(raw) {
      const v = raw && typeof raw === 'object' ? raw : {}
      const group = (name, keys) => {
        const source = v[name] && typeof v[name] === 'object' ? v[name] : {}
        const out = {}
        for (const key of keys) out[key] = source[key]
        return out
      }
      return {
        camera: group('camera', ['enabled', 'deviceId', 'width', 'height']),
        mic: group('mic', ['enabled', 'deviceId', 'sampleRate']),
        capture: group('capture', ['enabled', 'fps', 'width', 'audio', 'autoSwitch', 'staleMs', 'lostMs']),
        vision: group('vision', ['autoIntervalMs']),
        events: group('events', ['enabled', 'steer', 'minIntervalMs', 'maxPerMin', 'cooldownKeyMs', 'voiceTemplate', 'visionTemplate']),
      }
    }

    function SettingsSection() {
      const [values, setValues] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [keyConfigured, setKeyConfigured] = React.useState(false)
      const [files, setFiles] = React.useState({ configFile: '', credsFile: '', seededFrom: '' })
      const [runtime, setRuntime] = React.useState(null)
      const [warnings, setWarnings] = React.useState([])
      const [notice, setNotice] = React.useState({ kind: 'loading', text: '正在读取输入配置…' })
      const [saving, setSaving] = React.useState(false)

      function readBack(json) {
        setValues(toDraft(json.values))
        setBaseline(toDraft(json.values))
        setKeyConfigured(json.keyConfigured === true)
        setFiles({
          configFile: typeof json.configFile === 'string' ? json.configFile : '',
          credsFile: typeof json.credsFile === 'string' ? json.credsFile : '',
          seededFrom: typeof json.seededFrom === 'string' ? json.seededFrom : '',
        })
        if (json.runtime) setRuntime(json.runtime)
        setWarnings(Array.isArray(json.warnings) ? json.warnings.map(String) : [])
        if (json.configError && json.configError.message) {
          setNotice({ kind: 'error', text: '当前配置不可用：' + errorText(json.configError, 200) })
        }
      }

      React.useEffect(() => {
        let alive = true
        setNotice({ kind: 'loading', text: '正在读取输入配置…' })
        fetch(API + '/settings', { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((json) => ({ response, json })))
          .then(({ response, json }) => {
            if (!alive) return
            if (!response.ok || !json || json.ok !== true) {
              setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
              return
            }
            readBack(json)
            setNotice({ kind: 'info', text: '已读取当前配置；修改后点「保存」，立刻生效。' })
          })
          .catch((error) => {
            if (!alive) return
            setNotice({ kind: 'error', text: '读取失败：' + ((error && error.message) || String(error)) })
          })
        return () => { alive = false }
      }, [])

      const patch = (group, key, value) => setValues((prev) => (prev
        ? { ...prev, [group]: { ...prev[group], [key]: value } }
        : prev))

      async function save() {
        if (!values) return
        setSaving(true)
        setNotice({ kind: 'info', text: '正在保存…' })
        try {
          const response = await fetch(API + '/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ values }),
          })
          const json = await response.json().catch(() => ({}))
          if (!response.ok || !json || json.ok !== true) {
            setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
            return
          }
          readBack(json)
          const changed = Array.isArray(json.changed) && json.changed.length ? json.changed.join('、') : '无改动'
          setNotice({ kind: 'success', text: '已保存：' + changed })
          // 配置改了要重新拉一次 bootstrap（设备参数、自动推帧间隔、vad 都可能变）
          try {
            const boot = await getJson('/bootstrap')
            emit({ config: boot.config, vad: boot.vad || null })
          } catch { /* 刷新失败不影响保存 */ }
        } catch (error) {
          setNotice({ kind: 'error', text: '保存失败：' + ((error && error.message) || String(error)) })
        } finally {
          setSaving(false)
        }
      }

      if (!values) {
        return h('section', { className: 'mi-set', 'aria-label': '输入设置' },
          h('style', null, CSS),
          h('header', null,
            h('h2', { className: 'mi-set-title' }, '输入'),
            h('p', { className: 'mi-set-sub' }, '摄像头、麦克风、虚拟采集器与自动推帧。')),
          h('p', { className: 'mi-notice', 'data-kind': notice.kind, role: 'status' }, notice.text))
      }

      const row = (label, control, hint) => h('div', { className: 'mi-set-row', key: label },
        h('span', { className: 'mi-set-label' }, label),
        h('div', { className: 'mi-set-mid' }, control, hint ? h('p', { className: 'mi-set-hint' }, hint) : null))

      const text = (group, key, hint, placeholder) => row(
        key,
        h('input', {
          className: 'mi-set-input',
          type: 'text',
          value: values[group][key] === undefined || values[group][key] === null ? '' : values[group][key],
          placeholder: placeholder || '',
          spellCheck: false,
          onChange: (event) => patch(group, key, event.target.value),
        }),
        hint,
      )

      const number = (group, key, hint, min, max) => row(
        key,
        h('input', {
          className: 'mi-set-input',
          type: 'number',
          min,
          max,
          value: values[group][key] === undefined || values[group][key] === null ? '' : values[group][key],
          onChange: (event) => patch(group, key, event.target.value === '' ? '' : Number(event.target.value)),
        }),
        hint,
      )

      const check = (group, key, label, hint) => row(
        label,
        h('label', { className: 'mi-set-check' },
          h('input', {
            type: 'checkbox',
            checked: values[group][key] === true,
            onChange: (event) => patch(group, key, event.target.checked),
          }),
          h('span', null, label)),
        hint,
      )

      const captureView = runtime && runtime.capture ? runtime.capture : null
      const vad = runtime && runtime.vad ? runtime.vad : null

      return h('section', { className: 'mi-set', 'aria-label': '输入设置' },
        h('style', null, CSS),
        h('header', null,
          h('h2', { className: 'mi-set-title' }, '输入'),
          h('p', { className: 'mi-set-sub' },
            '「输入」= 摄像头 / 麦克风 / 虚拟采集器（muse_galaxy 等）。自动分段语音与自动推帧在这里配；'
            + '断句阈值与阿里云 key 在「声音」里（本插件依赖 mira_media，不重复存凭据）。')),
        h('fieldset', { className: 'mi-set-group' },
          h('legend', { className: 'mi-set-legend' }, '摄像头'),
          check('camera', 'enabled', '允许打开摄像头', '关掉后输入框的「摄像头」按钮与 device_look 会明确报 config/missing。'),
          text('camera', 'deviceId', '留空 = 浏览器默认设备；要钉死某台设备就填它的 deviceId', ''),
          number('camera', 'width', '请求分辨率：宽（浏览器会给最接近的档位）', 160, 4096),
          number('camera', 'height', '请求分辨率：高', 120, 4096)),
        h('fieldset', { className: 'mi-set-group' },
          h('legend', { className: 'mi-set-legend' }, '麦克风'),
          check('mic', 'enabled', '允许打开麦克风', '关掉后「麦克风」按钮、device_listen 与自动识别都不可用。'),
          text('mic', 'deviceId', '留空 = 浏览器默认输入设备；要钉死某支麦克风就填它的 deviceId', ''),
          number('mic', 'sampleRate', '送识别的采样率（默认 16000）', 8000, 48000),
          h('p', { className: 'mi-set-hint' },
            '断句（VAD）参数在「声音」里：'
            + (vad ? '阈值 ' + vad.threshold + '，静音 ' + vad.silenceMs + 'ms 算一句，最短 ' + vad.minSpeechMs + 'ms，最长 ' + vad.maxMs + 'ms' : '（mira_media 没加载，读不到）'))),
        h('fieldset', { className: 'mi-set-group' },
          h('legend', { className: 'mi-set-legend' }, '外部采集器（虚拟摄像头 / 麦克风）'),
          check('capture', 'enabled', '允许采集器接入', '关掉后 galaxy 的 capture/open 会 503。'),
          number('capture', 'fps', '告诉采集器的帧率（1–15）', 1, 15),
          number('capture', 'width', '告诉采集器的画面宽度', 160, 1920),
          check('capture', 'audio', '要采集器的音频', '关掉就只收画面。'),
          check('capture', 'autoSwitch', '采集器接入时自动切到「外部采集」', '默认开：一开始推流就能看到画面/听到声音。'),
          number('capture', 'staleMs', '多久没数据算停滞（毫秒）', 500, 60000),
          number('capture', 'lostMs', '多久没数据算失联并断开（毫秒）', 1000, 300000),
          captureView
            ? h('p', { className: 'mi-set-hint' },
              '采集口令牌：' + captureView.tokenFile + '；当前 ' + captureView.sources.length + ' 路流，'
              + captureView.subscribers + ' 个面板订阅。')
            : null),
        h('fieldset', { className: 'mi-set-group' },
          h('legend', { className: 'mi-set-legend' }, '图像识别（帧怎么"看"）'),
          check('vision', 'enabled', '启用图像识别', '关掉后 device_look 与自动推帧都不可用。'),
          row('识别方式',
            h('select', {
              className: 'mi-set-input',
              value: values.vision.provider || 'dsh',
              onChange: (event) => patch('vision', 'provider', event.target.value),
            },
            h('option', { value: 'dsh' }, 'dsh：交给当前会话模型看（默认，不花第三方额度）'),
            h('option', { value: 'aliyun' }, 'aliyun：服务端识图返回文字')),
            'dsh 走宿主的图片附件（和 read_image 同一条路），模型要能接收图片输入；'
            + '自动推帧不经过模型，仍走 aliyun（key 在「声音」里）。'),
          text('vision', 'base', '识图地址（默认 token-plan 的 api/v1）', 'https://token-plan.maas.qianwenaiapi.com/api/v1'),
          text('vision', 'model', '识图模型（默认 qwen3.8-flash）', 'qwen3.8-flash'),
          text('vision', 'prompt', '默认提示词（自动推帧用它）', ''),
          number('vision', 'autoIntervalMs', '自动推帧间隔（毫秒，0 = 关；开了会定时抓帧识别并插话）', 0, 3600000)),
        h('fieldset', { className: 'mi-set-group' },
          h('legend', { className: 'mi-set-legend' }, '事件流（自动分段语音 + 自动推帧 → 插话）'),
          check('events', 'enabled', '识别结果自动进入会话', '关掉后识别结果只显示在「形象」侧边栏，不插话。'),
          check('events', 'steer', '用插话（steer）投递', '关掉 = 只记在侧边栏，不打扰会话。'),
          number('events', 'minIntervalMs', '两条之间最小间隔（毫秒）', 0, 3600000),
          number('events', 'maxPerMin', '每分钟最多几条', 1, 600),
          number('events', 'cooldownKeyMs', '同一句话的冷却（毫秒）', 0, 86400000),
          text('events', 'voiceTemplate', '语音事件的提示词模板（{text} 会被替换）', '[感知·语音] {text}'),
          text('events', 'visionTemplate', '画面事件的提示词模板', '[感知·画面] {text}')),
        h('fieldset', { className: 'mi-set-group' },
          h('legend', { className: 'mi-set-legend' }, '凭据（只读）'),
          h('p', { className: 'mi-set-hint' },
            keyConfigured
              ? '阿里云 key 已配置（在「声音」里，' + (files.credsFile || 'creds/dashscope.json') + '，600）。'
              : '阿里云 key 还没配：语音识别与自动推帧会报 creds/missing —— 到「设置 · 声音」里填一次（三件套共用这一份）。')),
        h('div', { className: 'mi-set-actions' },
          h('button', {
            type: 'button',
            className: 'mi-set-button',
            disabled: saving,
            onClick: () => { void save() },
          }, saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            className: 'mi-set-button',
            disabled: saving || !baseline,
            onClick: () => {
              if (!baseline) return
              setValues(toDraft(baseline))
              setNotice({ kind: 'info', text: '已撤销未保存的改动。' })
            },
          }, '撤销改动')),
        h('p', { className: 'mi-notice', 'data-kind': notice.kind, role: 'status', 'aria-live': 'polite' }, notice.text),
        files.seededFrom
          ? h('p', { className: 'mi-set-hint' }, '首次创建时已从旧 muse_vtuber 配置迁移：' + files.seededFrom)
          : null,
        warnings.length
          ? h('ul', { className: 'mi-set-hint' }, warnings.map((warning, index) => h('li', { key: index }, warning)))
          : null,
        files.configFile ? h('p', { className: 'mi-set-hint' }, '配置文件：' + files.configFile) : null)
    }

    /* ══════════════════════════════════════════════════════════
     * 8. 对别的插件暴露的页面全局契约
     * ══════════════════════════════════════════════════════════ */

    function publishGlobal() {
      /* ── 页面播放器（2.0.0 从 mira_audio 搬来）：`say` 帧 → <audio> 出声 + 电平 ── */
      const player = {
        audio: null, ctx: null, analyser: null, buf: null,
        speaking: false, level: 0, text: '', url: '', error: '', raf: 0, pendingUrl: '',
        listeners: new Set(),
      }
      function playerState() {
        return { ready: !!player.audio, speaking: player.speaking, level: player.level, text: player.text, url: player.url, error: player.error }
      }
      function playerEmit(patch) {
        Object.assign(player, patch)
        for (const fn of [...player.listeners]) {
          try { fn(playerState()) } catch { /* 忽略 */ }
        }
      }
      function levelLoop() {
        cancelAnimationFrame(player.raf)
        const tick = () => {
          player.raf = requestAnimationFrame(tick)
          if (!player.analyser || !player.buf) { player.level = 0; return }
          try { player.analyser.getByteTimeDomainData(player.buf) } catch { return }
          let sum = 0
          for (const v of player.buf) { const d = (v - 128) / 128; sum += d * d }
          player.level = Math.min(1, Math.sqrt(sum / player.buf.length) * 3.2)
        }
        tick()
      }
      async function playUrl(url) {
        if (typeof url !== 'string' || url === '') return
        try {
          if (!player.audio) {
            const AudioCtor = window.Audio || window.HTMLAudioElement
            player.audio = new AudioCtor()
            player.audio.preload = 'auto'
            player.audio.addEventListener('ended', () => { player.speaking = false; player.level = 0; cancelAnimationFrame(player.raf); playerEmit({}) })
          }
          if (!player.ctx && (window.AudioContext || window.webkitAudioContext)) {
            const Ctx = window.AudioContext || window.webkitAudioContext
            player.ctx = new Ctx()
            const src = player.ctx.createMediaElementSource(player.audio)
            player.analyser = player.ctx.createAnalyser()
            player.analyser.fftSize = 256
            player.buf = new Uint8Array(player.analyser.fftSize)
            src.connect(player.analyser)
            player.analyser.connect(player.ctx.destination)
          }
          if (player.ctx && player.ctx.state === 'suspended') await player.ctx.resume().catch(() => {})
          player.audio.src = url
          await player.audio.play()
          player.pendingUrl = ''
          playerEmit({ speaking: true, url, level: 0, error: '' })
          levelLoop()
        } catch {
          player.pendingUrl = url
          playerEmit({ speaking: false, error: '需要先在页面上点一下才能播放声音（浏览器自动播放策略）' })
        }
      }
      if (!window.__miraDeviceUnlockBound) {
        window.__miraDeviceUnlockBound = true
        const unlock = () => {
          if (player.pendingUrl) { const u = player.pendingUrl; player.pendingUrl = ''; void playUrl(u) }
          if (player.ctx && player.ctx.state === 'suspended') player.ctx.resume().catch(() => {})
        }
        window.addEventListener('pointerdown', unlock, true)
        window.addEventListener('keydown', unlock, true)
      }

      const existing = window.__miraDevice__
      if (existing && existing.version >= REGISTRY_VERSION) return existing

      const api = {
        version: REGISTRY_VERSION,
        /** 采集是否就绪（bootstrap 完成）。 */
        ready: () => store.ready === true,
        /** 输入实况 + 电平 + 最近日志（给「形象」右侧栏等用）。 */
        state: () => ({ ...publicState(), heard: store.heard.slice(), seen: store.seen.slice() }),
        /** 订阅状态变化，返回取消函数。 */
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        /** 订阅「最近听到/看到」的变化，返回取消函数。 */
        subscribeLog(fn) {
          logListeners.add(fn)
          return () => logListeners.delete(fn)
        },
        /** 开关摄像头/麦克风（等同于点输入框按钮），返回 Promise。 */
        setCamera: async (on) => {
          emit({ cameraOn: on === true })
          return postJson('/state', { cameraOn: on === true, clientId: store.clientId || '' })
        },
        setMic: async (on) => {
          emit({ micOn: on === true })
          return postJson('/state', { micOn: on === true, clientId: store.clientId || '' })
        },
        /** 切来源：kind = 'camera' | 'mic'，source = 'device' | 'galaxy' | 'none'。 */
        setSource: async (kind, source) => {
          const key = kind === 'camera' ? 'cameraSource' : 'micSource'
          const value = ['device', 'galaxy', 'none'].includes(String(source)) ? String(source) : 'device'
          emit({ [key]: value })
          await reconcileCapture()
          return postJson('/state', { [key]: value, clientId: store.clientId || '' })
        },
        /** 本机摄像头的 MediaStream（没有就是 null）：给「形象」页签的 <video> 用。 */
        videoStream: () => capture.videoStream,
        /** 本机麦克风的 AnalyserNode（画波形用；没有就是 null）。 */
        analyser: () => capture.analyser,
        /** 0..1 的实时电平（麦克风或采集器，谁在用给谁）。 */
        level: () => (String(store.micSource || 'device') === 'galaxy' ? store.captureLevel : capture.level) || 0,
        /** 抓一帧 dataURL（本机设备源；没画面返回空串）。 */
        frame: (quality) => capture.frameImage(quality),
        /** 最近识别到的语音 / 画面。 */
        heard: () => store.heard.slice(),
        seen: () => store.seen.slice(),
        /** 外部采集器的 MJPEG 面板地址（前端自己拼 query）。 */
        captureUrl: () => API + '/stream.mjpg',
        /** 当前会话 id（宿主插话投给谁）；由页签写入。 */
        sessionId: () => store.sessionId,
        /** 页面播放器（形象页的口型/气泡读这里）。 */
        player: {
          version: 1,
          state: () => playerState(),
          subscribe(fn) { player.listeners.add(fn); return () => player.listeners.delete(fn) },
          level: () => player.level,
          analyser: () => player.analyser,
          play: (url) => playUrl(url),
          ready: () => !!player.audio,
        },
        /** 让设备说话（宿主合成 + 广播 say）。 */
        talk: (text, options = {}) => postJson('/say', {
          text: String(text ?? ''),
          voice: String(options?.voice || ''),
          sessionId: store.sessionId || '',
          ...(options?.force === true ? { force: true } : {}),
        }),
      }
      window.__miraDevice__ = api
      return api
    }

    /* ══════════════════════════════════════════════════════════
     * 9. 导出：两个槽位注册
     * ══════════════════════════════════════════════════════════ */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          publishGlobal()
          void ensureBoot()
          return () => {
            if (autoVisionTimer) {
              window.clearTimeout(autoVisionTimer)
              autoVisionTimer = null
            }
            if (stream) {
              try {
                stream.close()
              } catch { /* 忽略 */ }
              stream = null
            }
            capture.stopCamera()
            capture.stopMic()
            logListeners.clear()
          }
        })

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'mira-input-devices',
          order: 10,
          label: () => '摄像头/麦克风',
        }, DeviceButtons))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mira-input',
          order: 46,
          label: () => '设备',
        }, SettingsSection))
      },
    }
}

/**
 * 注册 id 必须等于宿主认的**包 specifier**（`dsh-client-modules` 取的是 loader 条目的
 * `fiber.entry?.options.name`，加载完还会校验「bundle 有没有用这个 id 注册」）。
 * 同一个包可能以不同 specifier 装进 profile，所以两个 id 都注册：只有宿主清单里那个会被
 * 真正 import，另一个只是躺着的工厂。
 */
for (const id of ['mira_device', 'mira_device_ui']) {
  try {
    window.__ModuleLoader__.load({ id, factory: miraDeviceClient })
  } catch (error) {
    console.error('[mira_device] 注册 client 模块失败：' + id, error)
  }
}
