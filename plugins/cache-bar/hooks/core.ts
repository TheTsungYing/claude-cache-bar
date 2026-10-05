// Pure logic over plain data: no `$` here, so tests can call it directly.

import type {
  BandMode,
  BreakCause,
  BreakSensitivity,
  CacheBreak,
  CacheSample,
  ChangeMarks,
  Extension,
  Language,
  OnExpiring,
  Overrides,
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

export type { BandMode, OnExpiring }

export type Config = {
  language: Language
  ttlMode: TtlMode
  onExpiring: OnExpiring
  band: BandMode
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
  band: pick(options.band, ['compact', 'off'], 'compact'),
  warnAtPercent: clamp(options.warnAtPercent, 20, 1, 99),
  alertAtPercent: clamp(options.alertAtPercent, 10, 1, 99),
  toast: typeof options.toast === 'boolean' ? options.toast : true,
  autoExtendMaxPerIdle: clamp(options.autoExtendMaxPerIdle, 3, 0, 100),
  autoExtendMinContextK: clamp(options.autoExtendMinContextK, 20, 0, 10_000),
  autoExtendGiveUpMin: clamp(options.autoExtendGiveUpMin, 0, 0, 24 * 60),
  breakSensitivity: pick(options.breakSensitivity, ['low', 'medium', 'high'], 'medium'),
})

// ---- Settings picked in the panel

export const NO_OVERRIDES: Overrides = { onExpiring: null, ttlMode: null, band: null }

const ON_EXPIRING: readonly OnExpiring[] = ['notify', 'button', 'auto']
const TTL_MODES: readonly TtlMode[] = ['auto', '5m', '1h']
const BAND_MODES: readonly BandMode[] = ['compact', 'off']

const isOverride = <T extends string>(value: unknown, allowed: readonly T[]) =>
  value === null ||
  (typeof value === 'object' &&
    'value' in value &&
    'over' in value &&
    allowed.some(a => a === value.value) &&
    allowed.some(a => a === value.over))

/**
 * A `$.store` value as Overrides, or null when it is malformed. A field saved
 * before it existed (`band`) reads as no override, so an upgrade keeps the rest.
 */
export const normalizeOverrides = (value: unknown): Overrides | null => {
  if (typeof value !== 'object' || value === null || !('onExpiring' in value) || !('ttlMode' in value)) {
    return null
  }

  const band = 'band' in value ? value.band : null

  if (!isOverride(value.onExpiring, ON_EXPIRING) || !isOverride(value.ttlMode, TTL_MODES) || !isOverride(band, BAND_MODES)) {
    return null
  }

  return {
    onExpiring: value.onExpiring as Overrides['onExpiring'],
    ttlMode: value.ttlMode as Overrides['ttlMode'],
    band: band as Overrides['band'],
  }
}

/** The settings in force: each override while the value it replaced still stands. */
export const applyOverrides = (base: Config, o: Overrides): Config => ({
  ...base,
  onExpiring: o.onExpiring !== null && o.onExpiring.over === base.onExpiring ? o.onExpiring.value : base.onExpiring,
  ttlMode: o.ttlMode !== null && o.ttlMode.over === base.ttlMode ? o.ttlMode.value : base.ttlMode,
  band: o.band !== null && o.band.over === base.band ? o.band.value : base.band,
})

export type QuickSetting = keyof Overrides

/** Records a pick; picking the `userConfig` value again clears the override. */
export const withOverride = (o: Overrides, base: Config, field: QuickSetting, value: string): Overrides => {
  if (field === 'onExpiring') {
    const picked = pick(value, ON_EXPIRING, base.onExpiring)

    return { ...o, onExpiring: picked === base.onExpiring ? null : { value: picked, over: base.onExpiring } }
  }

  if (field === 'band') {
    const picked = pick(value, BAND_MODES, base.band)

    return { ...o, band: picked === base.band ? null : { value: picked, over: base.band } }
  }

  const picked = pick(value, TTL_MODES, base.ttlMode)

  return { ...o, ttlMode: picked === base.ttlMode ? null : { value: picked, over: base.ttlMode } }
}

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

/** fresh, then warn and alert as the TTL runs low, then expired. */
export type Phase = 'fresh' | 'warn' | 'alert' | 'expired'

export type Countdown = {
  anchor: number
  ttl: Ttl
  totalMs: number
  leftMs: number
  /** How much of the TTL is left at `warnAtPercent` and `alertAtPercent`, ms. */
  warnMs: number
  alertMs: number
  phase: Phase
}

export const phaseOf = (leftMs: number, warnMs: number, alertMs: number): Phase =>
  leftMs <= 0 ? 'expired' : leftMs <= alertMs ? 'alert' : leftMs <= warnMs ? 'warn' : 'fresh'

/** Where the countdown stands; null before the first request. */
export const countdownOf = (
  samples: readonly CacheSample[],
  extensions: readonly Extension[],
  mode: TtlMode,
  learned: TtlState,
  config: Pick<Config, 'warnAtPercent' | 'alertAtPercent'>,
  now: number,
): Countdown | null => {
  const anchor = anchorOf(samples, extensions)

  if (anchor === null) {
    return null
  }

  const ttl = effectiveTtl(mode, learned)
  const totalMs = TTL_MS[ttl]
  const leftMs = remainingMs(anchor, ttl, now)
  const warnMs = (totalMs * config.warnAtPercent) / 100
  const alertMs = (totalMs * Math.min(config.alertAtPercent, config.warnAtPercent)) / 100

  return { anchor, ttl, totalMs, leftMs, warnMs, alertMs, phase: phaseOf(leftMs, warnMs, alertMs) }
}

