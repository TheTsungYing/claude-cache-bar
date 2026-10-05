import { describe, expect, test } from 'claude-code/testing'

import type { CacheSample, ChangeMarks, Extension, TtlState } from '../types'
import {
  EMPTY_TTL,
  NO_OVERRIDES,
  applyOverrides,
  chartModel,
  chartScale,
  costOf,
  countdownOf,
  formatClock,
  formatGap,
  formatTimeOfDay,
  formatStatus,
  guessCauses,
  hitLevelOf,
  isBreak,
  learnTtl,
  normalizeOverrides,
  parseCacheArgs,
  notePrint,
  readConfig,
  readoutOf,
  shortModel,
  shouldAutoExtend,
  ttlWhenSent,
  withOverride,
} from '../hooks/core'
import type { Config, StatusView } from '../hooks/core'
import { STRINGS } from '../hooks/i18n'

const SECOND = 1000
const MINUTE = 60 * SECOND
const T0 = 1_700_000_000_000

/** A request sent at `sentAt` that read `read` of `read + written + uncached`. */
const sample = (sentAt: number, read: number, written = 0, fields: Partial<CacheSample> = {}): CacheSample => ({
  sentAt,
  at: sentAt + 5 * SECOND,
  model: 'claude-opus-5-5',
  read,
  written,
  uncached: 10,
  output: 200,
  idleMs: null,
  ...fields,
})

/** A request sent `idleMs` after `previous`, as toSample records it. */
const after = (previous: CacheSample, idleMs: number, read: number, written = 0, fields: Partial<CacheSample> = {}) =>
  sample(previous.sentAt + idleMs, read, written, { idleMs, ...fields })

const extension = (at: number, fields: Partial<Extension> = {}): Extension => ({
  at,
  trigger: 'auto',
  isAnswered: true,
  reason: null,
  read: 50_000,
  written: 0,
  ...fields,
})

const NO_MARKS: ChangeMarks = { compactAt: null, systemAt: null, toolsAt: null }
const ONE_HOUR: TtlState = { detected: '1h', at: T0, idleMs: 10 * MINUTE }
const DEFAULTS = readConfig({})

describe('TTL detection', () => {
  const first = sample(T0, 50_000, 1_000)

  test('a solid hit after more than 5 minutes idle proves 1h', () => {
    const next = after(first, 6 * MINUTE, 50_000, 500)

    expect(learnTtl(EMPTY_TTL, first, next, [])).toEqual({ detected: '1h', at: next.sentAt, idleMs: 6 * MINUTE })
  })

  test('idle within the 15 s margin of 5 minutes proves nothing', () => {
    const next = after(first, 5 * MINUTE + 10 * SECOND, 50_000)

    expect(learnTtl(EMPTY_TTL, first, next, [])).toBe(EMPTY_TTL)
  })

  test('idle at or past the hour proves nothing', () => {
    const next = after(first, 59 * MINUTE + 50 * SECOND, 50_000)

    expect(learnTtl(EMPTY_TTL, first, next, [])).toBe(EMPTY_TTL)
  })

  test('a hit too small or too weak proves nothing', () => {
    const tiny = after(first, 10 * MINUTE, 1_000)
    const weak = after(first, 10 * MINUTE, 20_000, 30_000)

    expect(learnTtl(EMPTY_TTL, first, tiny, [])).toBe(EMPTY_TTL)
    expect(learnTtl(EMPTY_TTL, first, weak, [])).toBe(EMPTY_TTL)
  })

  test('once 1h, another hit keeps the same state', () => {
    const next = after(first, 20 * MINUTE, 50_000)

    expect(learnTtl(ONE_HOUR, first, next, [])).toBe(ONE_HOUR)
  })

  test('a clean miss inside the hour with nothing else to blame falls back to 5m', () => {
    const next = after(first, 10 * MINUTE, 0, 51_000)

    expect(learnTtl(ONE_HOUR, first, next, [])).toEqual({ detected: '5m', at: next.sentAt, idleMs: 10 * MINUTE })
  })

  test('a clean miss explained by another cause keeps 1h', () => {
    const next = after(first, 10 * MINUTE, 0, 51_000)

    expect(learnTtl(ONE_HOUR, first, next, ['model'])).toBe(ONE_HOUR)
  })

  test('a miss after an uncached request keeps 1h', () => {
    const cold = sample(T0, 0, 0, { uncached: 300 })
    const next = after(cold, 10 * MINUTE, 0, 51_000)

    expect(learnTtl(ONE_HOUR, cold, next, [])).toBe(ONE_HOUR)
  })
})

