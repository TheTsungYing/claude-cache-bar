// SVG documents for the desktop band, as pure strings. Animation is SMIL in a
// plain (image) Svg: the countdown runs on its own, so a drawing only has to
// change when the anchor, the TTL or the phase does.

import type { Phase } from './core'

// Claude's palette: a warm neutral while all is well, colour only when
// something needs you. Mid tones, since a drawing can't follow the theme.
export const COLORS = {
  neutral: '#8F8B83',
  warn: '#D97757',
  alert: '#E24B4A',
  expired: '#8F8B83',
  track: '#8F8B8340',
  read: '#1D9E75',
  written: '#EF9F27',
  uncached: '#888780',
  rate: '#378ADD',
  label: '#888780',
} as const

/** One line of text high, so the band stays one row. */
export const RING_SIZE = 16

/** The side panel's ring. */
export const BIG_RING_SIZE = 48

const n = (x: number) => Number(x.toFixed(2))

/** SMIL `begin` offset, seconds from when the image loads; never negative. */
const at = (ms: number) => `${n(Math.max(0, ms) / 1000)}s`

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

/** A ring of `size` pixels: the band's keeps a 2px stroke, larger ones scale it. */
const ringGeometry = (size: number) => {
  const stroke = Math.max(2, n(size / 12))
  const r = size / 2 - stroke

  return { stroke, c: size / 2, r, circumference: 2 * Math.PI * r }
}

type RingGeometry = ReturnType<typeof ringGeometry>

const circle = (g: RingGeometry, attrs: string, children = '') =>
  `<circle cx="${g.c}" cy="${g.c}" r="${n(g.r)}" fill="none" stroke-width="${g.stroke}" ${attrs}>${children}</circle>`

export type RingView = {
  leftMs: number
  totalMs: number
  warnMs: number
  alertMs: number
  phase: Phase
}

/**
 * The countdown ring, shrinking from what is left now to nothing over the
 * time left. It turns orange at the warn threshold, red at the alert one, and
 * becomes a grey dashed circle at expiry, all by SMIL timing. Nothing blinks.
 */
export const ringSvg = ({ leftMs, totalMs, warnMs, alertMs, phase }: RingView, size = RING_SIZE) => {
  const g = ringGeometry(size)
  const dash = `${g.stroke} ${g.stroke}`

  if (phase === 'expired') {
    return svg(size, size, circle(g, `stroke="${COLORS.expired}" stroke-dasharray="${dash}"`))
  }

  const fraction = Math.min(1, Math.max(0, leftMs / totalMs))
  const startOffset = n(g.circumference * (1 - fraction))
  const color = phase === 'fresh' ? COLORS.neutral : phase === 'warn' ? COLORS.warn : COLORS.alert
  const toWarn = leftMs - warnMs
  const toAlert = leftMs - alertMs

  const shrink = `<animate attributeName="stroke-dashoffset" from="${startOffset}" to="${n(g.circumference)}" dur="${at(leftMs)}" fill="freeze"/>`
  const turnWarn = phase === 'fresh' ? `<set attributeName="stroke" to="${COLORS.warn}" begin="${at(toWarn)}" fill="freeze"/>` : ''
  const turnAlert = phase !== 'alert' ? `<set attributeName="stroke" to="${COLORS.alert}" begin="${at(toAlert)}" fill="freeze"/>` : ''

  const track = circle(
    g,
    `stroke="${COLORS.track}"`,
    `<set attributeName="stroke" to="${COLORS.expired}" begin="${at(leftMs)}" fill="freeze"/>` +
      `<set attributeName="stroke-dasharray" to="${dash}" begin="${at(leftMs)}" fill="freeze"/>`,
  )
  const arc = circle(
    g,
    `stroke="${color}" stroke-linecap="round" stroke-dasharray="${n(g.circumference)}" stroke-dashoffset="${startOffset}" transform="rotate(-90 ${g.c} ${g.c})"`,
    shrink + turnWarn + turnAlert + `<set attributeName="visibility" to="hidden" begin="${at(leftMs)}" fill="freeze"/>`,
  )

  return svg(size, size, track + arc)
}

