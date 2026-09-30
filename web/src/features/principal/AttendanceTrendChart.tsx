import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts'

/* The principal dashboard's 30-day attendance line, in a file of its own so
   recharts is only downloaded when this chart is actually drawn. */
export default function AttendanceTrendChart({ items }: { items: { date: string; pct: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={items} margin={{ top: 4, right: 8, bottom: 4, left: -22 }}>
        <defs>
          <linearGradient id="att" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 8, fontSize: 12,
          }}
        />
        <Area
          type="monotone" dataKey="pct" name="Present %"
          stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#att)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
