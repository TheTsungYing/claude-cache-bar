import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = 1_700_000_000_000
const SECOND = 1000
const MINUTE = 60 * SECOND

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 47_000,
  cache_creation_input_tokens: 900,
}

/** `/cache-extend` typed at the prompt. */
const EXTEND = {
  command: 'cache-extend',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
}

/** Beneath the plugin: a clock, a store, and what it shows on the status line. */
const world = (on: On) => {
  const clock = mock.clock(on, { now: T0 })
  const status: (string | undefined)[] = []
  const forks: string[] = []
  mock.store(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.status', async ($, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    const usage = { ...USAGE, cache_creation_input_tokens: 0, output_tokens: 4 }

    return { value: { isAnswered: true, text: 'ok', usage } }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })

  return { clock, status, forks }
}

test('the terminal status line counts down, then points at /cache-extend', { options: { ttlMode: '5m' } }, async ($, on) => {
  const { clock, status } = world(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await clock.advance(SECOND)
  expect(status.at(-1)).toBe('⚡ waiting for the first response')

  // One main-thread request, read to its end as the query loop does.
  const step = $.turn.step({ turnId: 't1', index: 0, model: USAGE.model, messageCount: 1 })
  for await (const _ of step) {
  }
  await step.result

  await clock.advance(78 * SECOND)
  expect(status.at(-1)).toBe('⚡ 3:42 · 98% · 48.2k')

  await clock.advance(3 * MINUTE + 14 * SECOND)
  expect(status.at(-1)).toBe('⚠ 0:28 /cache-extend · 98% · 48.2k')
})

test('/cache-extend forks the main thread and restarts the countdown', { options: { ttlMode: '5m' } }, async ($, on) => {
  const { clock, status, forks } = world(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(EXTEND)).text).toBe('Nothing is cached yet: no request has been sent')
  expect(forks).toHaveLength(0)

  const step = $.turn.step({ turnId: 't1', index: 0, model: USAGE.model, messageCount: 1 })
  for await (const _ of step) {
  }
  await step.result
  await clock.advance(4 * MINUTE)

  expect((await $.command.run(EXTEND)).text).toBe('Cache extended (read 47.0k)')
  expect(forks).toHaveLength(1)

  await clock.advance(SECOND)
  expect(status.at(-1)).toBe('⚡ 4:59 · 98% · 48.2k')
})

test('zh-TW speaks Traditional Chinese', { options: { language: 'zh-TW' } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(EXTEND)).text).toBe('還沒有送出請求，沒有可延長的快取')
})