describe('cache breaks', () => {
  const warm = sample(T0, 50_000, 500)

  test('medium: context over 10k, hit under 50%, previous over 80%', () => {
    expect(isBreak(warm, after(warm, MINUTE, 10_000, 41_000), 'medium')).toBe(true)
    expect(isBreak(warm, after(warm, MINUTE, 30_000, 21_000), 'medium')).toBe(false)
  })

  test('a small context never counts', () => {
    const small = sample(T0, 4_000, 100)

    expect(isBreak(small, after(small, MINUTE, 0, 4_200), 'medium')).toBe(false)
    expect(isBreak(small, after(small, MINUTE, 0, 4_200), 'high')).toBe(false)
  })

  test('a weak previous hit rate means nothing broke', () => {
    const lukewarm = sample(T0, 30_000, 20_000)

    expect(isBreak(lukewarm, after(lukewarm, MINUTE, 0, 51_000), 'medium')).toBe(false)
  })

  test('sensitivity moves the thresholds', () => {
    // 40% after 99%: a break at medium and high, not at low (under 30%).
    const next = after(warm, MINUTE, 20_400, 30_600)

    expect(isBreak(warm, next, 'low')).toBe(false)
    expect(isBreak(warm, next, 'medium')).toBe(true)
    expect(isBreak(warm, next, 'high')).toBe(true)

    // 60%: only high (under 70%) counts it.
    const milder = after(warm, MINUTE, 30_600, 20_400)

    expect(isBreak(warm, milder, 'medium')).toBe(false)
    expect(isBreak(warm, milder, 'high')).toBe(true)
  })

  test('causes: compact, model, idle, system, tools, in that order', () => {
    const next = after(warm, 7 * MINUTE, 0, 51_000, { model: 'claude-sonnet-5-5' })
    const between = warm.sentAt + MINUTE
    const marks = { compactAt: between, systemAt: between, toolsAt: between }

    expect(guessCauses(warm, next, marks, '5m')).toEqual(['compact', 'model', 'idle', 'system', 'tools'])
  })

  test('causes: only changes between the two requests count', () => {
    const next = after(warm, MINUTE, 0, 51_000)
    const before = warm.sentAt - MINUTE

    expect(guessCauses(warm, next, { compactAt: before, systemAt: before, toolsAt: null }, '5m')).toEqual([])
  })

  test('causes: idle depends on the TTL in force', () => {
    const next = after(warm, 7 * MINUTE, 0, 51_000)

    expect(guessCauses(warm, next, NO_MARKS, '5m')).toEqual(['idle'])
    expect(guessCauses(warm, next, NO_MARKS, '1h')).toEqual([])
  })
})

describe('countdown', () => {
  const last = sample(T0, 50_000)

  test('phases follow warnAtPercent and alertAtPercent', () => {
    const at = (left: number) => countdownOf([last], [], '5m', EMPTY_TTL, DEFAULTS, T0 + 5 * MINUTE - left)?.phase

    expect(at(2 * MINUTE)).toBe('fresh')
    expect(at(MINUTE)).toBe('warn')
    expect(at(30 * SECOND)).toBe('alert')
    expect(at(0)).toBe('expired')
  })

  test('auto counts 5m until 1h is learned', () => {
    expect(countdownOf([last], [], 'auto', EMPTY_TTL, DEFAULTS, T0)?.ttl).toBe('5m')
    expect(countdownOf([last], [], 'auto', ONE_HOUR, DEFAULTS, T0)?.ttl).toBe('1h')
    expect(countdownOf([last], [], '5m', ONE_HOUR, DEFAULTS, T0)?.ttl).toBe('5m')
  })

  test('an answered fork that read the cache restarts it; a failed one does not', () => {
    const fork = T0 + 4 * MINUTE
    const anchor = (x: Extension) => countdownOf([last], [x], '5m', EMPTY_TTL, DEFAULTS, T0)?.anchor

    expect(anchor(extension(fork))).toBe(fork)
    expect(anchor(extension(fork, { isAnswered: false, read: 0, reason: 'x' }))).toBe(T0)
    expect(anchor(extension(fork, { read: 0 }))).toBe(T0)
  })

  test('nothing to count before the first request', () => {
    expect(countdownOf([], [], 'auto', EMPTY_TTL, DEFAULTS, T0)).toBeNull()
  })

  test('the clock reads m:ss, rounding up', () => {
    expect(formatClock(3 * MINUTE + 41_200)).toBe('3:42')
    expect(formatClock(59 * MINUTE + 12 * SECOND)).toBe('59:12')
    expect(formatClock(-5 * SECOND)).toBe('0:00')
  })
})

