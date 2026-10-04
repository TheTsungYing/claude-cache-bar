// SVG documents for the desktop band, as pure strings. Animation is SMIL in a
// plain (image) Svg: the countdown runs on its own, so a drawing only has to
// change when the anchor, the TTL or the phase does.

import type { Phase } from './core'

export const COLORS = {
  fresh: '#1D9E75',
  warn: '#EF9F27',
  alert: '#E24B4A',
  expired: '#E24B4A',
  working: '#378ADD',
  track: '#88878055',
  line: '#1D9E75',
} as const

export const RING_SIZE = 28

const R = 11
const STROKE = 3
const C = RING_SIZE / 2
const CIRCUMFERENCE = 2 * Math.PI * R

const n = (x: number) => Number(x.toFixed(2))

/** SMIL `begin` offset, seconds from when the image loads; never negative. */
const at = (ms: number) => `${n(Math.max(0, ms) / 1000)}s`

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

const circle = (attrs: string, children = '') =>
  `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke-width="${STROKE}" ${attrs}>${children}</circle>`

export type RingView = {
  leftMs: number
  totalMs: number
  warnMs: number
  alertMs: number
  phase: Phase
}

/**
 * The countdown ring, shrinking from what is left now to nothing over the
 * time left. It turns yellow and blinks at the warn threshold, red at the
 * alert one, and becomes a red dashed circle at expiry, all by SMIL timing.
 */
export const ringSvg = ({ leftMs, totalMs, warnMs, alertMs, phase }: RingView) => {
  if (phase === 'expired') {
    return svg(RING_SIZE, RING_SIZE, circle(`stroke="${COLORS.expired}" stroke-dasharray="3 3"`))
  }

  const fraction = Math.min(1, Math.max(0, leftMs / totalMs))
  const startOffset = n(CIRCUMFERENCE * (1 - fraction))
  const color = phase === 'fresh' ? COLORS.fresh : phase === 'warn' ? COLORS.warn : COLORS.alert
  const toWarn = leftMs - warnMs
  const toAlert = leftMs - alertMs

  const shrink = `<animate attributeName="stroke-dashoffset" from="${startOffset}" to="${n(CIRCUMFERENCE)}" dur="${at(leftMs)}" fill="freeze"/>`
  const turnWarn = phase === 'fresh' ? `<set attributeName="stroke" to="${COLORS.warn}" begin="${at(toWarn)}" fill="freeze"/>` : ''
  const turnAlert = phase !== 'alert' ? `<set attributeName="stroke" to="${COLORS.alert}" begin="${at(toAlert)}" fill="freeze"/>` : ''
  const blink = `<animate attributeName="opacity" values="1;0.3;1" dur="1s" begin="${at(toWarn)}" repeatCount="indefinite"/>`

  const track = circle(
    `stroke="${COLORS.track}"`,
    `<set attributeName="stroke" to="${COLORS.expired}" begin="${at(leftMs)}" fill="freeze"/>` +
      `<set attributeName="stroke-dasharray" to="3 3" begin="${at(leftMs)}" fill="freeze"/>`,
  )
  const arc = circle(
    `stroke="${color}" stroke-linecap="round" stroke-dasharray="${n(CIRCUMFERENCE)}" stroke-dashoffset="${startOffset}" transform="rotate(-90 ${C} ${C})"`,
    shrink + turnWarn + turnAlert + blink + `<set attributeName="visibility" to="hidden" begin="${at(leftMs)}" fill="freeze"/>`,
  )

  return svg(RING_SIZE, RING_SIZE, track + arc)
}

/** A quarter arc spinning: Claude is answering, the countdown waits. */
export const SPINNER_SVG = svg(
  RING_SIZE,
  RING_SIZE,
  circle(`stroke="${COLORS.track}"`) +
    circle(
      `stroke="${COLORS.working}" stroke-linecap="round" stroke-dasharray="${n(CIRCUMFERENCE / 4)} ${n(CIRCUMFERENCE)}"`,
      `<animateTransform attributeName="transform" type="rotate" from="0 ${C} ${C}" to="360 ${C} ${C}" dur="1s" repeatCount="indefinite"/>`,
    ),
)

/** No request yet: an empty grey ring. */
export const IDLE_RING_SVG = svg(RING_SIZE, RING_SIZE, circle(`stroke="${COLORS.track}"`))

export const SPARK_WIDTH = 72
export const SPARK_HEIGHT = 20

/** Hit rate per request as a line, 0% at the bottom; a red dot where the cache broke. */
export const sparklineSvg = (points: readonly { rate: number; isBreak: boolean }[]) => {
  const pad = 2.5
  const step = points.length > 1 ? (SPARK_WIDTH - 2 * pad) / (points.length - 1) : 0
  const xy = points.map((p, i) => ({ x: n(pad + i * step), y: n(pad + (1 - p.rate) * (SPARK_HEIGHT - 2 * pad)), p }))
  const baseline = `<line x1="${pad}" y1="${SPARK_HEIGHT - pad}" x2="${SPARK_WIDTH - pad}" y2="${SPARK_HEIGHT - pad}" stroke="${COLORS.track}" stroke-width="1"/>`
  const line = `<polyline points="${xy.map(q => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="${COLORS.line}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
  const dots = xy
    .filter(q => q.p.isBreak)
    .map(q => `<circle cx="${q.x}" cy="${q.y}" r="2.2" fill="${COLORS.alert}"/>`)
    .join('')

  return svg(SPARK_WIDTH, SPARK_HEIGHT, baseline + line + dots)
}
