/**
 * mira_device / authz.js —— 「设备与形象归一个持有权限的会话」的判定
 *
 * 2.0.0 起从 muse_vtuber 搬到这里：设备（说话/采集/推流/看听）与形象（外观控制）
 * 都必须由**持有权限的那个会话**使用；服务本身谁都能 inject（插件不是会话，不判权）。
 * 首次使用自动认领（autoClaim），被别人占着报冲突（force 可抢）。
 *
 * 目标（用户口径）：
 *   · vtuber 在 mira_account 里是一个**本地虚拟账号**（platform=vtuber）；
 *   · peer = **形象本身**（kind=avatar，peerId='main'），会话是绑定的**主体**（sessionId）。
 *     这点很关键：若 peer 用 sessionId，每个会话都会成为自己 peer 的 taker，永远不冲突，模型就废了；
 *   · **控制**（说话 / 摄像头 / 麦克风 / 看 / 听，以及形象的外观工具）必须 taker；
 *   · vtuber 的外观工具（vtuber_expression 等）通过 `miraDevice.authz` 校验 —— 只有 device 的
 *     持有者才能改形象；
 *   · 首次控制自动认领 taker；被别人占着时明确报冲突（给 force 就能抢，旧 taker 降级 observer）；
 *   · mira_account 缺席时**全禁止**（安全默认），配置 security.mode='off' 可临时放开。
 *
 * 判定结果缓存在进程内（默认 30s），认领/抢占后立即失效，避免每次工具调用都读盘。
 * 这里不写任何凭据/敏感内容，只读绑定关系。
 */

export const SECURITY_MODES = ['enforce', 'off']

/** 控制类：会改变"形象长什么样"的，必须 taker。 */
export const CONTROL_TOOLS = [
  'device_say',
  'device_camera',
  'device_mic',
  'device_look',
  'device_listen',
  'vtuber_expression',
  'vtuber_motion',
  'vtuber_visible',
  'vtuber_model',
]

/**
 * 接收类：看 / 听 —— observer 就够。
 * 拆分后"看/听"的工具已经搬到 mira_input（input_look / input_listen），这里保留这张表
 * 是为了将来形象侧再加只读能力时不必改注册逻辑（空表 = 没有接收类工具）。
 */
export const RECEIVE_TOOLS = []

export class AuthzError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'AuthzError'
    this.code = code
    this.hint = hint
  }
}

const DEFAULTS = {
  mode: 'enforce',
  accountId: 'vtuber-main',
  peerKind: 'avatar',
  // peer = 形象本身（常量），会话是绑定的主体；否则每个会话都是自己 peer 的 taker，永远不会冲突
  peerId: 'main',
  cacheMs: 30000,
  // 第一次控制自动认领 taker
  autoClaim: true,
  // 没绑定的人来"看/听"时自动登记成 observer（false = 必须先显式绑定）
  autoObserve: true,
}

export class Authorizer {
  /**
   * @param {object} options
   * @param {() => object} options.config       取当前配置（security 段）
   * @param {() => object|null} options.account 取 mira_account 的 API（没有就返回 null）
   * @param {object} [options.logger]
   * @param {(name:string)=>void} [options.bump]
   */
  constructor({ config, account, logger = null, bump = null, now = () => Date.now() }) {
    this.configOf = config
    this.accountOf = account
    this.logger = logger
    this.bump = bump
    this.now = now
    this.cache = new Map() // sessionId -> { view, at }
  }

  options() {
    let raw = {}
    try {
      const cfg = this.configOf && this.configOf()
      if (cfg && typeof cfg === 'object' && cfg.security && typeof cfg.security === 'object') raw = cfg.security
    } catch { /* 配置坏了按默认走（下面 mode='enforce'） */ }
    const mode = SECURITY_MODES.includes(String(raw.mode)) ? String(raw.mode) : DEFAULTS.mode
    return {
      mode,
      accountId: String(raw.accountId || DEFAULTS.accountId).trim() || DEFAULTS.accountId,
      peerKind: String(raw.peerKind || DEFAULTS.peerKind).trim() || DEFAULTS.peerKind,
      peerId: String(raw.peerId || DEFAULTS.peerId).trim() || DEFAULTS.peerId,
      cacheMs: Number.isFinite(Number(raw.cacheMs)) ? Math.max(0, Number(raw.cacheMs)) : DEFAULTS.cacheMs,
      autoClaim: raw.autoClaim === undefined ? DEFAULTS.autoClaim : raw.autoClaim === true,
      autoObserve: raw.autoObserve === undefined ? DEFAULTS.autoObserve : raw.autoObserve === true,
    }
  }

