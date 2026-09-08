import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, type List, type AcademicYear } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Button, Select,
  Checkbox, FormNotice, EmptyState, ErrorState, Badge,
} from '@/components/ui'

/* Year rollover — the April that used to be rebuilt by hand.
 *
 * Sections, the fee structure, bus allocations and the timetable grid are all
 * per academic year, and until this screen nothing carried them forward. The
 * preview runs the same copy the button runs and rolls it back, so the counts
 * shown are the counts that will be written, not an estimate.
 *
 * The children are not moved here. Promotion is a decision per section on the
 * results, with its own screen, and is linked rather than duplicated.
 */

interface Item {
  requested: boolean
  copied: number
  in_source: number
  already_rolled?: boolean
  rolled_at?: string
  shared?: boolean
  note?: string
}

interface Result {
  source: { id: string; name: string }
  target: { id: string; name: string }
  preview: boolean
  items: Record<string, Item>
  promotion_path: string
}

const ITEMS: { key: string; label: string; hint: string }[] = [
  { key: 'sections', label: 'Sections', hint: 'Same names, capacity and room per class. Class teachers are not carried.' },
  { key: 'fee_structure', label: 'Fee structure', hint: 'Each active structure becomes a draft for the new year. Nothing is activated.' },
  { key: 'transport', label: 'Bus allocations', hint: 'Each child keeps their route and stop. Only children already enrolled in the new year, so promote first.' },
  { key: 'timetable', label: 'Timetable grid', hint: 'Which subject sits in which period, per section. Teachers are left for Teacher Assignment.' },
  { key: 'hostel', label: 'Hostel', hint: 'Rooms and beds are shared across years.' },
  { key: 'subjects', label: 'Subjects per class', hint: 'Shared across years.' },
]

const DEFAULT_TICKS: Record<string, boolean> = {
  sections: true, fee_structure: true, transport: true, timetable: true, hostel: false, subjects: false,
}

