import type { BreakCause, Language, Ttl, TtlMode } from '../types'

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
  extending: string
  /** Expired: the next request writes the whole context again. */
  rewriteNext: (k: string) => string
  expiresIn: (clock: string) => string
  pressExtend: string
  extended: (k: string) => string
  autoExtended: (k: string) => string
  extendFailed: (reason: string) => string
  /** Alt text for the band's drawings. */
  broke: (causes: string) => string
  ringAlt: string
  sparkAlt: string
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
    extending: 'extending…',
    rewriteNext: k => `next request rewrites ${k}`,
    expiresIn: clock => `Prompt cache expires in ${clock}`,
    pressExtend: 'press Extend on the bar to keep it',
    extended: k => `Cache extended (read ${k})`,
    autoExtended: k => `Cache extended automatically (read ${k})`,
    extendFailed: reason => `Couldn't extend the cache: ${reason}`,
    broke: causes => `cache broke: ${causes}`,
    ringAlt: 'cache TTL countdown',
    sparkAlt: 'hit rate per request',
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
    extending: '延長中…',
    rewriteNext: k => `下次請求將重寫 ${k}`,
    expiresIn: clock => `快取將在 ${clock} 後過期`,
    pressExtend: '按橫條上的「延長」可保留',
    extended: k => `已延長快取（讀取 ${k}）`,
    autoExtended: k => `已自動延長快取（讀取 ${k}）`,
    extendFailed: reason => `無法延長快取：${reason}`,
    broke: causes => `快取斷掉：${causes}`,
    ringAlt: '快取 TTL 倒數',
    sparkAlt: '每次請求的命中率',
  },
}
