import type { BandMode, BreakCause, Language, Ttl, TtlMode } from '../types'

export type Strings = {
  waiting: string
  expired: string
  hit: string
  context: string
  requests: string
  breaks: string
  ttl: (mode: TtlMode, ttl: Ttl) => string
  causes: Record<BreakCause, string>
  unknownCause: string
  working: string
  /** The extend button: `k` is the context it would read, formatted. */
  extend: (k: string) => string
  /** The band's extend button, kept short. */
  extendShort: string
  extending: string
  /** Expired: the next request writes the whole context again. */
  rewriteNext: (k: string) => string
  expiresIn: (clock: string) => string
  pressExtend: string
  /** The same hint where there is no band to press: run the command. */
  runExtend: (command: string) => string
  extended: (k: string) => string
  autoExtended: (k: string) => string
  extendFailed: (reason: string) => string
  /** Alt text for the band's drawings. */
  broke: (causes: string) => string
  ringAlt: string
  sparkAlt: string
  /** The side panel. */
  paneTitle: string
  commandDescription: string
  extendCommandDescription: string
  /** `/cache-extend` with nothing to do. */
  extendNothing: string
  extendBusy: string
  extendAlready: string
  /** The band's button that opens the panel. */
  details: string
  paneUnplaced: (reason: string) => string
  /** How the TTL was learned: a hit after `minutes` idle proved it. */
  ttlLearned: (ttl: Ttl, minutes: number) => string
  ttlAssumed: string
  lastHit: string
  summaryTitle: string
  averageHit: string
  extensionsCount: string
  peakContext: string
  chartTitle: string
  chartAlt: string
  legend: { read: string; written: string; uncached: string; rate: string; broke: string }
  breaksTitle: string
  noBreaks: string
  /** One break: request number, hit rate before and after, tokens rewritten. */
  breakLine: (n: number | null, before: string, after: string, k: string) => string
  extensionsTitle: string
  noExtensions: string
  /** Neither a break nor an extension yet. */
  quietHistory: string
  trigger: { manual: string; auto: string }
  extensionRead: (k: string) => string
  extensionFailed: (reason: string) => string
  settingsTitle: string
  onExpiringLabel: string
  onExpiringOptions: Record<'notify' | 'button' | 'auto', string>
  ttlModeLabel: string
  ttlModeOptions: Record<TtlMode, string>
  bandLabel: string
  bandOptions: Record<BandMode, string>
  settingFailed: (reason: string) => string
  /** When an extension ran: `clock` idle since the last request. */
  idleAt: (clock: string) => string
}

const ttl = (mode: TtlMode, value: Ttl) => (mode === 'auto' ? `auto→${value}` : value)

