import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Gauge, ShieldAlert, TriangleAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Select, Textarea, SkeletonTable, ErrorState, FormNotice,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* Speeding and rash driving, as a list that exists to be emptied.

   Two decisions worth stating. Closing an alert requires a note and the
   server enforces that; the button is therefore disabled with the reason
   printed beside it rather than letting a manager type nothing, click, and
   meet a 400 they have to interpret. And the peak is drawn against the limit
   as a bar, because "62" and "50" are two numbers a reader has to divide in
   their head, while a bar that runs a quarter past the line is the judgement
   already made.

   The coordinate is shown as digits, not a pin. There is no basemap and no
   tile server behind this product, and a lone marker on an empty rectangle
   would imply a road that is not drawn. */

interface SafetyEvent {
  id: string
  registration_no: string
  route?: string
  driver?: string
  kind: 'speeding' | 'harsh_brake' | 'harsh_accel' | 'harsh_turn'
  started_at: string
  minutes: number
  peak_kmph?: number
  limit_kmph?: number
  latitude?: number
  longitude?: number
  reviewed_at?: string
  review_note?: string
}

const KIND_LABEL: Record<SafetyEvent['kind'], string> = {
  speeding: 'Over the limit',
  harsh_brake: 'Harsh braking',
  harsh_accel: 'Harsh acceleration',
  harsh_turn: 'Harsh cornering',
}
/* Sustained speeding is the one that carries a child through a junction too
   fast for a whole minute; a single harsh brake may well have been the right
   thing to do. The tones say which is which without a legend. */
const KIND_TONE: Record<SafetyEvent['kind'], 'danger' | 'warning'> = {
  speeding: 'danger',
  harsh_brake: 'warning',
  harsh_accel: 'warning',
  harsh_turn: 'warning',
}

function whenText(iso: string): string {
  // The server already rendered this in India time; parsing it back into a
  // Date would re-apply the browser's zone and move it an hour on a laptop
  // brought back from abroad.
  const [date, time] = iso.split('T')
  if (!date) return iso
  const [y, m, d] = date.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const label = `${Number(d)} ${months[Number(m) - 1] ?? m} ${y}`
  return time ? `${label}, ${time.slice(0, 5)}` : label
}

/** Peak against limit, drawn. Bar caps at 100% width but keeps its own text. */
function OverBar({ peak, limit }: { peak?: number; limit?: number }) {
  if (peak == null) return <span className="text-muted-foreground">—</span>
  if (!limit) {
    return <span className="font-medium tabular-nums">{Math.round(peak)} km/h</span>
  }
  const ratio = peak / limit
  const over = Math.round(peak - limit)
  return (
    <div className="min-w-[150px]">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className={cn('font-medium tabular-nums', ratio > 1 && 'text-destructive')}>
          {Math.round(peak)} km/h
        </span>
        <span className="text-muted-foreground tabular-nums">in a {limit}</span>
      </div>
      <div
        className="relative mt-1 h-2 rounded-sm bg-muted"
        role="img"
        aria-label={`Peak ${Math.round(peak)} against a limit of ${limit} kilometres per hour`}
      >
        <div
          className={cn('h-full rounded-sm', ratio > 1 ? 'bg-destructive' : 'bg-success')}
          // The track is the limit plus half again, so the bar for a bus at
          // the limit sits two-thirds along and the eye reads the line rather
          // than a full bar that could mean anything.
          style={{ width: `${Math.min(100, (ratio / 1.5) * 100)}%` }}
        />
        <span className="absolute inset-y-[-2px] w-px bg-foreground/45" style={{ left: '66.6%' }} />
      </div>
      {over > 0 && (
        <div className="mt-1 text-[12.5px] text-destructive">
          {over} km/h over, for {Math.max(1, Math.round((peak / limit - 1) * 100))}% of the limit
        </div>
      )}
    </div>
  )
}

function ReviewBox({
  onClose,
  busy,
  error,
}: {
  onClose: (note: string) => void
  busy: boolean
  error: unknown
}) {
  const [note, setNote] = useState('')
  const trimmed = note.trim()
  // The server refuses an empty note. Saying so here, next to a disabled
  // button, is the difference between a rule the screen teaches and one it
  // springs on you.
  const why = trimmed.length === 0
    ? 'Say what was done about it — the alert cannot be closed without a note.'
    : trimmed.length < 5
      ? 'A few words at least: whoever reads this next was not there.'
      : ''
  return (
    <div className="mt-3 space-y-2">
      <Textarea
        value={note}
        onChange={setNote}
        rows={2}
        placeholder="Spoke to the driver; route has a 30 zone from Monday."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={!!why || busy}
          title={why || undefined}
          onClick={() => onClose(trimmed)}
        >
          {busy ? 'Closing…' : 'Close with this note'}
        </Button>
        {why && <span className="text-[12.5px] text-muted-foreground">{why}</span>}
      </div>
      {error ? <FormNotice error={error} /> : null}
    </div>
  )
}

