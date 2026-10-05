// SVG documents for the desktop band, as pure strings. Animation is SMIL in a
// plain (image) Svg: the countdown runs on its own, so a drawing only has to
// change when the anchor, the TTL or the phase does.

import { formatGap } from './core'
import type { ChartModel, HitLevel, Phase } from './core'

// Claude's palette: a warm neutral while all is well, colour only when
// something needs you. Mid tones, since a drawing can't follow the theme.
export const COLORS = {
  neutral: '#8F8B83',
  warn: '#D97757',
  alert: '#E24B4A',
  expired: '#8F8B83',
  track: '#8F8B8340',
  // The chart: reads are the cheap, normal case, so they stay grey; writes
  // cost, so they take the accent.
  read: '#8F8B8380',
  written: '#D97757',
  uncached: '#8F8B8333',
  // A hit rate that slipped but didn't break: between grey and the accent.
  dip: '#E0B04A',
  label: '#8F8B83',
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

/** The chart's height with a two-line readout; each further line adds `READOUT_LINE`. */
export const CHART_HEIGHT = 172
const READOUT_LINE = 17

/** Bars the chart draws at most: the latest requests; fewer in a narrow panel. */
export const CHART_BARS = 40
export const NARROW_CHART_BARS = 20

/** The hit-rate strip's colours: grey while all is well. */
const LEVEL_COLORS: Record<HitLevel, string> = {
  ok: COLORS.track,
  dip: COLORS.dip,
  low: COLORS.warn,
  broke: COLORS.alert,
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A percentage of the chart's width, as an SVG length. */
const pct = (x: number) => `${n(x)}%`

const label = (x: string, y: number, text: string, size: number, anchor: 'start' | 'end' = 'start', dx = 0) =>
  `<text x="${x}" y="${y}"${dx === 0 ? '' : ` dx="${dx}"`} font-size="${size}" text-anchor="${anchor}">${escapeXml(text)}</text>`

// The chart is drawn interactive, in a frame of its own, for its hover. The
// frame paints white unless the document allows a dark scheme, so it does,
// on a transparent ground. Hovering a bar shows its readout in place of the
// latest one's; no script, only CSS.
const CHART_STYLE =
  '<style>' +
  ':root{color-scheme:light dark}' +
  'svg{background:transparent}' +
  `text{font-family:sans-serif;fill:${COLORS.label}}` +
  `.hit{fill:${COLORS.neutral};fill-opacity:0;pointer-events:all}` +
  '.b:hover .hit{fill-opacity:.15}' +
  '.r{visibility:hidden}' +
  '.b:hover .r{visibility:visible}' +
  'svg:has(.b:hover) .def{visibility:hidden}' +
  '</style>'

/**
 * One bar per request: its cost in uncached-token equivalents, stacked read /
 * written / uncached. A strip above colours each request's hit rate; a dashed
 * line and its length mark idle that neared expiry, ▲ a keep-warm fork. A bar past
 * a capped scale's top ends in a chevron. `topLabel` and `rangeLabel` head it;
 * below it, the latest request's `readouts` lines, or the hovered one's.
 *
 * It fills the frame's width and keeps its height: across, everything is laid
 * out in percentages, so the bars stretch and the text keeps its size.
 * `widthPx` is a guess at that width, used only to keep mark labels apart.
 * Returns the markup and its height in pixels.
 */
export const chartSvg = (
  model: ChartModel,
  topLabel: string,
  rangeLabel: string,
  readouts: readonly (readonly string[])[],
  widthPx: number,
) => {
  const lines = Math.max(2, ...readouts.map(r => r.length))
  const height = CHART_HEIGHT + (lines - 2) * READOUT_LINE
  const stripY = 18
  const top = 30
  const bottom = 116
  const marksY = 128
  const plot = bottom - top
  // Percent of the width: an edge margin, and each request's slot.
  const edge = 0.8
  const slot = (100 - 2 * edge) / Math.max(model.bars.length, 12)
  const barWidth = slot * 0.55
  // Marks below the axis skip a label that would run into the one before.
  let labelEnd = Number.NEGATIVE_INFINITY

  const mark = (x: number, gapMs: number | null, extensions: number, isEnd = false) => {
    const line =
      gapMs === null
        ? ''
        : `<line x1="${pct(x)}" y1="${top - 2}" x2="${pct(x)}" y2="${bottom}" stroke="${COLORS.label}" stroke-width="1" stroke-dasharray="2 3"/>`
    const text = [gapMs === null ? '' : formatGap(gapMs), extensions === 0 ? '' : '▲'.repeat(Math.min(extensions, 3))]
      .filter(t => t !== '')
      .join(' ')
    const xPx = (x / 100) * widthPx

    if (text === '' || xPx < labelEnd) {
      return line
    }

    labelEnd = xPx + text.length * 6 + 4

    return line + (isEnd ? label('100%', marksY, text, 10, 'end', -4) : label(pct(x), marksY, text, 10, 'start', 1))
  }

  const readout = (rows: readonly string[] | undefined, className: string) =>
    rows === undefined
      ? ''
      : `<g class="${className}">${rows.map((row, j) => label('4', 148 + j * READOUT_LINE, row, 12)).join('')}</g>`

  const marks: string[] = []
  const bars = model.bars
    .map((b, i) => {
      const x = edge + i * slot
      const barX = pct(x + (slot - barWidth) / 2)
      const total = b.cost.read + b.cost.written + b.cost.uncached
      // Clipped bars keep their mix: each part shrinks with the whole.
      const scale = total === 0 ? 0 : (b.height * plot) / total
      let base = bottom
      const part = (amount: number, color: string) => {
        const h = amount * scale
        base -= h

        return h <= 0 ? '' : `<rect x="${barX}" y="${n(base)}" width="${pct(barWidth)}" height="${n(h)}" fill="${color}"/>`
      }
      // A path takes no percentages, so the chevron sits in a nested svg placed by one.
      const chevron = b.isClipped
        ? `<svg x="${pct(x + slot / 2)}" y="${top - 5}" overflow="visible"><path d="M-3 3L0 0L3 3" fill="none" stroke="${COLORS.neutral}" stroke-width="1.2"/></svg>`
        : ''

      marks.push(mark(x, b.gapMs, b.extensionsBefore))

      // The hover target spans the bar's column, strip to axis.
      return (
        '<g class="b">' +
        `<rect class="hit" x="${pct(x)}" y="${stripY - 2}" width="${pct(slot)}" height="${bottom - stripY + 4}"/>` +
        `<rect x="${pct(x + slot * 0.05)}" y="${stripY}" width="${pct(slot * 0.9)}" height="4" fill="${LEVEL_COLORS[b.level]}"/>` +
        part(b.cost.read, b.isLatest ? COLORS.neutral : COLORS.read) +
        part(b.cost.written, COLORS.written) +
        part(b.cost.uncached, COLORS.uncached) +
        chevron +
        readout(readouts[i], 'r') +
        '</g>'
      )
    })
    .join('')

  marks.push(mark(edge + model.bars.length * slot, null, model.extensionsAfter, true))
  const axis = `<line x1="${pct(edge)}" y1="${bottom}" x2="${pct(100 - edge)}" y2="${bottom}" stroke="${COLORS.track}" stroke-width="1"/>`
  const heads = label('4', 12, topLabel, 12) + label('100%', 12, rangeLabel, 12, 'end', -4)

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">` +
    CHART_STYLE +
    axis +
    marks.join('') +
    heads +
    readout(readouts.at(-1), 'def') +
    bars +
    '</svg>'

  return { source, height }
}

/** Font sizes of the band's clock and the panel's. */
export const CLOCK_SIZE = 14
export const BIG_CLOCK_SIZE = 22

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
