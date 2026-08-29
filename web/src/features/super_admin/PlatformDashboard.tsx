import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Building2, IndianRupee, Users, X } from 'lucide-react'
import { api, setActingInstitution } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Loading, ErrorState, EmptyState,
  RangePicker, rangeQuery, useRange, type RangeOption, type ActiveRange,
} from '@/components/ui'
import { cn, formatPaise } from '@/lib/utils'

/* Every campus, side by side.

   A trust running six campuses had no screen that showed six campuses: the
   principal's dashboard is scoped to one school by design, so the person above
   them read six of those in six tabs and added the numbers up by hand.

   Deliberately aggregate. A card carries counts and money, never a child's
   name — someone who needs a name uses "Open" to enter that school properly,
   where the audit trail records that they did. */

interface CampusCard {
  institution_id: string
  school: string
  campus: string
  district?: string
  students: number
  staff: number
  attendance_pct?: number
  marked_today: number
  collected_paise: number
  outstanding_paise: number
  defaulters: number
}
interface Alert {
  severity: 'high' | 'medium' | 'low'
  kind: string
  school?: string
  message: string
}
interface Dashboard {
  range: { label: string }
  schools: number
  campuses: number
  students: number
  staff: number
  collected_paise: number
  outstanding_paise: number
  /* Everything ever billed across the group, cancellations aside. */
  billed_paise: number
  campuses_detail: CampusCard[]
  alerts: Alert[]
  attendance_trend: { date: string; percent: number; marked: number }[]
}

const SEVERITY: Record<string, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