  /** 当前是否真的在管权限（mode 与 mira_account 是否可用）。 */
  state() {
    const opts = this.options()
    const api = this.api()
    return {
      mode: opts.mode,
      accountId: opts.accountId,
      peerKind: opts.peerKind,
      peerId: opts.peerId,
      available: !!api,
      // 直白告诉调用方"现在是不是裸奔"
      enforcing: opts.mode === 'enforce',
      autoClaim: opts.autoClaim,
      autoObserve: opts.autoObserve,
    }
  }

  api() {
    try {
      const api = this.accountOf && this.accountOf()
      return api && typeof api.resolve === 'function' && typeof api.bind === 'function' ? api : null
    } catch {
      return null
    }
  }

  /** 无缓存地查一次绑定。 */
  #query(sessionId) {
    const opts = this.options()
    if (!api_ok(this.api())) return { mode: 'unavailable' }
    const api = this.api()
    let result
    try {
      result = api.resolve(opts.accountId, opts.peerKind, opts.peerId)
    } catch (error) {
      const code = error && error.code ? String(error.code) : ''
      if (code === 'account/not-found') return { mode: 'no-account', error }
      return { mode: 'error', error }
    }
    if (result && result.disabled) return { mode: 'disabled' }
    const taker = result && result.taker ? String(result.taker.sessionId || '') : ''
    const observers = result && Array.isArray(result.observers)
      ? result.observers.map((o) => String(o.sessionId || '')).filter(Boolean)
      : []
    if (taker === sessionId && sessionId !== '') return { mode: 'taker', taker, observers }
    if (observers.includes(sessionId) && sessionId !== '') return { mode: 'observer', taker, observers }
    return { mode: 'none', taker, observers }
  }

  /** 带缓存的查询（认领/抢占后会被 invalidate）。 */
  view(sessionId, { fresh = false } = {}) {
    const sid = String(sessionId || '').trim()
    if (sid === '') return { mode: 'no-session' }
    const opts = this.options()
    if (opts.cacheMs > 0 && !fresh) {
      const hit = this.cache.get(sid)
      if (hit && this.now() - hit.at < opts.cacheMs) return hit.view
    }
    const view = this.#query(sid)
    if (opts.cacheMs > 0) this.cache.set(sid, { view, at: this.now() })
    return view
  }

  invalidate(sessionId) {
    const sid = String(sessionId || '').trim()
    if (sid === '') this.cache.clear()
    else this.cache.delete(sid)
  }

  /** 全禁止时的统一错误：说清楚"为什么"和"怎么解"。 */
  #denied(view, opts) {
    if (view.mode === 'no-session') {
      return new AuthzError('authz/no-session',
        '这次调用没有会话身份，无法判定权限',
        '从会话里调用（工具会带上 sessionId）；或在 vtuber 配置里把 security.mode 改成 off')
    }
    if (view.mode === 'unavailable') {
      return new AuthzError('authz/unavailable',
        '权限检查需要 mira_account，但它没有加载',
        '装并启用 mira_account（插件平台名 vtuber）后重启；或把 vtuber 配置的 security.mode 改成 off（不推荐，等于谁都能控制）')
    }
    if (view.mode === 'no-account') {
      return new AuthzError('authz/no-account',
        'mira_account 里还没有形象账号 ' + opts.accountId,
        'mira_account_add {id:"' + opts.accountId + '", platform:"vtuber", label:"形象"} 登记一次即可')
    }
    if (view.mode === 'disabled') {
      return new AuthzError('authz/disabled',
        '形象账号 ' + opts.accountId + ' 在 mira_account 里被停用了',
        'mira_account_toggle 或删除该账号的 setAccountEnabled(id, true)')
    }
    if (view.mode === 'error') {
      const info = view.error && view.error.message ? view.error.message : '未知错误'
      return new AuthzError('authz/failed', '权限检查失败：' + info, '看 mira_account_status 与 dsh 日志')
    }
    return new AuthzError('authz/denied', '这个会话没有形象的权限', '让形象主人给这个会话授权（mira_account_bind）')
  }

  /**
   * 控制类操作：必须有 taker。
   * @returns {{ ok:true, view:object, claimed?:boolean, forced?:boolean }}
   */
  requireControl(sessionId, { force = false, tool = '' } = {}) {
    const opts = this.options()
    const sid = String(sessionId || '').trim()
    if (opts.mode === 'off') return { ok: true, view: { mode: 'off' }, skipped: true }

    const view = this.view(sid, { fresh: force })
    if (view.mode === 'taker') return { ok: true, view }

    // 没人占 → 首次控制自动认领
    if (opts.autoClaim && (view.mode === 'none' || view.mode === 'observer')) {
      const free = view.mode === 'none' || !view.taker
      if (free) {
        const claim = this.#bind(sid, { mode: 'taker' })
        if (claim !== null) {
          this.bump?.('authz.claimed')
          this.logger?.info?.('[muse_vtuber] 会话 ' + sid + ' 认领了形象的控制权（taker）'
            + (view.mode === 'observer' ? '（原为旁观）' : ''))
          return { ok: true, view: { ...view, mode: 'taker' }, claimed: true }
        }
      }
    }

    // 被占着：给 force 就抢（旧 taker 由 mira_account 降级成 observer）
    if (force) {
      const forced = this.#bind(sid, { mode: 'taker', force: true })
      if (forced !== null) {
        this.bump?.('authz.forced')
        this.logger?.warn?.('[muse_vtuber] 会话 ' + sid + ' 抢走了形象的控制权（原 taker '
          + (view.taker || '?') + ' 降为 observer）')
        return { ok: true, view: { ...view, mode: 'taker' }, forced: true }
      }
    }

    // 明确是被谁占着 → 给可执行的冲突错误
    if (view.mode === 'none' || view.mode === 'observer') {
      const holder = String(view.taker || '')
      if (holder !== '') {
        return {
          ok: false,
          error: new AuthzError('authz/conflict',
            '形象现在由会话 ' + holder + ' 控制（' + (tool || '该操作') + '需要 taker 权限）',
            '要抢过来给 force:true（原 taker 会降级成 observer）；只看不控就保持 observer'),
        }
      }
    }
    return { ok: false, error: this.#denied(view, opts) }
  }

  /**
   * 接收类操作：observer 或 taker 都行。
   * 没绑定的会话默认自动登记 observer（security.autoObserve=false 可关掉）。
   */
  requireReceive(sessionId, { tool = '' } = {}) {
    const opts = this.options()
    const sid = String(sessionId || '').trim()
    if (opts.mode === 'off') return { ok: true, view: { mode: 'off' }, skipped: true }

    const view = this.view(sid)
    if (view.mode === 'taker' || view.mode === 'observer') return { ok: true, view }

    if (opts.autoObserve && view.mode === 'none') {
      const bound = this.#bind(sid, { mode: 'observer' })
      if (bound !== null) {
        this.bump?.('authz.observed')
        this.logger?.info?.('[muse_vtuber] 会话 ' + sid + ' 登记为形象的观众（observer）')
        return { ok: true, view: { ...view, mode: 'observer' }, observed: true }
      }
    }
    return { ok: false, error: this.#denied(view, opts) }
  }

  /** 绑定失败返回 null（错误已记日志），成功返回 mira_account 的结果。 */
  #bind(sessionId, { mode, force = false }) {
    const opts = this.options()
    const api = this.api()
    if (!api_ok(api)) return null
    try {
      const result = api.bind({
        sessionId,
        accountId: opts.accountId,
        kind: opts.peerKind,
        peerId: opts.peerId,
        mode,
        force,
        boundBy: 'muse_vtuber',
      })
      this.invalidate(sessionId)
      return result ?? { ok: true }
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'binding/failed'
      this.logger?.warn?.('[muse_vtuber] 绑定失败（' + code + '）：' + (error && error.message ? error.message : error))
      if (code === 'binding/conflict') this.bump?.('authz.conflict')
      return null
    }
  }

  /** 给 vtuber_status 看的：当前会话是谁、能不能控/能不能看。 */
  describe(sessionId) {
    const opts = this.options()
    const view = this.view(sessionId)
    return {
      ...this.state(),
      sessionId: String(sessionId || ''),
      role: view.mode,
      taker: view.taker || '',
      observers: view.observers || [],
      control: opts.mode === 'off' || view.mode === 'taker',
      receive: opts.mode === 'off' || view.mode === 'taker' || view.mode === 'observer',
    }
  }
}

function api_ok(api) {
  return !!api && typeof api.resolve === 'function' && typeof api.bind === 'function'
}
