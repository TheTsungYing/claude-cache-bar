// Pure logic over plain data: no `$` here, so tests can call it directly.

import type {
  BreakCause,
  BreakSensitivity,
  CacheBreak,
  CacheSample,
  ChangeMarks,
  Extension,
  Language,
  SessionSummary,
  Ttl,
  TtlMode,
  TtlState,
} from '../types'
import type { Strings } from './i18n'

export const MAX_SAMPLES = 500
export const MAX_EVENTS = 100

const MINUTE = 60_000

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }

/** Slack on idle gaps, so clock jitter near a TTL edge proves nothing. */
const IDLE_MARGIN_MS = 15_000

/** Fewer cached tokens than this say nothing about the TTL. */
const MIN_PROOF_TOKENS = 1024

// ---- Config

export type OnExpiring = 'notify' | 'button' | 'auto'

export type Config = {
  language: Language
  ttlMode: TtlMode
  onExpiring: OnExpiring
  warnAtPercent: number
  alertAtPercent: number
  toast: boolean
  autoExtendMaxPerIdle: number
  autoExtendMinContextK: number
  autoExtendGiveUpMin: number
  breakSensitivity: BreakSensitivity
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.find(item => item === value) ?? fallback

const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/** Reads `register`'s options, falling back to the defaults on anything odd. */
export const readConfig = (options: Readonly<Record<string, unknown>>): Config => ({
  language: pick(options.language, ['en', 'zh-TW'], 'en'),
  ttlMode: pick(options.ttlMode, ['auto', '5m', '1h'], 'auto'),
  onExpiring: pick(options.onExpiring, ['notify', 'button', 'auto'], 'button'),
  warnAtPercent: clamp(options.warnAtPercent, 20, 1, 99),
  alertAtPercent: clamp(options.alertAtPercent, 10, 1, 99),
  toast: typeof options.toast === 'boolean' ? options.toast : true,
  autoExtendMaxPerIdle: clamp(options.autoExtendMaxPerIdle, 3, 0, 100),
  autoExtendMinContextK: clamp(options.autoExtendMinContextK, 20, 0, 10_000),
  autoExtendGiveUpMin: clamp(options.autoExtendGiveUpMin, 30, 1, 24 * 60),
  breakSensitivity: pick(options.breakSensitivity, ['low', 'medium', 'high'], 'medium'),
})

// ---- Samples

export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const toSample = (
  usage: Usage,
  sentAt: number,
  at: number,
  previous: CacheSample | undefined,
): CacheSample => ({
  sentAt,
  at,
  model: usage.model,
  read: usage.cache_read_input_tokens,
  written: usage.cache_creation_input_tokens,
  uncached: usage.input_tokens,
  output: usage.output_tokens,
  idleMs: previous === undefined ? null : sentAt - previous.sentAt,
})

export const appendCapped = <T>(list: readonly T[], item: T, max: number): T[] =>
  [...list, item].slice(-max)

export const inputOf = (s: CacheSample) => s.read + s.written + s.uncached

/** Everything the next request carries: this one's input plus its output. */
export const contextOf = (s: CacheSample) => inputOf(s) + s.output

export const hitRateOf = (s: CacheSample) => {
  const input = inputOf(s)

  return input === 0 ? 0 : s.read / input
}

// ---- TTL

export const effectiveTtl = (mode: TtlMode, ttl: TtlState): Ttl =>
  mode === 'auto' ? (ttl.detected ?? '5m') : mode

export const EMPTY_TTL: TtlState = { detected: null, at: null, idleMs: null }

export const isTtlState = (value: unknown): value is TtlState =>
  typeof value === 'object' &&
  value !== null &&
  'detected' in value &&
  (value.detected === null || value.detected === '5m' || value.detected === '1h')

/**
 * Learns the TTL from one request. A solid hit after more than 5 minutes idle
 * proves 1h. Once 1h is known, a clean miss inside the hour with nothing else
 * to blame sends it back to 5m. `otherCauses` are the break causes besides idle.
 */
export const learnTtl = (
  ttl: TtlState,
  previous: CacheSample,
  sample: CacheSample,
  otherCauses: readonly BreakCause[],
): TtlState => {
  const idle = sample.idleMs

  if (idle === null || idle <= TTL_MS['5m'] + IDLE_MARGIN_MS || idle >= TTL_MS['1h'] - IDLE_MARGIN_MS) {
    return ttl
  }

  const isHit = sample.read >= MIN_PROOF_TOKENS && hitRateOf(sample) >= 0.5

  if (isHit) {
    return ttl.detected === '1h' ? ttl : { detected: '1h', at: sample.sentAt, idleMs: idle }
  }

  const wasCached = previous.read + previous.written >= MIN_PROOF_TOKENS
  const isCleanMiss = sample.read === 0 && sample.written >= MIN_PROOF_TOKENS

  if (ttl.detected === '1h' && wasCached && isCleanMiss && otherCauses.length === 0) {
    return { detected: '5m', at: sample.sentAt, idleMs: idle }
  }

  return ttl
}

// ---- Countdown

/** When the cache was last refreshed: a request sent, or an answered keep-warm fork. */
export const anchorOf = (samples: readonly CacheSample[], extensions: readonly Extension[]) => {
  const times = [
    samples.at(-1)?.sentAt ?? null,
    ...extensions.filter(x => x.isAnswered && x.read > 0).map(x => x.at),
  ].filter((t): t is number => t !== null)

  return times.length === 0 ? null : Math.max(...times)
}

export const remainingMs = (anchor: number, ttl: Ttl, now: number) => anchor + TTL_MS[ttl] - now

// ---- Breaks

export const SENSITIVITY: Record<BreakSensitivity, { minContext: number; below: number; above: number }> = {
  low: { minContext: 20_000, below: 0.3, above: 0.85 },
  medium: { minContext: 10_000, below: 0.5, above: 0.8 },
  high: { minContext: 5_000, below: 0.7, above: 0.7 },
}

export const isBreak = (previous: CacheSample, sample: CacheSample, sensitivity: BreakSensitivity) => {
  const t = SENSITIVITY[sensitivity]

  return contextOf(sample) > t.minContext && hitRateOf(sample) < t.below && hitRateOf(previous) > t.above
}

/** What changed between two requests that could have cost the cache, most likely first. */
export const guessCauses = (
  previous: CacheSample,
  sample: CacheSample,
  marks: ChangeMarks,
  ttl: Ttl,
): BreakCause[] => {
  const isBetween = (t: number | null) => t !== null && t > previous.sentAt && t <= sample.at
  const causes: BreakCause[] = []

  if (isBetween(marks.compactAt)) causes.push('compact')
  if (sample.model !== previous.model) causes.push('model')
  if (sample.idleMs !== null && sample.idleMs > TTL_MS[ttl]) causes.push('idle')
  if (isBetween(marks.systemAt)) causes.push('system')
  if (isBetween(marks.toolsAt)) causes.push('tools')

  return causes
}

export const toBreak = (previous: CacheSample, sample: CacheSample, causes: BreakCause[]): CacheBreak => ({
  at: sample.sentAt,
  hitRate: hitRateOf(sample),
  previousHitRate: hitRateOf(previous),
  rewritten: sample.written,
  causes,
})

// ---- Fingerprints of what the prompt is built from

const HASHES_PER_KEY = 8

/** FNV-1a, 32 bits. */
export const hashText = (text: string) => {
  let h = 0x811c9dc5

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return h >>> 0
}

/**
 * Records `text` among the hashes one key has seen. A change is a hash not
 * seen before: remembering several per key keeps a subagent's variant of a
 * section from reading as a change every time it alternates with the main
 * thread's.
 */
export const notePrint = (seen: readonly number[], text: string): { seen: number[]; isChange: boolean } => {
  const hash = hashText(text)

  return seen.includes(hash)
    ? { seen: [...seen], isChange: false }
    : { seen: [...seen, hash].slice(-HASHES_PER_KEY), isChange: true }
}

// ---- Summary

export const summarize = (
  samples: readonly CacheSample[],
  breaks: readonly CacheBreak[],
  extensions: readonly Extension[],
): SessionSummary => {
  const sum = (f: (s: CacheSample) => number) => samples.reduce((n, s) => n + f(s), 0)
  const read = sum(s => s.read)
  const written = sum(s => s.written)
  const uncached = sum(s => s.uncached)
  const input = read + written + uncached

  return {
    startedAt: samples[0]?.sentAt ?? null,
    endedAt: samples.at(-1)?.at ?? null,
    requests: samples.length,
    averageHitRate: input === 0 ? null : read / input,
    breaks: breaks.length,
    extensions: extensions.length,
    read,
    written,
    uncached,
    peakContext: samples.reduce((n, s) => Math.max(n, contextOf(s)), 0),
  }
}

// ---- Formatting

export const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export const formatPercent = (rate: number) => `${Math.round(rate * 100)}%`

/** m:ss, minutes unbounded (a 1h TTL reads 59:12). */
export const formatClock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const formatCauses = (causes: readonly BreakCause[], s: Strings) =>
  causes.length === 0 ? s.unknownCause : causes.map(c => s.causes[c]).join(', ')

export type StatusView = {
  samples: readonly CacheSample[]
  breaks: readonly CacheBreak[]
  extensions: readonly Extension[]
  ttl: TtlState
  mode: TtlMode
  now: number
}

/** The one-line status (temporary until the desktop band lands). */
export const formatStatus = (v: StatusView, s: Strings) => {
  const last = v.samples.at(-1)
  const anchor = anchorOf(v.samples, v.extensions)

  if (last === undefined || anchor === null) {
    return s.waiting
  }

  const ttl = effectiveTtl(v.mode, v.ttl)
  const left = remainingMs(anchor, ttl, v.now)
  const parts = [
    left > 0 ? `⚡ ${formatClock(left)}` : `⚠ ${s.expired}`,
    s.ttl(v.mode, ttl),
    `${s.hit} ${formatPercent(hitRateOf(last))}`,
    `${s.context} ${formatTokens(contextOf(last))}`,
    `${s.requests} ${v.samples.length}`,
  ]
  const lastBreak = v.breaks.at(-1)

  if (lastBreak !== undefined) {
    parts.push(`${s.breaks} ${v.breaks.length} (${formatCauses(lastBreak.causes, s)})`)
  }

  return parts.join(' · ')
}
