export type Language = 'en' | 'zh-TW'

/** The TTL setting: `auto` infers it from what the cache does. */
export type TtlMode = 'auto' | '5m' | '1h'

export type Ttl = '5m' | '1h'

export type BreakSensitivity = 'low' | 'medium' | 'high'

export type OnExpiring = 'notify' | 'button' | 'auto'

/** The desktop band above the prompt: compact, or not drawn at all. */
export type BandMode = 'compact' | 'off'

/**
 * A setting picked in the panel or with `/cache lang` where `$.config` has
 * no row for it (a plugin folder on desktop). It stands while the `userConfig`
 * value it replaced, `over`, is unchanged: a later change in settings wins.
 */
export type Override<T> = { value: T; over: T }

export type Overrides = {
  onExpiring: Override<OnExpiring> | null
  ttlMode: Override<TtlMode> | null
  band: Override<BandMode> | null
  language: Override<Language> | null
}

/** One main-thread model request's prompt cache usage. */
export type CacheSample = {
  /** When the request was sent, ms since the epoch. The cache refreshes here. */
  sentAt: number
  /** When the response arrived, ms since the epoch. */
  at: number
  model: string
  /** Input tokens served from the cache. */
  read: number
  /** Input tokens written to the cache. */
  written: number
  /** Input tokens neither read from nor written to the cache. */
  uncached: number
  output: number
  /** Time since the previous request was sent, ms; null for the first one. */
  idleMs: number | null
}

/** What the plugin has learned about the cache TTL. Persisted in `$.store`. */
export type TtlState = {
  /** `1h` once a hit after more than 5 minutes idle proved it; null until then. */
  detected: Ttl | null
  /** When `detected` was last set, ms since the epoch. */
  at: number | null
  /** The idle gap that proved it, ms. */
  idleMs: number | null
}

/** A guess at why a cache break happened. */
export type BreakCause = 'idle' | 'model' | 'compact' | 'system' | 'tools'

/** A request that read far less of the cache than the one before it. */
export type CacheBreak = {
  /** The breaking request's `sentAt`. */
  at: number
  /** Hit rate of this request and the one before it, 0..1. */
  hitRate: number
  previousHitRate: number
  /** Tokens written again because the cache missed. */
  rewritten: number
  /** Likely causes, most likely first; empty when none fits. */
  causes: BreakCause[]
}

/** One keep-warm request made through `$.model.fork`. */
export type Extension = {
  at: number
  trigger: 'manual' | 'auto'
  isAnswered: boolean
  /** Why it got no answer, when `isAnswered` is false. */
  reason: string | null
  read: number
  written: number
}

/** Things that can break the cache when they change. */
export type ChangeKind = 'compact' | 'system' | 'tools'

/** When things that can break the cache last changed, ms since the epoch. */
export type ChangeMarks = {
  compactAt: number | null
  /** A system prompt section or the CLAUDE.md context block changed. */
  systemAt: number | null
  /** A tool appeared or its description changed. */
  toolsAt: number | null
}

/**
 * One conversation's totals. Reserved for a cross-session history kept in
 * `$.store`; for now computed from this session's state.
 */
export type SessionSummary = {
  startedAt: number | null
  endedAt: number | null
  requests: number
  /** Hit rate over all input tokens, 0..1; null with no requests. */
  averageHitRate: number | null
  breaks: number
  extensions: number
  /** Totals over all requests. */
  read: number
  written: number
  uncached: number
  peakContext: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-bar': {
      /** This session's main-thread requests, oldest first, capped. */
      samples: CacheSample[]
      breaks: CacheBreak[]
      extensions: Extension[]
      ttl: TtlState
      /**
       * When each ChangeKind last changed (the id), ms since the epoch; null
       * for never. One member each, so concurrent hooks never contend.
       */
      changedAt: StateFamily<number | null>
      /**
       * Hashes seen per prompt section, context block and tool (the id, as
       * `section:<name>`, `context:<name>`, `tool:<name>`).
       */
      prints: StateFamily<number[]>
      /** The clock, written every second; read by drawings without Svg (the terminal panel). */
      now: number
      /**
       * The countdown's stage: `working`, `none`, or `<anchor>|<ttl>|<phase>`.
       * Written when it changes; the band and panel redraw on it, not on `now`,
       * since a redraw every second resets an open Select's highlight.
       */
      stage: string
      /** Settings picked in the panel; also kept in `$.store`. */
      overrides: Overrides
      /** True while a keep-warm fork is in flight. */
      extending: boolean
      /**
       * The `sentAt` of the request whose idle stretch already got its expiry
       * notice; null before any. One notice per idle stretch.
       */
      alertedFor: number | null
    }
  }
}