export const STRINGS: Record<Language, Strings> = {
  en: {
    waiting: 'waiting for the first response',
    expired: 'expired',
    hit: 'hit',
    context: 'ctx',
    requests: 'req',
    breaks: 'breaks',
    ttl,
    causes: {
      idle: 'idle past TTL',
      model: 'model switched',
      compact: 'compacted',
      system: 'system prompt or CLAUDE.md changed',
      tools: 'tool list changed',
    },
    unknownCause: 'cause unknown',
    working: 'answering',
    extend: k => `Extend · ~${k} read`,
    extendShort: 'Extend',
    extending: 'extending…',
    rewriteNext: k => `next request rewrites ${k}`,
    expiresIn: clock => `Prompt cache expires in ${clock}`,
    pressExtend: 'press Extend on the bar to keep it',
    runExtend: command => `run /${command} to keep it`,
    extended: k => `Cache extended (read ${k})`,
    autoExtended: k => `Cache extended automatically (read ${k})`,
    extendFailed: reason => `Couldn't extend the cache: ${reason}`,
    broke: causes => `cache broke: ${causes}`,
    ringAlt: 'cache TTL countdown',
    sparkAlt: 'hit rate per request',
    paneTitle: 'Prompt cache',
    commandDescription: 'Open the prompt cache panel',
    extendCommandDescription: 'Keep the prompt cache warm now',
    extendNothing: 'Nothing is cached yet: no request has been sent',
    extendBusy: 'Claude is answering: each request refreshes the cache',
    extendAlready: 'Already extending the cache',
    details: 'Details',
    paneUnplaced: reason => `Couldn't open the cache panel: ${reason}`,
    ttlLearned: (value, minutes) => `${value} detected: a hit after ${minutes}m idle`,
    ttlAssumed: '5m assumed until a hit after 5m idle proves 1h',
    lastHit: 'last hit',
    summaryTitle: 'This conversation',
    averageHit: 'avg hit',
    extensionsCount: 'extended',
    peakContext: 'peak ctx',
    chartTitle: 'Per request',
    chartAlt: 'cache read, write and miss per request, with the hit rate',
    legend: { read: 'read', written: 'write', uncached: 'miss', rate: 'hit rate', broke: 'break' },
    breaksTitle: 'Cache breaks',
    noBreaks: 'none',
    breakLine: (n, before, after, k) => `${n === null ? '' : `request #${n} · `}${before} → ${after} · rewrote ${k}`,
    extensionsTitle: 'Extensions',
    noExtensions: 'none',
    quietHistory: 'No breaks · no extensions',
    trigger: { manual: 'manual', auto: 'auto' },
    extensionRead: k => `read ${k}`,
    extensionFailed: reason => `failed: ${reason}`,
    settingsTitle: 'Settings',
    onExpiringLabel: 'When about to expire',
    onExpiringOptions: { notify: 'Notify only', button: 'Notify + Extend button', auto: 'Extend automatically' },
    ttlModeLabel: 'Cache TTL',
    ttlModeOptions: { auto: 'Auto-detect', '5m': '5 minutes', '1h': '1 hour' },
    bandLabel: 'Band above the prompt',
    bandOptions: { compact: 'Compact', off: 'Off' },
    settingFailed: reason => `Couldn't change the setting: ${reason}`,
    idleAt: clock => `${clock} idle`,
  },
  'zh-TW': {
    waiting: '等待第一次回應',
    expired: '已過期',
    hit: '命中',
    context: '上下文',
    requests: '請求',
    breaks: '斷掉',
    ttl,
    causes: {
      idle: '閒置超過 TTL',
      model: '剛換模型',
      compact: '剛 compact',
      system: 'system prompt 或 CLAUDE.md 變動',
      tools: '工具清單變動',
    },
    unknownCause: '原因不明',
    working: '回覆中',
    extend: k => `延長 · ~${k} 讀取`,
    extendShort: '延長',
    extending: '延長中…',
    rewriteNext: k => `下次請求將重寫 ${k}`,
    expiresIn: clock => `快取將在 ${clock} 後過期`,
    pressExtend: '按橫條上的「延長」可保留',
    runExtend: command => `輸入 /${command} 可保留`,
    extended: k => `已延長快取（讀取 ${k}）`,
    autoExtended: k => `已自動延長快取（讀取 ${k}）`,
    extendFailed: reason => `無法延長快取：${reason}`,
    broke: causes => `快取斷掉：${causes}`,
    ringAlt: '快取 TTL 倒數',
    sparkAlt: '每次請求的命中率',
    paneTitle: 'Prompt 快取',
    commandDescription: '開啟 prompt 快取面板',
    extendCommandDescription: '立即延長 prompt 快取',
    extendNothing: '還沒有送出請求，沒有可延長的快取',
    extendBusy: '回覆中：每次請求都會讓快取重新計時',
    extendAlready: '正在延長快取',
    details: '詳細',
    paneUnplaced: reason => `無法開啟快取面板：${reason}`,
    ttlLearned: (value, minutes) => `判定為 ${value}：閒置 ${minutes} 分鐘後仍命中`,
    ttlAssumed: '先當 5m，閒置超過 5 分鐘後仍命中才判定為 1h',
    lastHit: '上次命中',
    summaryTitle: '本次對話',
    averageHit: '平均命中',
    extensionsCount: '延長',
    peakContext: '最大上下文',
    chartTitle: '每次請求',
    chartAlt: '每次請求的快取讀取、寫入、未命中與命中率',
    legend: { read: '讀取', written: '寫入', uncached: '未命中', rate: '命中率', broke: '斷掉' },
    breaksTitle: '快取斷掉',
    noBreaks: '無',
    breakLine: (n, before, after, k) => `${n === null ? '' : `第 ${n} 次請求 · `}${before} → ${after} · 重寫 ${k}`,
    extensionsTitle: '延長紀錄',
    noExtensions: '無',
    quietHistory: '無斷掉 · 無延長',
    trigger: { manual: '手動', auto: '自動' },
    extensionRead: k => `讀取 ${k}`,
    extensionFailed: reason => `失敗：${reason}`,
    settingsTitle: '設定',
    onExpiringLabel: '快過期時',
    onExpiringOptions: { notify: '只通知', button: '通知 + 延長按鈕', auto: '自動延長' },
    ttlModeLabel: '快取 TTL',
    ttlModeOptions: { auto: '自動偵測', '5m': '5 分鐘', '1h': '1 小時' },
    bandLabel: '輸入框上方橫條',
    bandOptions: { compact: '精簡', off: '關閉' },
    settingFailed: reason => `無法變更設定：${reason}`,
    idleAt: clock => `閒置 ${clock} 時`,
  },
}
