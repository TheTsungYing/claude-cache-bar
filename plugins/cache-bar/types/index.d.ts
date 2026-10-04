/** One main-thread model request's prompt cache usage. */
export type CacheSample = {
  /** When the response arrived, ms since the epoch. */
  at: number
  model: string
  /** Input tokens served from the cache. */
  read: number
  /** Input tokens written to the cache. */
  written: number
  /** Input tokens neither read from nor written to the cache. */
  uncached: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-bar': { last: CacheSample | null }
  }
}
