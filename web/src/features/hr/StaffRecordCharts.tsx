import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts'

/* The staff record's two charts, apart so recharts is fetched only when one is drawn. */
const AXIS = { fontSize: 12 } as const
const TIP = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
} as const

export function Bars({ data, xKey }: { data: { avg_pct: number }[]; xKey: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -22 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS} stroke="hsl(var(--muted-foreground))" />
        <YAxis domain={[0, 100]} tick={AXIS} stroke="hsl(var(--muted-foreground))" />
        <Tooltip contentStyle={TIP} cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }} />
        <Bar dataKey="avg_pct" name="Average %" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function ExamTrend({ data }: { data: { exam: string; avg_pct: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -22 }}>
        <defs>
          <linearGradient id="staff-trend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="exam" tick={AXIS} stroke="hsl(var(--muted-foreground))" />
        <YAxis domain={[0, 100]} tick={AXIS} stroke="hsl(var(--muted-foreground))" />
        <Tooltip contentStyle={TIP} />
        <Area type="monotone" dataKey="avg_pct" name="Average %"
          stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#staff-trend)" />
      </AreaChart>
    </ResponsiveContainer>
  )
}