describe('auto-extend limits', () => {
  const last = sample(T0, 50_000)
  const auto: Config = { ...DEFAULTS, onExpiring: 'auto' }

  /** `left` before a 5m cache refreshed at `refreshedAt` expires. */
  const check = (extensions: Extension[], config = auto, left = 20 * SECOND, refreshedAt = T0) => {
    const now = refreshedAt + 5 * MINUTE - left
    const countdown = countdownOf([last], extensions, '5m', EMPTY_TTL, config, now)

    return countdown !== null && shouldAutoExtend({ samples: [last], extensions, countdown, config, now })
  }

  test('extends in auto mode once the alert threshold is reached', () => {
    expect(check([])).toBe(true)
  })

  test('not before the alert threshold, nor after expiry', () => {
    expect(check([], auto, 2 * MINUTE)).toBe(false)
    expect(check([], auto, -SECOND)).toBe(false)
  })

  test('only in auto mode', () => {
    expect(check([], { ...auto, onExpiring: 'button' })).toBe(false)
    expect(check([], { ...auto, onExpiring: 'notify' })).toBe(false)
  })

  test('at most autoExtendMaxPerIdle times per idle stretch', () => {
    const one = T0 + 5 * MINUTE - 20 * SECOND
    const two = one + 5 * MINUTE - 20 * SECOND
    const three = two + 5 * MINUTE - 20 * SECOND

    expect(check([extension(one), extension(two)], auto, 20 * SECOND, two)).toBe(true)
    expect(check([extension(one), extension(two), extension(three)], auto, 20 * SECOND, three)).toBe(false)
    expect(check([], { ...auto, autoExtendMaxPerIdle: 0 })).toBe(false)
  })

  test('extensions before the last request belong to an earlier idle stretch', () => {
    const old = [extension(T0 - 3 * MINUTE), extension(T0 - 2 * MINUTE), extension(T0 - MINUTE)]

    expect(check(old)).toBe(true)
  })

  test('not below autoExtendMinContextK', () => {
    expect(check([], { ...auto, autoExtendMinContextK: 60 })).toBe(false)
    expect(check([], { ...auto, autoExtendMinContextK: 50 })).toBe(true)
  })

  test('gives up after autoExtendGiveUpMin minutes idle; 0 never does', () => {
    expect(check([], { ...auto, autoExtendGiveUpMin: 4 })).toBe(false)
    expect(check([], { ...auto, autoExtendGiveUpMin: 5 })).toBe(true)
    expect(check([], { ...auto, autoExtendGiveUpMin: 0 })).toBe(true)
  })

  test('one try per refresh: a failed fork is not retried', () => {
    const failed = extension(T0 + 4 * MINUTE + 35 * SECOND, { isAnswered: false, read: 0, reason: 'x' })

    expect(check([failed])).toBe(false)
  })
})

