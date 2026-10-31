/**
 * mira_device / state.js —— 输入侧的运行状态（state.json，schemaVersion 1）
 *
 * 存什么：摄像头/麦克风开关、来源（本机设备 / 外部采集器 / 不用）、最后写入者与时间。
 * 为什么跟形象的状态分开：按钮点一下就要写、刷新后要能恢复；而"形象长什么样"（模型/表情/
 * 可见性）是另一份状态，混在一个文件里会让两边的写入互相覆盖。
 *
 * 约定7：schemaVersion 不匹配 → 保留原文件、拒绝使用（工具会报 config/schema），不静默清空。
 */

import { join } from 'node:path'

import {
  MiraError, checkSchema, ensureDir, nowIso, readJsonStrict, writeJsonAtomic,
} from './kit.mjs'

export const STATE_SCHEMA = 1

/** 采集来源：本机设备、外部采集器（muse_galaxy 等）、没有。 */
export const CAPTURE_SOURCES = ['device', 'galaxy', 'none']

export const DEFAULT_STATE = {
  cameraOn: false,
  micOn: false,
  // 'device'（浏览器 getUserMedia）| 'galaxy'（外部采集器推流）| 'none'
  cameraSource: 'device',
  micSource: 'device',
  updatedAt: '',
  by: 'init',
}

export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.baseDir `$DSH_HOME/mira_config/mira_device`
   * @param {object} [options.logger]
   */
  constructor({ baseDir, logger = null }) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'state.json')
    this.logger = logger
    this.state = structuredClone(DEFAULT_STATE)
    this.loadError = null
  }

  load() {
    ensureDir(this.baseDir)
    const strict = readJsonStrict(this.file)
    if (strict.reason === 'missing') return { created: false }
    if (!strict.ok) {
      this.loadError = {
        code: 'config/corrupt',
        message: '状态文件不可用：' + this.file + (strict.detail ? '（' + strict.detail + '）' : ''),
        hint: '删掉 ' + this.file + ' 让插件按默认重建（只会丢摄像头/麦克风开关这类界面状态）',
      }
      return { error: this.loadError }
    }
    const checked = checkSchema(strict.value, STATE_SCHEMA, this.file)
    if (!checked.ok) {
      this.loadError = checked.error?.error || checked.error
      return { error: this.loadError }
    }
    this.state = { ...structuredClone(DEFAULT_STATE), ...sanitize(strict.value) }
    return { created: false, state: this.snapshot() }
  }

  /** 读：坏文件时抛（工具要能说清哪里坏了），而不是悄悄给默认值。 */
  get() {
    if (this.loadError) {
      throw new MiraError(this.loadError.code, this.loadError.message, this.loadError.hint)
    }
    return this.state
  }

  snapshot() {
    if (this.loadError) return structuredClone(DEFAULT_STATE)
    return structuredClone(this.state)
  }

  status() {
    return {
      file: this.file,
      state: this.snapshot(),
      error: this.loadError ? { ...this.loadError } : null,
    }
  }

  /** 合并写入（按钮/工具/客户端上报都走这里）。返回 { state, changed:[] }。 */
  set(patch, { by = 'tool' } = {}) {
    if (this.loadError) {
      throw new MiraError(this.loadError.code, this.loadError.message, this.loadError.hint)
    }
    const next = { ...this.state }
    const changed = []
    const input = patch && typeof patch === 'object' ? patch : {}
    for (const key of ['cameraOn', 'micOn']) {
      if (typeof input[key] === 'boolean' && input[key] !== next[key]) {
        next[key] = input[key]
        changed.push(key)
      }
    }
    // 采集来源：只认白名单，写错值不落盘（否则界面会去等一个不存在的源）
    for (const key of ['cameraSource', 'micSource']) {
      if (typeof input[key] !== 'string') continue
      const value = clampText(input[key], 20).toLowerCase()
      if (!CAPTURE_SOURCES.includes(value)) continue
      if (value !== next[key]) {
        next[key] = value
        changed.push(key)
      }
    }
    if (changed.length === 0) return { state: this.snapshot(), changed }
    next.updatedAt = nowIso()
    next.by = clampText(by, 40) || 'tool'
    this.state = next
    this.flush()
    return { state: this.snapshot(), changed }
  }

  /** 落盘（失败只 warn，不把界面操作带崩）。 */
  flush() {
    const payload = { schemaVersion: STATE_SCHEMA, ...this.state }
    const written = writeJsonAtomic(this.file, payload)
    if (!written) {
      this.logger?.warn?.('[mira_device] 状态落盘失败：' + this.file + '（界面操作仍生效，重启后会丢）')
    }
    return written
  }
}

function clampText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
}

function sanitize(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw || {})) {
    if (key === 'schemaVersion') continue
    if (key === 'cameraOn' || key === 'micOn') {
      if (typeof value === 'boolean') out[key] = value
      continue
    }
    if (key === 'updatedAt' || key === 'by') {
      if (typeof value === 'string') out[key] = clampText(value, 200)
      continue
    }
    if (key === 'cameraSource' || key === 'micSource') {
      const source = clampText(value, 20).toLowerCase()
      if (CAPTURE_SOURCES.includes(source)) out[key] = source
    }
  }
  return out
}