export default function PlatformDashboard() {
  /* Which campus is open, if any. State rather than a route: the panel is read
     and dismissed in about four seconds, and a page you have to navigate back
     from is a page you stop opening. */
  const [openCampus, setOpenCampus] = useState<CampusCard | null>(null)

  const [range, setRange] = useRange()
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<{ items: RangeOption[] }>('/api/v1/date-ranges'),
  })

  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-dashboard', rangeQuery(range)],
    queryFn: () => api.get<Dashboard>(`/api/v1/admin/platform-dashboard?${rangeQuery(range)}`),
  })

  if (isLoading) return <Loading label="Adding up every campus…" />
  if (error) return <ErrorState error={error} />
  const d = data!

  // Conversion is the number a trust actually manages the funnel by.

  return (
    <>
      <PageHead
        eyebrow="Platform"
        title="All campuses"
        description="Every school on this installation, in one place."
        actions={
          <RangePicker
            value={range}
            onChange={setRange as (r: ActiveRange) => void}
            options={presets.data?.items ?? []}
            label={data?.range?.label}
          />
        }
        width="wide"
      />
      <PageBody width="wide">
        {/* The whole group in four figures.

            How many children, how many staff, what has been billed and what is
            still owed. An operator is asked those four and nothing else; the
            funnel and the daily alerts belong to the people running a school,
            and both have screens of their own. */}
        <CellGrid cols={4}>
          <Stat label="Students" value={d.students} icon={Users}
            hint={`${d.schools} schools · ${d.campuses} campuses`} />
          <Stat label="Staff" value={d.staff} />
          {/* Billed, not collected. Collected answers how a month went;
              this answers how big the group is, which is the one an operator
              is actually asked for. Collection is a campus question and sits
              on the campus cards below. */}
          <Stat label="Total fee billed" value={formatPaise(d.billed_paise)}
            icon={IndianRupee} period="all time" />
          {/* A balance is true now, not over a period. Saying so on the card
              stops anyone reporting it as a period figure. */}
          <Stat label="Outstanding" value={formatPaise(d.outstanding_paise)}
            period="as of today"
            delta={d.outstanding_paise > 0 ? { value: 'Owed to the group', positive: false } : undefined} />
        </CellGrid>

        {d.alerts.length > 0 && (
          <Card>
            <CardHeader
              title="Needs attention"
              description="Recomputed each time this opens, so an alert disappears when the thing it describes is fixed"
              action={<AlertTriangle className="h-4 w-4 text-muted-foreground" />}
            />
            <ul className="divide-y">
              {d.alerts.map((a, i) => (
                <li key={i} className="flex items-start gap-3 px-5 py-3">
                  <Badge tone={SEVERITY[a.severity]}>{a.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-[14px]">{a.message}</p>
                    {a.school && (
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{a.school}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Campuses"
            description="Ordered by what is outstanding — the campus needing attention first. Open one for its own totals."
          />
          {d.campuses_detail.length === 0 ? (
            <EmptyState title="No campuses yet" />
          ) : (
            /* Cards, not a table.

               A table gives every column equal weight, which is right for a
               register and wrong for six campuses: the question here is which
               one needs somebody today, and a row of seven equal cells does
               not answer it. The two figures that decide it are set at the
               size the eye reads first, and the order does the rest — most
               outstanding at the front. */
            <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
              {[...d.campuses_detail]
                .sort((a, b) => b.outstanding_paise - a.outstanding_paise)
                .map((c) => {
                  const billed = c.collected_paise + c.outstanding_paise
                  const owedPct = billed > 0 ? Math.round((c.outstanding_paise / billed) * 100) : 0
                  /* "Watch" is a quarter of the year's billing still owed. A
                     threshold rather than a ranking, because the campus at the
                     front of the list is always first — that says nothing
                     about whether it is a problem. */
                  const watch = owedPct >= 25
                  return (
                    <button
                      key={c.institution_id + c.campus}
                      type="button"
                      onClick={() => setOpenCampus(c)}
                      className={cn(
                        'rounded-lg border bg-card p-5 text-left transition-colors',
                        'hover:border-primary/40 hover:bg-accent/40',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[15px] font-semibold">{c.campus}</div>
                          <div className="truncate text-[12.5px] text-muted-foreground">
                            {c.school}
                            {c.district && ` · ${c.district}`}
                          </div>
                          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                            {c.students} students · {c.staff} staff
                          </div>
                        </div>
                        {watch && <Badge tone="warning">watch</Badge>}
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-4 border-y py-3">
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                            Fee collected
                          </div>
                          <div className="num mt-1 text-[19px] font-semibold">
                            {formatPaise(c.collected_paise)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                            Outstanding
                          </div>
                          <div
                            className={cn(
                              'num mt-1 text-[19px] font-semibold',
                              watch && 'text-destructive',
                            )}
                          >
                            {formatPaise(c.outstanding_paise)}
                          </div>
                          <div className="text-[12px] text-muted-foreground">
                            {billed > 0 ? `${owedPct}% of billed` : 'nothing billed yet'}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center justify-between text-[13px]">
                        <span className="text-muted-foreground">
                          {/* Null and zero are different emergencies: "nobody
                              came" versus "nobody has taken the register". */}
                          {c.attendance_pct == null
                            ? c.students > 0
                              ? 'Register not taken'
                              : '—'
                            : `${c.attendance_pct}% present today`}
                        </span>
                        <span className="font-medium text-primary">Open →</span>
                      </div>
                    </button>
                  )
                })}
            </div>
          )}
        </Card>

        {openCampus && (
          <CampusDetail c={openCampus} onClose={() => setOpenCampus(null)} />
        )}
      </PageBody>
    </>
  )
}

/* What one campus adds up to.

   The card carries the two figures that decide where to look; this carries the
   rest, and only when it is asked for. A panel rather than another screen
   because the answer to "how big is Hyderabad" is read and dismissed in about
   four seconds, and a page you have to navigate back from is a page you stop
   opening. */
function CampusDetail({ c, onClose }: { c: CampusCard; onClose: () => void }) {
  const billed = c.collected_paise + c.outstanding_paise
  const owedPct = billed > 0 ? Math.round((c.outstanding_paise / billed) * 100) : 0
  const qc = useQueryClient()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${c.campus}, ${c.school}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-lg rounded-xl border bg-card shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold">{c.campus}</h2>
            <p className="truncate text-[13px] text-muted-foreground">
              {c.school}
              {c.district && ` · ${c.district}`}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 p-5">
          <div className="rounded-lg border bg-surface-subtle p-4">
            <div className="text-[12px] font-medium text-muted-foreground">Total students</div>
            <div className="num mt-1 text-[22px] font-semibold">{c.students}</div>
          </div>
          <div className="rounded-lg border bg-surface-subtle p-4">
            <div className="text-[12px] font-medium text-muted-foreground">Total staff</div>
            <div className="num mt-1 text-[22px] font-semibold">{c.staff}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 px-5 pb-2">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              Fee collected
            </div>
            <div className="num mt-1 text-[19px] font-semibold">
              {formatPaise(c.collected_paise)}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              Outstanding
            </div>
            <div className="num mt-1 text-[19px] font-semibold text-destructive">
              {formatPaise(c.outstanding_paise)}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {billed > 0 ? `${owedPct}% of ${formatPaise(billed)} billed` : 'nothing billed yet'}
              {c.defaulters > 0 && ` · ${c.defaulters} owing`}
            </div>
          </div>
        </div>

        <div className="px-5 pb-3 text-[13px] text-muted-foreground">
          {c.attendance_pct == null
            ? c.students > 0
              ? 'The register has not been taken today.'
              : 'No students enrolled yet.'
            : `${c.attendance_pct}% present today, from ${c.marked_today} marked.`}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => {
              setActingInstitution(c.institution_id)
              qc.invalidateQueries()
              onClose()
            }}
          >
            <Building2 className="h-3.5 w-3.5" />
            Work inside this school
          </Button>
        </div>
      </div>
    </div>
  )
}