describe('text status line', () => {
  const s = STRINGS.en
  const last = sample(T0, 47_000, 900, { uncached: 100, output: 200 })
  const view = (now: number, fields: Partial<StatusView> = {}): StatusView => ({
    samples: [last],
    breaks: [],
    extensions: [],
    ttl: EMPTY_TTL,
    config: { ...DEFAULTS, ttlMode: '5m' },
    isWorking: false,
    isExtending: false,
    now,
    ...fields,
  })

  test('counts down with the hit rate and context', () => {
    expect(formatStatus(view(T0 + 78 * SECOND), s)).toBe('⚡ 3:42 · 98% · 48.2k')
  })

  test('points at /cache-extend once about to expire', () => {
    expect(formatStatus(view(T0 + 4 * MINUTE + 32 * SECOND), s)).toBe('⚠ 0:28 /cache-extend · 98% · 48.2k')
  })

  test('only warns in notify mode', () => {
    const notify = view(T0 + 4 * MINUTE + 32 * SECOND, { config: { ...DEFAULTS, ttlMode: '5m', onExpiring: 'notify' } })

    expect(formatStatus(notify, s)).toBe('⚠ 0:28 · 98% · 48.2k')
  })

  test('says what an expired cache costs', () => {
    expect(formatStatus(view(T0 + 6 * MINUTE), s)).toBe('⚠ expired · next request rewrites 48.2k · 98% · 48.2k')
  })

  test('answering and extending replace the clock', () => {
    expect(formatStatus(view(T0, { isWorking: true }), s)).toBe('⚡ answering · 98% · 48.2k')
    expect(formatStatus(view(T0, { isExtending: true }), s)).toBe('⚡ extending… · 98% · 48.2k')
  })

  test('flags a break on the last request', () => {
    const breaks = [{ at: T0, hitRate: 0.1, previousHitRate: 0.9, rewritten: 40_000, causes: ['model' as const] }]

    expect(formatStatus(view(T0 + 78 * SECOND, { breaks }), s)).toBe(
      '⚡ 3:42 · 98% · 48.2k · ⚠ cache broke: model switched',
    )
  })

  test('waits for the first request', () => {
    expect(formatStatus(view(T0, { samples: [] }), STRINGS['zh-TW'])).toBe('⚡ 等待第一次回應')
  })
})

describe('settings', () => {
  test('odd option values fall back to the defaults, numbers are clamped', () => {
    const config = readConfig({ language: 'fr', ttlMode: '1h', warnAtPercent: 500, alertAtPercent: 'x' })

    expect(config.language).toBe('en')
    expect(config.ttlMode).toBe('1h')
    expect(config.warnAtPercent).toBe(99)
    expect(config.alertAtPercent).toBe(10)
  })

  test('a panel pick stands while the userConfig value it replaced does', () => {
    const picked = withOverride(NO_OVERRIDES, DEFAULTS, 'onExpiring', 'auto')

    expect(applyOverrides(DEFAULTS, picked).onExpiring).toBe('auto')
    expect(applyOverrides({ ...DEFAULTS, onExpiring: 'notify' }, picked).onExpiring).toBe('notify')
  })

  test('picking the userConfig value again clears the override', () => {
    const picked = withOverride(NO_OVERRIDES, DEFAULTS, 'ttlMode', '1h')

    expect(withOverride(picked, DEFAULTS, 'ttlMode', 'auto')).toEqual(NO_OVERRIDES)
  })

  test('the band can be turned off in the panel and back on', () => {
    const off = withOverride(NO_OVERRIDES, DEFAULTS, 'band', 'off')

    expect(DEFAULTS.band).toBe('compact')
    expect(applyOverrides(DEFAULTS, off).band).toBe('off')
    expect(withOverride(off, DEFAULTS, 'band', 'compact')).toEqual(NO_OVERRIDES)
  })

  test('the language can be switched and switched back', () => {
    const zh = withOverride(NO_OVERRIDES, DEFAULTS, 'language', 'zh-TW')

    expect(applyOverrides(DEFAULTS, zh).language).toBe('zh-TW')
    expect(applyOverrides({ ...DEFAULTS, language: 'zh-TW' }, zh).language).toBe('zh-TW')
    expect(withOverride(zh, DEFAULTS, 'language', 'en')).toEqual(NO_OVERRIDES)
    expect(withOverride(NO_OVERRIDES, DEFAULTS, 'language', 'fr')).toEqual(NO_OVERRIDES)
  })

  test('picks saved before the band and language settings existed are kept', () => {
    const saved = { onExpiring: { value: 'auto', over: 'button' }, ttlMode: null }

    expect(normalizeOverrides(saved)).toEqual({ ...saved, band: null, language: null })
    expect(normalizeOverrides({ ...saved, band: null })).toEqual({ ...saved, band: null, language: null })
  })

  test('picks held in an older shape apply without the newer fields', () => {
    const old = normalizeOverrides({ onExpiring: null, ttlMode: null, band: { value: 'off', over: 'compact' } })

    expect(old).not.toBe(null)
    expect(applyOverrides(DEFAULTS, old ?? NO_OVERRIDES)).toEqual({ ...DEFAULTS, band: 'off' })
  })

  test('a malformed saved pick reads as none', () => {
    expect(normalizeOverrides(null)).toBe(null)
    expect(normalizeOverrides({ onExpiring: null })).toBe(null)
    expect(normalizeOverrides({ onExpiring: null, ttlMode: null, band: { value: 'big', over: 'compact' } })).toBe(null)
    expect(normalizeOverrides({ ...NO_OVERRIDES, language: { value: 'fr', over: 'en' } })).toBe(null)
  })
})

