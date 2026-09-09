import { useMemo } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useApp } from '@/hooks/useAppState'

/** Categorical palette — distinguishable in both themes, ordered by prominence. */
export const SERIES = ['#5e6ad2', '#0ea5e9', '#10b981', '#f59e0b', '#a855f7', '#ef4444', '#737373']

/** Recharts needs concrete colours, so the design tokens are read off the
 *  document rather than duplicated here — one source of truth per skin. */
function useAxis() {
  const { theme, skin } = useApp()
  const token = (name: string, fallback: string) => {
    if (typeof window === 'undefined') return fallback
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
    return v ? `hsl(${v})` : fallback
  }
  // Re-read whenever the theme or skin flips.
  const key = `${theme}-${skin}`
  return useMemo(() => ({
    stroke: token('muted-foreground', '#737373'),
    grid: token('border', '#e5e5e5'),
    tooltip: {
      contentStyle: {
        borderRadius: 8,
        border: `1px solid ${token('border', '#e5e5e5')}`,
        background: token('popover', '#fff'),
        color: token('popover-foreground', '#0a0a0a'),
        fontSize: 12,
        boxShadow: '0 10px 24px -8px rgb(10 10 10 / 0.18)',
      },
      labelStyle: { fontWeight: 600, marginBottom: 2, color: token('foreground', '#0a0a0a') },
    },
  }), [key])
}

const common = { fontSize: 11, tickLine: false, axisLine: false }

export function AreaTrend({ data, keys, height = 220, stacked }: {
  data: any[]; keys: { key: string; label: string }[]; height?: number; stacked?: boolean
}) {
  const a = useAxis()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          {keys.map((k, i) => (
            <linearGradient key={k.key} id={`g-${k.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[i % SERIES.length]} stopOpacity={0.28} />
              <stop offset="100%" stopColor={SERIES[i % SERIES.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={a.grid} vertical={false} />
        <XAxis dataKey="name" {...common} stroke={a.stroke} />
        <YAxis {...common} stroke={a.stroke} width={54} />
        <Tooltip {...a.tooltip} />
        {keys.length > 1 && <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} />}
        {keys.map((k, i) => (
          <Area key={k.key} type="monotone" dataKey={k.key} name={k.label} stackId={stacked ? '1' : undefined}
            stroke={SERIES[i % SERIES.length]} strokeWidth={2} fill={`url(#g-${k.key})`} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function BarSeries({ data, keys, height = 220, horizontal, onSelect }: {
  data: any[]; keys: { key: string; label: string }[]; height?: number; horizontal?: boolean
  /** Makes the chart a filter control rather than a picture. */
  onSelect?: (name: string) => void
}) {
  const a = useAxis()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 12, left: horizontal ? 24 : -18, bottom: 0 }}>
        <CartesianGrid stroke={a.grid} vertical={horizontal} horizontal={!horizontal} />
        {horizontal
          ? <><XAxis type="number" {...common} stroke={a.stroke} /><YAxis type="category" dataKey="name" {...common} stroke={a.stroke} width={110} /></>
          : <><XAxis dataKey="name" {...common} stroke={a.stroke} /><YAxis {...common} stroke={a.stroke} width={54} /></>}
        <Tooltip {...a.tooltip} cursor={{ fill: a.grid, opacity: 0.5 }} />
        {keys.length > 1 && <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} />}
        {keys.map((k, i) => (
          <Bar key={k.key} dataKey={k.key} name={k.label} fill={SERIES[i % SERIES.length]}
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={34}
            cursor={onSelect ? 'pointer' : undefined}
            onClick={onSelect ? (d: any) => onSelect(String(d?.payload?.name ?? d?.name ?? '')) : undefined} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

export function LineSeries({ data, keys, height = 220 }: { data: any[]; keys: { key: string; label: string }[]; height?: number }) {
  const a = useAxis()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={a.grid} vertical={false} />
        <XAxis dataKey="name" {...common} stroke={a.stroke} />
        <YAxis {...common} stroke={a.stroke} width={54} />
        <Tooltip {...a.tooltip} />
        {keys.length > 1 && <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} />}
        {keys.map((k, i) => (
          <Line key={k.key} type="monotone" dataKey={k.key} name={k.label} stroke={SERIES[i % SERIES.length]}
            strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export function Donut({ data, height = 220, innerRadius = 52, onSelect }: {
  data: { name: string; value: number }[]; height?: number; innerRadius?: number
  onSelect?: (name: string) => void
}) {
  const a = useAxis()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={innerRadius} outerRadius={innerRadius + 26}
          paddingAngle={2} stroke="none" cursor={onSelect ? 'pointer' : undefined}
          onClick={onSelect ? (d: any) => onSelect(String(d?.name ?? d?.payload?.name ?? '')) : undefined}>
          {data.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
        </Pie>
        <Tooltip {...a.tooltip} />
        <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

export function RadarSpread({ data, height = 240 }: { data: { name: string; value: number }[]; height?: number }) {
  const a = useAxis()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={data} outerRadius="72%">
        <PolarGrid stroke={a.grid} />
        <PolarAngleAxis dataKey="name" tick={{ fontSize: 10, fill: a.stroke }} />
        <Radar dataKey="value" stroke={SERIES[0]} fill={SERIES[0]} fillOpacity={0.25} />
        <Tooltip {...a.tooltip} />
      </RadarChart>
    </ResponsiveContainer>
  )
}
