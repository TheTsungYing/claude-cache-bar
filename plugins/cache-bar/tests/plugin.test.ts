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

/** `/cache` typed at the prompt with `args`. */
const cache = (args: string) => ({ ...EXTEND, command: 'cache', args })

/** Beneath the plugin: a clock, a store, and what it shows on the status line. */
const world = (on: On) => {
  const clock = mock.clock(on, { now: T0 })
  const status: (string | undefined)[] = []
  const forks: string[] = []
  // A test sets a field here to give the plugin its /config row for it.
  const settings: Record<string, string | number | boolean | null> = { language: null }
  // What the plugin asked `$.config.set` for, as it asked.
  const sets: { key: string; value: unknown }[] = []
  mock.store(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.status', async ($, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }))
  // A plugin folder: no settings rows, so picks are kept as overrides.
  on('config.list', async () => ({
    value: Object.entries(settings).flatMap(([field, value]) =>
      value === null
        ? []
        : [
            {
              key: `cache-bar.${field}`,
              label: field,
              kind: ROW_KINDS[field] ?? ('choice' as const),
              value,
              provider: { plugin: 'cache-bar' } as never,
              isLocked: false,
            },
          ],
    ),
  }))
  on('config.set', async ($, e) => {
    sets.push({ key: e.key, value: e.value })
    settings[e.key.replace('cache-bar.', '')] = e.value as string | number | boolean

    return { value: e.value }
  })
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    const usage = { ...USAGE, cache_creation_input_tokens: 0, output_tokens: 4 }

    return { value: { isAnswered: true, text: 'ok', usage } }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })

  return { clock, status, forks, settings, sets }
}

const ROW_KINDS: Record<string, 'boolean' | 'choice' | 'number'> = {
  language: 'choice',
  breakSensitivity: 'choice',
  toast: 'boolean',
  autoExtendMaxPerIdle: 'number',
}

/** The side panel, as desktop asks the plugin to draw it. */
const PANE = {
  plugin: 'cache-bar',
  surface: 'desktop' as const,
  component: 'Pane' as const,
  requestId: 'cache-bar',
  props: {
    title: 'Cache',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
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

test('/cache lang switches the language on the spot', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(cache('lang zh-TW'))).text).toBe('語言：繁體中文')
  expect((await $.command.run(EXTEND)).text).toBe('還沒有送出請求，沒有可延長的快取')

  expect((await $.command.run(cache('lang'))).text).toBe('Language: English')
  expect((await $.command.run(EXTEND)).text).toBe('Nothing is cached yet: no request has been sent')

  expect((await $.command.run(cache('lang fr'))).text).toBe(
    '/cache opens the panel · /cache lang en|zh-TW switches the language',
  )
})

test('session.start keeps a language picked with /cache lang', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.command.run(cache('lang zh'))
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(EXTEND)).text).toBe('還沒有送出請求，沒有可延長的快取')
})

test('/cache lang wins over a pick saved before the settings row existed', async ($, on) => {
  const { settings } = world(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.command.run(cache('lang zh-TW'))
  settings.language = 'en'

  expect((await $.command.run(cache('lang en'))).text).toBe('Language: English')
  expect((await $.command.run(EXTEND)).text).toBe('Nothing is cached yet: no request has been sent')
})

test('the panel picks break sensitivity, toasts and the auto-extend limit', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  const valueOf = async (key: string) => (await ui.find({ key }))?.props.value

  expect(await valueOf('breakSensitivity')).toBe('medium')
  await ui.select({ key: 'breakSensitivity', value: 'high' })
  expect(await valueOf('breakSensitivity')).toBe('high')

  await ui.select({ key: 'toast', value: 'false' })
  expect(await valueOf('toast')).toBe('false')

  // The limit only shows once extension is automatic.
  expect(await ui.find({ key: 'autoExtendMaxPerIdle' })).toBe(undefined)
  await ui.select({ key: 'onExpiring', value: 'auto' })
  expect(await valueOf('autoExtendMaxPerIdle')).toBe('3')
  await ui.select({ key: 'autoExtendMaxPerIdle', value: '10' })
  expect(await valueOf('autoExtendMaxPerIdle')).toBe('10')

  await ui.unmount()
})

test('a settings row gets a toggle as a boolean and a limit as a number', async ($, on) => {
  const { settings, sets } = world(on)
  settings.toast = true
  settings.autoExtendMaxPerIdle = 3
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await ui.select({ key: 'toast', value: 'false' })
  await ui.select({ key: 'onExpiring', value: 'auto' })
  await ui.select({ key: 'autoExtendMaxPerIdle', value: '5' })

  expect(sets).toEqual([
    { key: 'cache-bar.toast', value: false },
    { key: 'cache-bar.autoExtendMaxPerIdle', value: 5 },
  ])

  await ui.unmount()
})