describe('/cache arguments', () => {
  test('nothing opens the panel', () => {
    expect(parseCacheArgs('', 'en')).toEqual({ kind: 'open' })
    expect(parseCacheArgs('   ', 'en')).toEqual({ kind: 'open' })
  })

  test('lang names a language by code or by name', () => {
    expect(parseCacheArgs('lang zh-TW', 'en')).toEqual({ kind: 'language', language: 'zh-TW' })
    expect(parseCacheArgs(' LANG  zh ', 'en')).toEqual({ kind: 'language', language: 'zh-TW' })
    expect(parseCacheArgs('language 中文', 'en')).toEqual({ kind: 'language', language: 'zh-TW' })
    expect(parseCacheArgs('lang English', 'zh-TW')).toEqual({ kind: 'language', language: 'en' })
  })

  test('lang alone switches to the other language', () => {
    expect(parseCacheArgs('lang', 'en')).toEqual({ kind: 'language', language: 'zh-TW' })
    expect(parseCacheArgs('lang', 'zh-TW')).toEqual({ kind: 'language', language: 'en' })
  })

  test('anything else is unknown', () => {
    expect(parseCacheArgs('lang fr', 'en')).toEqual({ kind: 'unknown' })
    expect(parseCacheArgs('lang en now', 'en')).toEqual({ kind: 'unknown' })
    expect(parseCacheArgs('extend', 'en')).toEqual({ kind: 'unknown' })
  })
})

describe('prompt fingerprints', () => {
  test('a text seen before is no change, even after another one', () => {
    const a = notePrint([], 'main')
    const b = notePrint(a.seen, 'subagent')
    const c = notePrint(b.seen, 'main')

    expect([a.isChange, b.isChange, c.isChange]).toEqual([true, true, false])
  })
})

