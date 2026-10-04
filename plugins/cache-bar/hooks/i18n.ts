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
  },
}
