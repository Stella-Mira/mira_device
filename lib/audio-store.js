/**
 * mira_audio / audio-store.js —— 合成出来的音频暂存（内存 + 上限 + TTL）
 *
 * 为什么不把 base64 塞进 SSE 帧：一帧几百 KB 会把事件流卡住，控制台还会把它打出来。
 * 这里只存最近 N 段（默认 32），浏览器用 `<audio src="/audio/api/audio/<id>">` 播。
 * id 不可猜（时间戳 36 进制 + 自增），并且只在本机同源页面里用。
 */

export const AUDIO_LIMIT = 32
export const AUDIO_TTL_MS = 10 * 60 * 1000

export class AudioStore {
  constructor({ limit = AUDIO_LIMIT, ttlMs = AUDIO_TTL_MS } = {}) {
    this.limit = limit
    this.ttlMs = ttlMs
    this.items = new Map()
    this.seq = 0
  }

  put(buffer, mime) {
    this.prune()
    this.seq += 1
    const id = Date.now().toString(36) + '-' + this.seq.toString(36)
    this.items.set(id, { buffer, mime, at: Date.now() })
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next().value
      this.items.delete(oldest)
    }
    return id
  }

  get(id) {
    this.prune()
    return this.items.get(String(id || '')) || null
  }

  prune() {
    const now = Date.now()
    for (const [id, item] of this.items) {
      if (now - item.at > this.ttlMs) this.items.delete(id)
    }
  }

  status() {
    return { size: this.items.size, limit: this.limit, ttlMs: this.ttlMs }
  }
}