describe('panel chart', () => {
  const first = sample(T0, 0, 50_000)

  test('a request bills writes at the TTL known when it was sent', () => {
    const later = after(first, 10 * MINUTE, 50_000, 1_000)

    expect(ttlWhenSent(later, '5m', ONE_HOUR)).toBe('5m')
    expect(ttlWhenSent(first, 'auto', EMPTY_TTL)).toBe(null)
    expect(ttlWhenSent(sample(T0 - MINUTE, 0, 50_000), 'auto', ONE_HOUR)).toBe(null)
    expect(ttlWhenSent(later, 'auto', ONE_HOUR)).toBe('1h')
  })

  test('cost weighs reads at 0.1 and writes at 1.25 or 2', () => {
    const s = sample(T0, 100_000, 1_000)

    expect(costOf(s, '5m')).toEqual({ read: 10_000, written: 1_250, uncached: 10 })
    expect(costOf(s, '1h')).toEqual({ read: 10_000, written: 2_000, uncached: 10 })
    expect(costOf(s, null)).toEqual(costOf(s, '5m'))
  })

  test('the scale caps below the bars that dwarf the 90th percentile, and only then', () => {
    const everyday = Array.from({ length: 19 }, (_, i) => 1_000 + i * 100)

    expect(chartScale([1_000, 50_000])).toEqual({ top: 50_000, isCapped: false })
    expect(chartScale([...everyday, 60_000])).toEqual({ top: 2_800, isCapped: true })
    expect(chartScale([...everyday, 5_000])).toEqual({ top: 5_000, isCapped: false })
    expect(chartScale(Array.from({ length: 12 }, () => 0))).toEqual({ top: 0, isCapped: false })
  })

  test('the strip colours only a slipped or broken hit rate', () => {
    expect(hitLevelOf(first, false)).toBe('ok')
    expect(hitLevelOf(after(first, MINUTE, 97_000, 2_990), false)).toBe('ok')
    expect(hitLevelOf(after(first, MINUTE, 90_000, 9_990), false)).toBe('dip')
    expect(hitLevelOf(after(first, MINUTE, 50_000, 49_990), false)).toBe('low')
    expect(hitLevelOf(after(first, MINUTE, 97_000, 2_990), true)).toBe('broke')
  })

  test('bars carry their number, idle gaps and the keep-warm forks between them', () => {
    const list = [first]

    for (let i = 1; i < 6; i++) {
      list.push(after(list[i - 1]!, i === 3 ? 12 * MINUTE : MINUTE, 50_000, 500))
    }

    const third = list[2]!
    const extensions = [
      extension(third.sentAt + 4 * MINUTE),
      extension(third.sentAt + 5 * MINUTE, { isAnswered: false, reason: 'busy', read: 0 }),
      extension(list[5]!.sentAt + MINUTE),
    ]
    const model = chartModel(list, [], extensions, 'auto', EMPTY_TTL, 4)

    expect(model.bars.map(b => b.number)).toEqual([3, 4, 5, 6])
    expect(model.bars.map(b => b.gapMs)).toEqual([null, 12 * MINUTE, null, null])
    expect(model.bars.map(b => b.extensionsBefore)).toEqual([0, 1, 0, 0])
    expect(model.extensionsAfter).toBe(1)
    expect(model.bars.map(b => b.isLatest)).toEqual([false, false, false, true])
    expect(model.bars.every(b => !b.isTtlKnown)).toBe(true)
  })

  test('a clipped bar fills the plot and says so', () => {
    // Warm from the start: a cold first write would be a second tall bar.
    const list = [sample(T0, 50_000, 500)]

    for (let i = 1; i < 12; i++) {
      list.push(after(list[i - 1]!, MINUTE, 50_000, 500))
    }

    const broke = after(list.at(-1)!, MINUTE, 0, 50_500)
    const model = chartModel([...list, broke], [], [], '5m', EMPTY_TTL, 40)
    const last = model.bars.at(-1)!

    expect(model.isCapped).toBe(true)
    expect([last.height, last.isClipped, last.isTtlKnown]).toEqual([1, true, true])
    expect(model.bars.filter(b => b.isClipped)).toHaveLength(1)
  })

  test('the readout tells when, after how much idle, and what it cost', () => {
    const sentAt = new Date(2026, 9, 5, 14, 32, 5).getTime()
    const previous = sample(sentAt - 130 * SECOND, 140_000, 1_000)
    const s = after(previous, 130 * SECOND, 147_200, 1_800, { uncached: 3 })
    const extensions = [extension(sentAt - MINUTE)]
    const model = chartModel([previous, s], [], extensions, '5m', EMPTY_TTL, 40)

    expect(readoutOf(model.bars[1]!, STRINGS['zh-TW'])).toEqual([
      '#2 · 14:32:05 · 閒置 2:10 · 延長 ×1',
      '等效 17.0k · 寫入 1.8k · 未命中 3 · 讀取 147.2k · 命中 98.8%',
    ])
  })

  test('a guessed write weight reads ≈, a new model and a break say so', () => {
    const s = sample(T0, 147_200, 1_800, { uncached: 3 })
    const broke = after(s, 2 * MINUTE, 0, 148_000, { model: 'claude-haiku-4-5-20251001' })
    const cause = { at: broke.sentAt, hitRate: 0, previousHitRate: 0.99, rewritten: 148_000, causes: ['model' as const] }
    const model = chartModel([s, broke], [cause], [], 'auto', EMPTY_TTL, 40)
    const en = STRINGS.en

    expect(readoutOf(model.bars[0]!, en)[1]).toMatch(/^cost ≈17\.0k · /)
    expect(readoutOf(model.bars[1]!, en)[0]).toMatch(/ · idle 2:00 · → haiku-4-5$/)
    expect(readoutOf(model.bars[1]!, en)[1]).toBe(`break · rewrote 148.0k · likely: ${en.causes.model}`)
  })

  test('model ids lose the claude- prefix and a date', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
    expect(formatTimeOfDay(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('03:04:05')
  })

  test('idle gaps read in minutes, then hours', () => {
    expect(formatGap(12 * MINUTE + 30 * SECOND)).toBe('12m')
    expect(formatGap(65 * MINUTE)).toBe('1h05')
  })
})