export default function SafetyAlerts() {
  const qc = useQueryClient()
  const [openOnly, setOpenOnly] = useState('true')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [done, setDone] = useState('')

  const list = useQuery({
    queryKey: ['transport', 'safety-events', openOnly],
    queryFn: () =>
      api.get<List<SafetyEvent>>(
        `/api/v1/transport/safety-events${openOnly === 'true' ? '?open=true' : ''}`,
      ),
  })

  const review = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      api.post(`/api/v1/transport/safety-events/${id}/review`, { review_note: note }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transport', 'safety-events'] })
      setExpanded(null)
      setDone('Closed. It stays on the record under “All alerts”.')
    },
  })

  const items = list.data?.items ?? []
  const open = items.filter((e) => !e.reviewed_at)
  const speeding = open.filter((e) => e.kind === 'speeding').length
  const worst = useMemo(() => {
    let top: SafetyEvent | null = null
    for (const e of open) {
      if (e.peak_kmph == null || !e.limit_kmph) continue
      if (!top || e.peak_kmph / e.limit_kmph! > top.peak_kmph! / top.limit_kmph!) top = e
    }
    return top
  }, [open])
  /* Repeat offenders are the point of the whole list: one bus over the limit
     once is a driver having a bad morning, the same bus five times is a route
     timed too tightly or a driver who needs taking off it. */
  const repeat = useMemo(() => {
    const byBus = new Map<string, number>()
    for (const e of open) byBus.set(e.registration_no, (byBus.get(e.registration_no) ?? 0) + 1)
    return [...byBus.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
  }, [open])

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Speeding & rash driving alerts"
        description="Raised from the buses' own position feed. Every one is closed with a note, so the record says what was done and not merely that somebody looked."
        width="wide"
        actions={
          <Select
            value={openOnly}
            onChange={(v) => {
              setOpenOnly(v)
              setDone('')
            }}
            options={[
              { value: 'true', label: 'Open alerts' },
              { value: 'false', label: 'All alerts' },
            ]}
          />
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Open alerts" value={open.length} icon={ShieldAlert} />
          <Stat label="Over the limit" value={speeding} icon={Gauge} hint="Sustained speeding, open" />
          <Stat
            label="Worst peak"
            value={worst?.peak_kmph ? `${Math.round(worst.peak_kmph)} km/h` : '—'}
            icon={TriangleAlert}
            hint={worst ? `${worst.registration_no} in a ${worst.limit_kmph}` : 'Nothing open'}
          />
          <Stat
            label="Buses with more than one"
            value={repeat.length}
            icon={CheckCircle2}
            hint={repeat.length ? repeat.map(([reg, n]) => `${reg} ×${n}`).join(', ') : undefined}
          />
        </CellGrid>

        {done && <FormNotice ok={done} />}

        {list.isError ? (
          <ErrorState error={list.error} />
        ) : list.isLoading ? (
          <SkeletonTable columns={7} />
        ) : (
          <Card>
            <CardHeader
              title={openOnly === 'true' ? 'Open alerts' : 'All alerts'}
              description="Open first, newest first. The most recent 300 are kept on this screen."
            />
            <Table
              head={[
                'Bus',
                'Driver',
                'What happened',
                'When',
                { label: 'Peak against limit', align: 'right' },
                'Review',
              ]}
              empty={items.length === 0}
              emptyLabel={
                openOnly === 'true'
                  ? 'Nothing open. Every alert raised has been closed with a note.'
                  : 'No alerts have been raised. Either the fleet is driving well or no bus is reporting position.'
              }
            >
              {items.map((e) => (
                <tr key={e.id} className={cn(!e.reviewed_at && 'bg-destructive/[0.05]')}>
                  <Td>
                    <div className="font-medium">{e.registration_no}</div>
                    <div className="text-[12.5px] text-muted-foreground">{e.route ?? 'No route on the trip'}</div>
                  </Td>
                  <Td>{e.driver ?? '—'}</Td>
                  <Td>
                    <Badge tone={KIND_TONE[e.kind]}>{KIND_LABEL[e.kind] ?? e.kind}</Badge>
                    <div className="text-[12.5px] text-muted-foreground">
                      lasted {e.minutes} min
                      {e.latitude != null && e.longitude != null
                        ? ` · ${e.latitude.toFixed(4)}, ${e.longitude.toFixed(4)}`
                        : ''}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">{whenText(e.started_at)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end">
                      <OverBar peak={e.peak_kmph} limit={e.limit_kmph} />
                    </div>
                  </Td>
                  <Td>
                    {e.reviewed_at ? (
                      <div>
                        <Badge tone="success">Closed {whenText(e.reviewed_at)}</Badge>
                        <div className="mt-1 text-[12.5px] text-muted-foreground">
                          {e.review_note}
                        </div>
                      </div>
                    ) : expanded === e.id ? (
                      <ReviewBox
                        busy={review.isPending}
                        error={review.variables?.id === e.id ? review.error : undefined}
                        onClose={(note) => review.mutate({ id: e.id, note })}
                      />
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDone('')
                          setExpanded(e.id)
                        }}
                      >
                        Close with a note
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
            <p className="px-5 pb-4 text-[12.5px] text-muted-foreground">
              Coordinates are given as numbers because this system holds no map data — there is no
              basemap and no tile server behind it, and a pin on a blank square would suggest a road
              nobody has drawn. Speed comes from the driver's phone GPS, which is accurate enough to
              start a conversation and not evidence on its own.
            </p>
          </Card>
        )}
      </PageBody>
    </>
  )
}