// ---- Keeping the cache warm

/** The one user message a keep-warm fork sends after the cached prefix. */
export const KEEP_WARM_PROMPT = 'Reply with the single word: ok'

type ForkUsage = Pick<Usage, 'cache_read_input_tokens' | 'cache_creation_input_tokens'>

/** What `$.model.fork` resolved to, as far as an Extension needs it. */
export type ForkOutcome =
  | { isAnswered: true; usage: ForkUsage }
  | { isAnswered: false; reason: string; usage?: ForkUsage }

/** `at` is when the fork was sent: the cache refreshes there. */
export const toExtension = (outcome: ForkOutcome, at: number, trigger: Extension['trigger']): Extension => ({
  at,
  trigger,
  isAnswered: outcome.isAnswered,
  reason: outcome.isAnswered ? null : outcome.reason,
  read: outcome.usage?.cache_read_input_tokens ?? 0,
  written: outcome.usage?.cache_creation_input_tokens ?? 0,
})

/** Extensions tried since the last real request: this idle stretch's. */
export const extensionsThisIdle = (samples: readonly CacheSample[], extensions: readonly Extension[]) => {
  const since = samples.at(-1)?.sentAt ?? Number.NEGATIVE_INFINITY

  return extensions.filter(x => x.at > since)
}

export type AutoExtendCheck = {
  samples: readonly CacheSample[]
  extensions: readonly Extension[]
  countdown: Countdown
  config: Pick<Config, 'onExpiring' | 'autoExtendMaxPerIdle' | 'autoExtendMinContextK' | 'autoExtendGiveUpMin'>
  now: number
}

/**
 * Whether to extend on its own now: in `auto` mode, once the alert threshold
 * is reached and before expiry, within the three limits (a give-up time of 0
 * means none), and at most one try per refresh (a failed fork leaves the
 * anchor where it was; no retry storm).
 */
export const shouldAutoExtend = ({ samples, extensions, countdown, config, now }: AutoExtendCheck) => {
  const last = samples.at(-1)

  if (config.onExpiring !== 'auto' || last === undefined || countdown.phase !== 'alert') {
    return false
  }

  const tried = extensionsThisIdle(samples, extensions)

  return (
    tried.length < config.autoExtendMaxPerIdle &&
    contextOf(last) >= config.autoExtendMinContextK * 1000 &&
    (config.autoExtendGiveUpMin === 0 || now - last.sentAt < config.autoExtendGiveUpMin * MINUTE) &&
    tried.every(x => x.at <= countdown.anchor)
  )
}

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

// ---- Hit-rate history

/** The last `count` samples' hit rates, each with whether it broke the cache. */
export const recentHits = (samples: readonly CacheSample[], breaks: readonly CacheBreak[], count: number) => {
  const broke = new Set(breaks.map(b => b.at))

  return samples.slice(-count).map(s => ({ rate: hitRateOf(s), isBreak: broke.has(s.sentAt) }))
}

/** The last `count` samples as the panel chart's stacked bars. */
export const chartBars = (samples: readonly CacheSample[], breaks: readonly CacheBreak[], count: number) => {
  const broke = new Set(breaks.map(b => b.at))

  return samples.slice(-count).map(s => ({
    read: s.read,
    written: s.written,
    uncached: s.uncached,
    rate: hitRateOf(s),
    isBreak: broke.has(s.sentAt),
  }))
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

/** The slash command that keeps the cache warm, without its slash. */
export const EXTEND_COMMAND = 'cache-extend'

export type StatusView = {
  samples: readonly CacheSample[]
  breaks: readonly CacheBreak[]
  extensions: readonly Extension[]
  ttl: TtlState
  config: Pick<Config, 'ttlMode' | 'onExpiring' | 'warnAtPercent' | 'alertAtPercent'>
  isWorking: boolean
  isExtending: boolean
  now: number
}

/**
 * The one-line status for the terminal and VS Code: `⚡ 3:42 · 94% · 48.2k`,
 * and `⚠ 0:28 /cache-extend` once the cache is about to expire.
 */
export const formatStatus = (v: StatusView, s: Strings) => {
  const last = v.samples.at(-1)
  const countdown = countdownOf(v.samples, v.extensions, v.config.ttlMode, v.ttl, v.config, v.now)

  if (last === undefined || countdown === null) {
    return `⚡ ${s.waiting}`
  }

  const context = formatTokens(contextOf(last))
  const tail = [formatPercent(hitRateOf(last)), context]
  const lastBreak = v.breaks.at(-1)

  if (lastBreak !== undefined && lastBreak.at === last.sentAt) {
    tail.push(`⚠ ${s.broke(formatCauses(lastBreak.causes, s))}`)
  }

  const clock = formatClock(countdown.leftMs)
  const head = v.isExtending
    ? `⚡ ${s.extending}`
    : v.isWorking
      ? `⚡ ${s.working}`
      : countdown.phase === 'expired'
        ? `⚠ ${s.expired} · ${s.rewriteNext(context)}`
        : countdown.phase === 'alert' && v.config.onExpiring !== 'notify'
          ? `⚠ ${clock} /${EXTEND_COMMAND}`
          : countdown.phase === 'fresh'
            ? `⚡ ${clock}`
            : `⚠ ${clock}`

  return [head, ...tail].join(' · ')
}