/**
 * A full grey ring, still: Claude is answering and the countdown waits. Claude
 * shows its own activity, so this one doesn't move.
 */
export const pausedRingSvg = (size = RING_SIZE) => svg(size, size, circle(ringGeometry(size), `stroke="${COLORS.neutral}"`))

/** No request yet: an empty grey ring. */
export const idleRingSvg = (size = RING_SIZE) => svg(size, size, circle(ringGeometry(size), `stroke="${COLORS.track}"`))

export const SPARK_WIDTH = 72
export const SPARK_HEIGHT = 16

/** Hit rate per request as a line, 0% at the bottom; a red dot where the cache broke. */
export const sparklineSvg = (points: readonly { rate: number; isBreak: boolean }[]) => {
  const pad = 2.5
  const step = points.length > 1 ? (SPARK_WIDTH - 2 * pad) / (points.length - 1) : 0
  const xy = points.map((p, i) => ({ x: n(pad + i * step), y: n(pad + (1 - p.rate) * (SPARK_HEIGHT - 2 * pad)), p }))
  const baseline = `<line x1="${pad}" y1="${SPARK_HEIGHT - pad}" x2="${SPARK_WIDTH - pad}" y2="${SPARK_HEIGHT - pad}" stroke="${COLORS.track}" stroke-width="1"/>`
  const line = `<polyline points="${xy.map(q => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="${COLORS.neutral}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
  const dots = xy
    .filter(q => q.p.isBreak)
    .map(q => `<circle cx="${q.x}" cy="${q.y}" r="2.2" fill="${COLORS.alert}"/>`)
    .join('')

  return svg(SPARK_WIDTH, SPARK_HEIGHT, baseline + line + dots)
}

export const CHART_WIDTH = 320
export const CHART_HEIGHT = 120

/** Bars the chart draws at most: the latest requests. */
export const CHART_BARS = 40

export type ChartBar = {
  read: number
  written: number
  uncached: number
  /** Hit rate, 0..1. */
  rate: number
  isBreak: boolean
}

/**
 * One bar per request, stacked read / written / uncached and scaled to the
 * largest input shown; the hit-rate line over them on its own 0..100% scale,
 * and a red dot on it where the cache broke.
 */
export const chartSvg = (bars: readonly ChartBar[], maxLabel: string) => {
  const top = 12
  const bottom = CHART_HEIGHT - 2
  const left = 2
  const right = CHART_WIDTH - 2
  const plot = bottom - top
  const slot = (right - left) / Math.max(bars.length, 12)
  const barWidth = Math.max(1, slot * 0.7)
  const max = Math.max(1, ...bars.map(b => b.read + b.written + b.uncached))
  const y = (tokens: number) => (tokens / max) * plot

  const rects = bars
    .map((b, i) => {
      const x = n(left + i * slot + (slot - barWidth) / 2)
      let base = bottom
      const part = (tokens: number, color: string) => {
        const height = y(tokens)
        base -= height

        return height <= 0 ? '' : `<rect x="${x}" y="${n(base)}" width="${n(barWidth)}" height="${n(height)}" fill="${color}"/>`
      }

      return part(b.read, COLORS.read) + part(b.written, COLORS.written) + part(b.uncached, COLORS.uncached)
    })
    .join('')

  const points = bars.map((b, i) => ({ x: n(left + i * slot + slot / 2), y: n(bottom - b.rate * plot), b }))
  const line =
    points.length > 1
      ? `<polyline points="${points.map(q => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="${COLORS.rate}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
      : ''
  const dots = points
    .map(q =>
      q.b.isBreak
        ? `<circle cx="${q.x}" cy="${q.y}" r="3.5" fill="${COLORS.alert}"/>`
        : `<circle cx="${q.x}" cy="${q.y}" r="1.5" fill="${COLORS.rate}"/>`,
    )
    .join('')
  const grid =
    `<line x1="${left}" y1="${top}" x2="${right}" y2="${top}" stroke="${COLORS.track}" stroke-width="1" stroke-dasharray="2 3"/>` +
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${COLORS.track}" stroke-width="1"/>`
  const labels =
    `<text x="${left}" y="9" font-family="sans-serif" font-size="9" fill="${COLORS.label}">${maxLabel}</text>` +
    `<text x="${right}" y="9" font-family="sans-serif" font-size="9" fill="${COLORS.rate}" text-anchor="end">100%</text>`

  return svg(CHART_WIDTH, CHART_HEIGHT, grid + rects + line + dots + labels)
}

