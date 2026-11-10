import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, SessionRateLimit } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'my-usage', key: 'limits' } as const, [] as Limit[])
const tick = atom({ plugin: 'my-usage', key: 'tick' } as const, 0)

const WINDOWS = ['five_hour', 'seven_day']
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }
const CELLS = 12

/** Used share to a traffic light: lots left is green, running low yellow, nearly out red. */
const hexFor = (used: number) => (used >= 85 ? '#ff453a' : used >= 60 ? '#ffb020' : '#30d158')
const colorFor = (used: number) => (used >= 85 ? 'error' : used >= 60 ? 'warning' : 'success')

const windowsOf = (rateLimits: readonly SessionRateLimit[]): Limit[] =>
  WINDOWS.flatMap(kind => {
    const found = rateLimits.find(limit => limit.kind === kind)
    return found ? [{ kind, percentUsed: found.percentUsed, resetsAt: found.resetsAt }] : []
  })

/** "42m", "3h 5m", "2d 4h": how long until the window resets. */
function until (ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

async function remember ($: EngineInterface, found: Limit[]) {
  if (found.length === 0) return
  await update($, limits, () => found)
  await $.store.set('limits', found)
}

/** One window as an SVG meter at `x`: label, rounded bar in its traffic-light color with the percent inside, reset time. Returns the markup and its width. */
function meterSvg (label: string, used: number, resetIn: string, x: number) {
  const color = hexFor(used)
  const bar = 104
  const fill = used > 0 ? Math.max(14, (Math.min(used, 100) / 100) * bar) : 0
  const labelW = label.length > 2 ? 34 : 22
  const resetW = resetIn ? 8 + resetIn.length * 6.2 + 12 : 0
  const bx = x + labelW
  // The percent is white with a dark outline, so it reads on the track, on any fill color, and across their edge.
  const svg = `<text x="${x}" y="14" font-size="11" font-weight="600" fill="#8e8e93">${label}</text>` +
    `<rect x="${bx}" y="3" width="${bar}" height="14" rx="7" fill="#8e8e93" fill-opacity="0.28"/>` +
    (fill ? `<rect x="${bx}" y="3" width="${fill}" height="14" rx="7" fill="${color}"/>` : '') +
    `<text x="${bx + bar / 2}" y="13.5" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff" stroke="#000" stroke-opacity="0.55" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">${Math.round(used)}%</text>` +
    (resetIn ? `<text x="${bx + bar + 7}" y="14" font-size="10.5" fill="#8e8e93">↻ ${resetIn}</text>` : '')
  return { svg, width: labelW + bar + resetW + 18 }
}

/** The band is one row of three slots (left, center, right) that the mods share: each fills its own and keeps the others'. */
const SLOTS = 'band-slots'
const WIDTHS = ['38%', '24%', '38%'] as const
const JUSTIFY = ['flex-start', 'center', 'flex-end'] as const

function band ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], beneath: RenderNode | undefined, own: [RenderNode?, RenderNode?, RenderNode?]): RenderNode {
  const { Box } = $.ui.resolve(e)
  const isShared = typeof beneath === 'object' && beneath !== null && beneath.type === 'Box' && (beneath.props as { key?: string }).key === SLOTS
  const prior = isShared ? ((beneath as { children?: RenderNode[] }).children ?? []) : []
  const cells = [0, 1, 2].map(i => own[i] !== undefined
    ? <Box width={WIDTHS[i]} flexDirection="row" justifyContent={JUSTIFY[i]} alignItems="center">{own[i]}</Box>
    : prior[i] ?? <Box width={WIDTHS[i]} />)
  return (
    <Box key={SLOTS} flexDirection="row" flexGrow={1} alignItems="center">
      {cells}
      {isShared ? prior[3] ?? null : beneath}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('limits')
    if (Array.isArray(saved)) await update($, limits, () => saved as Limit[])
    const usage = await $.session.usage()
    await remember($, windowsOf(usage.rateLimits))
    // Redraw once a minute so reset countdowns stay fresh.
    $.clock.every(60_000, () => { void update($, tick, n => n + 1) })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await remember($, windowsOf(e.rateLimits))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    const all = await read($, limits)
    await read($, tick)
    if (all.length === 0 || e.props.hasSurvey) return beneath

    const now = await $.clock.now()
    const rows = all.map(limit => {
      const resetsIn = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt) - now
      const isReset = resetsIn !== undefined && resetsIn <= 0
      return {
        label: LABELS[limit.kind] ?? limit.kind,
        used: isReset ? 0 : limit.percentUsed,
        resetIn: resetsIn !== undefined && !isReset ? until(resetsIn) : ''
      }
    })

    const table = $.ui.resolve(e)
    if ('Svg' in table) {
      const { Svg } = table
      const draw = (row: (typeof rows)[number]) => {
        const meter = meterSvg(row.label, row.used, row.resetIn, 0)
        const width = Math.ceil(meter.width - 14)
        const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 20" font-family="-apple-system, system-ui, sans-serif">${meter.svg}</svg>`
        return <Svg source={source} alt={`${row.label} ${Math.round(row.used)}% used`} width={width} height={20} />
      }
      return band($, e, beneath, [draw(rows[0]!), undefined, rows[1] ? draw(rows[1]) : undefined])
    }

    const { Box, Text } = table
    const text = (row: (typeof rows)[number]) => {
      const filled = Math.round((Math.min(Math.max(row.used, 0), 100) / 100) * CELLS)
      return (
        <Box flexDirection="row">
          <Text dimColor>{row.label} </Text>
          <Text color={colorFor(row.used)}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(CELLS - filled)}</Text>
          <Text> {Math.round(row.used)}%</Text>
          {row.resetIn ? <Text dimColor> ↻ {row.resetIn}</Text> : null}
        </Box>
      )
    }
    return band($, e, beneath, [text(rows[0]!), undefined, rows[1] ? text(rows[1]) : undefined])
  })
}
