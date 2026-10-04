import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheSample } from '../types'

const last = atom({ plugin: 'cache-bar', key: 'last' } as const, null)

const formatTokens = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

// Placeholder display until the UI design is settled.
const formatStatus = (s: CacheSample) => {
  const total = s.read + s.written + s.uncached
  const hit = total === 0 ? 0 : Math.round((s.read / total) * 100)

  return `cache ${hit}% · read ${formatTokens(s.read)} / write ${formatTokens(s.written)}`
}

export const register: Register = on => {
  // Record the main thread's cache usage after each model request.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)

    if (e.agentId === undefined && step.usage !== null) {
      const sample: CacheSample = {
        at: await $.clock.now(),
        model: step.usage.model,
        read: step.usage.cache_read_input_tokens,
        written: step.usage.cache_creation_input_tokens,
        uncached: step.usage.input_tokens,
      }

      await update($, last, () => sample)
      $.ui.status(formatStatus(sample))
    }

    return step
  })
}