/** Font sizes of the band's clock and the panel's. */
export const CLOCK_SIZE = 14
export const BIG_CLOCK_SIZE = 18

const CLOCK_FONT = 'ui-monospace, Menlo, Consolas, monospace'

/** One clock digit: `floor(shown / period) % base` of the seconds shown. */
type ClockDigit = { period: number; base: number; isLeading: boolean }

/**
 * The countdown as m:ss that runs by itself: each digit is a strip of glyphs
 * in a clipped column, stepped by a discrete SMIL translate, so the clock
 * needs no redraw. It stops at 0:00. Seconds round up, as `formatClock` does.
 */
export const clockSvg = (leftMs: number, color: string, fontSize = BIG_CLOCK_SIZE) => {
  const height = Math.round(fontSize * 1.34)
  const baseline = Math.round(fontSize * 1.0)
  const digitWidth = Math.round(fontSize * 0.62)
  const colonWidth = Math.round(fontSize * 0.34)
  const exact = Math.max(0, leftMs / 1000)
  const shown = Math.ceil(exact)
  // The first second ticks off here; the rest one second apart.
  const firstTick = shown === 0 ? 0 : exact - (shown - 1)
  const zeroAt = firstTick + shown - 1
  const digits: (ClockDigit | ':')[] = [
    ...(shown >= 600 ? [{ period: 600, base: 10, isLeading: true }] : []),
    { period: 60, base: 10, isLeading: false },
    ':',
    { period: 10, base: 6, isLeading: false },
    { period: 1, base: 10, isLeading: false },
  ]
  const glyph = (x: number, y: number, text: string) =>
    `<text x="${n(x)}" y="${y}" text-anchor="middle" font-family="${CLOCK_FONT}" font-size="${fontSize}" font-weight="700" fill="${color}">${text}</text>`

  let x = 0
  const body = digits
    .map(d => {
      if (d === ':') {
        x += colonWidth

        return glyph(x - colonWidth / 2, baseline, ':')
      }

      const at = x
      x += digitWidth
      const valueAt = (seconds: number) => Math.floor(seconds / d.period) % d.base
      const now = valueAt(shown)
      const strip = Array.from({ length: d.base }, (_, i) =>
        glyph(digitWidth / 2, baseline + i * height, d.isLeading && i === 0 ? '' : String(i)),
      ).join('')
      const offset = (value: number) => `0 ${-value * height}`
      // Each step lasts one period; after the shown value, base steps cycle.
      const steps = Array.from({ length: d.base }, (_, i) => offset((now - 1 - i + 2 * d.base) % d.base))
      const begin = firstTick + (shown % d.period)
      const tick =
        shown === 0 || begin > zeroAt
          ? ''
          : `<animateTransform attributeName="transform" type="translate" calcMode="discrete" values="${steps.join(';')}" dur="${d.period * d.base}s" begin="${n(begin)}s" end="${n(zeroAt + 0.5)}s" repeatCount="indefinite" fill="freeze"/>`

      return `<svg x="${at}" y="0" width="${digitWidth}" height="${height}" overflow="hidden"><g transform="translate(${offset(now)})">${tick}${strip}</g></svg>`
    })
    .join('')

  return { source: svg(x, height, body), width: x, height }
}