export default function YearRollover() {
  const qc = useQueryClient()
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [ticks, setTicks] = useState<Record<string, boolean>>(DEFAULT_TICKS)
  const [done, setDone] = useState<Result | null>(null)

  const years = useQuery({
    queryKey: ['years'],
    queryFn: () => api.get<List<AcademicYear>>('/api/v1/academics/years'),
  })
  const yearList = years.data?.items ?? []
  const current = yearList.find((y) => y.is_current)

  // Sensible defaults once the years load: from the current year into the
  // newest one that is not it.
  const sourceID = source || current?.id || ''
  const targetID = target || yearList.find((y) => !y.is_current && y.starts_on > (current?.starts_on ?? ''))?.id || ''

  const params = useMemo(() => {
    const p = new URLSearchParams({ target_year_id: targetID })
    for (const [k, v] of Object.entries(ticks)) if (v) p.set(k, '1')
    return p.toString()
  }, [targetID, ticks])

  const preview = useQuery({
    queryKey: ['rollover-preview', sourceID, params],
    queryFn: () => api.get<Result>(`/api/v1/admin/academic-years/${sourceID}/rollover?${params}`),
    enabled: !!sourceID && !!targetID && sourceID !== targetID,
    retry: false,
  })

  const run = useMutation({
    mutationFn: () => api.post<Result>(`/api/v1/admin/academic-years/${sourceID}/rollover`, {
      target_year_id: targetID, ...ticks,
    }),
    onSuccess: (r) => {
      setDone(r)
      qc.invalidateQueries({ queryKey: ['rollover-preview'] })
      qc.invalidateQueries({ queryKey: ['sections'] })
    },
  })

  const shown = done ?? preview.data
  const willCopy = Object.entries(preview.data?.items ?? {})
    .filter(([, it]) => it.requested && !it.shared && !it.already_rolled)
    .reduce((n, [, it]) => n + it.copied, 0)
  const targetYear = yearList.find((y) => y.id === targetID)
  const ready = !!sourceID && !!targetID && sourceID !== targetID && !targetYear?.is_current && willCopy > 0

  const yearOpts = yearList.map((y) => ({ value: y.id, label: y.name + (y.is_current ? ' (current)' : '') }))

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Year rollover"
        description="Carry this year's structure into the next, once. Children move separately under Class Promotion."
      />
      <PageBody>
        <Card>
          <CardHeader title="From which year, into which" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Copy from</span>
              <Select value={sourceID} onChange={(v) => { setSource(v); setDone(null) }} options={yearOpts} placeholder="Select…" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Into</span>
              <Select
                value={targetID}
                onChange={(v) => { setTarget(v); setDone(null) }}
                options={yearOpts.filter((o) => o.value !== sourceID)}
                placeholder="Select…"
              />
            </label>
          </div>
          {targetYear?.is_current && (
            <p className="px-5 pb-4 text-[13px] text-destructive">
              That is the current year — the one children are enrolled in today. Roll into the year that has not started.
            </p>
          )}
          {years.data && yearList.length < 2 && (
            <p className="px-5 pb-4 text-[13px] text-muted-foreground">
              Create the new academic year under School setup first, then come back here.
            </p>
          )}
          <div className="grid gap-3 border-t p-5 sm:grid-cols-2">
            {ITEMS.map((it) => {
              const shared = !!shown?.items?.[it.key]?.shared
              return (
                <Checkbox
                  key={it.key}
                  checked={!shared && !!ticks[it.key]}
                  onChange={(v) => { if (!shared) { setTicks((t) => ({ ...t, [it.key]: v })); setDone(null) } }}
                  label={it.label}
                  hint={shown?.items?.[it.key]?.note ?? it.hint}
                />
              )
            })}
          </div>
          <FormNotice error={run.error ?? preview.error} ok={done ? `Rolled ${done.source.name} into ${done.target.name}.` : undefined} />
        </Card>

        {!targetID ? (
          <Card>
            <div className="p-6">
              <EmptyState title="Pick the year to roll into" body="What will be copied appears here before anything is written." />
            </div>
          </Card>
        ) : preview.error && !done ? (
          <ErrorState error={preview.error} />
        ) : shown ? (
          <Card>
            <CardHeader
              title={done ? 'What was copied' : 'What will be copied'}
              action={
                <Button onClick={() => run.mutate()} pending={run.isPending} disabled={!ready || !!done}>
                  {done ? 'Done' : `Roll ${shown.source.name} into ${shown.target.name}`}
                </Button>
              }
            />
            <Table head={['Item', `In ${shown.source.name}`, done ? 'Copied' : 'Will copy', 'Status']} empty={false}>
              {ITEMS.map((it) => {
                const row = shown.items[it.key]
                if (!row) return null
                return (
                  <tr key={it.key}>
                    <Td className="font-medium">{it.label}</Td>
                    <Td>{row.in_source}</Td>
                    <Td>{row.shared || !row.requested ? '—' : row.copied}</Td>
                    <Td>
                      {row.shared ? <Badge tone="neutral">Shared across years</Badge>
                        : row.already_rolled ? <Badge tone="success">Already carried {row.rolled_at}</Badge>
                        : !row.requested ? <Badge tone="neutral">Not ticked</Badge>
                        : row.copied === 0 && row.in_source > 0 ? <Badge tone="warning">Nothing new to copy</Badge>
                        : done ? <Badge tone="success">Copied</Badge>
                        : <Badge tone="neutral">Ready</Badge>}
                    </Td>
                  </tr>
                )
              })}
            </Table>
            <p className="px-5 py-4 text-[13px] text-muted-foreground">
              Running twice is safe: an item already carried into {shown.target.name} is skipped. The children themselves
              move under{' '}
              <Link className="underline" to="/go/class_promotion">Class Promotion</Link>
              , one section at a time, on the results.
            </p>
          </Card>
        ) : null}
      </PageBody>
    </>
  )
}
