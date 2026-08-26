import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TrendingDown, HelpCircle, UserMinus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Select, Textarea,
  Loading, ErrorState, EmptyState, RangePicker, rangeQuery, useRange,
  type RangeOption,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { useToast } from '@/components/Toast'
import {
  ADMISSIONS_BASE as A, LOST_DIMENSIONS, errText, labelOf, useLeads, useLostReasons,
  type LostAnalysisRow, type LostLead,
} from './growth'

/* Why the family did not come.

   A school can always tell you how many enquiries it lost. Almost none can
   tell you why, because the reason lives in the counsellor's head at the
   moment they give up and nowhere afterwards. So the reason is recorded at
   that moment, as a code the school can extend, with a note for the half of
   cases a code cannot carry.

   The value is the pattern rather than the row. "We lost 38% of Class 1 on
   fees" is a pricing conversation; "we lost forty enquiries" is not a
   conversation at all. Hence the grouping: reason, class sought, source,
   counsellor, and over time.

   Two things this screen refuses to do. It will not show a share below five
   enquiries in a bucket — one lost enquiry from a newspaper is not a 100% loss
   rate, and printing it as one is how a school cancels the advertisement that
   was working. And grouping by month uses the month the enquiry ARRIVED, not
   the month it was lost, because every bucket of the latter contains only lost
   rows and therefore reports 100% forever. */

export default function LostLeads() {
  const toast = useToast()
  const qc = useQueryClient()
  const [range, setRange] = useRange()
  const [by, setBy] = useState('reason')
  const [leadID, setLeadID] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [reasonFilter, setReasonFilter] = useState('')

  const reasons = useLostReasons()
  const leads = useLeads()

  // The period presets come from the server so the picker cannot drift from
  // the resolver that reads them.
  const presets = useQuery({
    queryKey: ['date-ranges'],
    queryFn: () => api.get<List<RangeOption>>('/api/v1/date-ranges'),
  })

  const q = rangeQuery(range)

  const lost = useQuery({
    queryKey: ['admissions-lost-leads', q, reasonFilter],
    queryFn: () =>
      api.get<List<LostLead>>(
        `${A}/lost-leads?${q}${reasonFilter ? `&reason=${reasonFilter}` : ''}`,
      ),
  })

  const analysis = useQuery({
    queryKey: ['admissions-lost-analysis', by, q],
    queryFn: () => api.get<List<LostAnalysisRow>>(`${A}/lost-leads/analysis?by=${by}&${q}`),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admissions-lost-leads'] })
    qc.invalidateQueries({ queryKey: ['admissions-lost-analysis'] })
    qc.invalidateQueries({ queryKey: ['admissions-leads'] })
    qc.invalidateQueries({ queryKey: ['admissions-campaign-enrolments'] })
  }

  const markLost = useMutation({
    mutationFn: () => api.post(`${A}/leads/${leadID}/lost`, { reason, note: note || undefined }),
    onSuccess: () => {
      toast.ok('Closed, and any nurture sequence stopped')
      setLeadID('')
      setReason('')
      setNote('')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const reopen = useMutation({
    mutationFn: (id: string) => api.post(`${A}/leads/${id}/reopen`, {}),
    onSuccess: () => {
      toast.ok('Reopened')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  const optOut = useMutation({
    mutationFn: (id: string) => api.post(`${A}/leads/${id}/opt-out`, {}),
    onSuccess: () => {
      toast.ok('Recorded — every sequence for this parent has stopped')
      invalidate()
    },
    onError: (e) => toast.error(errText(e)),
  })

  if (reasons.isLoading || leads.isLoading) return <Loading />
  if (reasons.error) return <ErrorState error={reasons.error} />
  if (leads.error) return <ErrorState error={leads.error} />

  const reasonOptions = reasons.data?.items ?? []
  const openLeads = (leads.data?.items ?? []).filter((l) => l.status !== 'lost')
  const lostRows = lost.data?.items ?? []
  /* Somebody reviewing why families walked away looks for a family, a
     counsellor or a reason — none of which a date-ordered list surfaces. */
  const { q: term, setQ: setTerm, shown } = useSearch(lostRows,
    (r) => [r.student_name, r.parent_name, r.class_sought, r.source, r.counsellor,
            r.reason_label, r.note])
  const analysisRows = analysis.data?.items ?? []
  const unrecorded = lostRows.filter((r) => !r.reason).length
  const topRow = [...analysisRows].sort((a, b) => b.lost - a.lost)[0]

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title="Lost lead reason analysis"
        description="Why enquiries did not convert, grouped the four ways a pattern shows up in."
        actions={
          <RangePicker value={range} onChange={setRange} options={presets.data?.items ?? []} />
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Lost in this period" value={lostRows.length} icon={TrendingDown} />
          <Stat label="No reason recorded" value={unrecorded} icon={HelpCircle} />
          <Stat label="Biggest single group" value={topRow ? topRow.group : '—'} />
          <Stat
            label="…and how many that is"
            value={topRow ? `${topRow.lost}${topRow.share_percent != null ? ` (${topRow.share_percent}%)` : ''}` : '—'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Close a lead"
            description="The reason is required. The moment the counsellor gives up is the only moment anybody still knows the answer."
          />
          <div className="space-y-5 p-5">
            <FormGrid>
              <Field label="Lead" required>
                <Select
                  value={leadID}
                  onChange={setLeadID}
                  options={openLeads.map((l) => ({
                    value: l.id,
                    label: `${l.student_name}${l.class_sought ? ` · ${l.class_sought}` : ''} · ${l.status}`,
                  }))}
                  placeholder="Choose a lead…"
                />
              </Field>
              <Field
                label="Reason"
                required
                hint="Not on the list? Add it to your school's own reasons under Setup → Lists."
              >
                <Select
                  value={reason}
                  onChange={setReason}
                  options={reasonOptions}
                  placeholder="Choose a reason…"
                />
              </Field>
              <Field
                label="Note"
                hint="What a code cannot carry: “wanted a 30% concession”, “moving to Pune in June”."
                wide
              >
                <Textarea value={note} onChange={setNote} rows={2} />
              </Field>
            </FormGrid>
            <FormNotice error={markLost.error} />
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => markLost.mutate()}
                disabled={!leadID || !reason || markLost.isPending}
              >
                Close as lost
              </Button>
              <Button
                variant="outline"
                onClick={() => optOut.mutate(leadID)}
                disabled={!leadID || optOut.isPending}
              >
                <UserMinus className="h-3.5 w-3.5" />
                They asked not to be contacted
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="The pattern"
            description="Share is withheld below five enquiries in a group — one lost enquiry is not a rate."
            action={
              <div className="w-[220px]">
                <Select value={by} onChange={setBy} options={LOST_DIMENSIONS} />
              </div>
            }
          />
          {analysis.error ? (
            <div className="p-5">
              <ErrorState error={analysis.error} />
            </div>
          ) : (
            <Table
              head={[
                labelOf(LOST_DIMENSIONS, by).replace(/^By /, ''),
                { label: 'Lost', align: 'right' },
                { label: 'Enquiries', align: 'right' },
                { label: 'Share', align: 'right' },
                'Mostly because of',
              ]}
              empty={!analysis.isLoading && analysisRows.length === 0}
              emptyLabel="Nothing lost in this period."
            >
              {analysisRows.map((r) => (
                <tr key={r.group}>
                  <Td>{r.group}</Td>
                  <Td className="text-right tabular-nums">{r.lost}</Td>
                  <Td className="text-right tabular-nums">{r.total}</Td>
                  <Td className="text-right tabular-nums">
                    {r.share_percent != null ? (
                      <Badge tone={r.share_percent >= 40 ? 'warning' : 'neutral'} solid>
                        {r.share_percent}%
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">too few</span>
                    )}
                  </Td>
                  <Td className="text-[13px] text-muted-foreground">
                    {r.top_reason ? `${r.top_reason} (${r.top_reason_count ?? 0})` : '—'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="The leads themselves"
            description="How long each was worked before the school gave up."
            action={
              <span className="flex flex-wrap items-center gap-2">
                <Showing shown={shown.length} total={lostRows.length} noun="leads" />
                <SearchBox value={term} onChange={setTerm} placeholder="Family, counsellor or reason" />
                <ExportRows
                  rows={shown}
                  name="lost-leads"
                  columns={[
                    { header: 'Student', value: (r) => r.student_name },
                    { header: 'Parent', value: (r) => r.parent_name },
                    { header: 'Class sought', value: (r) => r.class_sought },
                    { header: 'Source', value: (r) => r.source },
                    { header: 'Counsellor', value: (r) => r.counsellor },
                    { header: 'Reason', value: (r) => r.reason_label },
                    { header: 'Note', value: (r) => r.note },
                    { header: 'Days worked', value: (r) => r.days_worked },
                    { header: 'Lost on', value: (r) => r.lost_on },
                  ]}
                />
                <div className="w-[220px]">
                <Select
                  value={reasonFilter}
                  onChange={setReasonFilter}
                  options={reasonOptions}
                  placeholder="Every reason"
                />
                </div>
              </span>
            }
          />
          {lost.error ? (
            <div className="p-5">
              <ErrorState error={lost.error} />
            </div>
          ) : (
            <Table
              head={[
                'Parent', 'Class sought', 'Source', 'Counsellor', 'Reason', 'Note',
                { label: 'Worked for', align: 'right' }, 'Lost on', '',
              ]}
              empty={!lost.isLoading && shown.length === 0}
              emptyLabel={term
                ? 'No lost lead matches that.'
                : 'Nothing closed as lost in this period.'}
            >
              {shown.map((r) => (
                <tr key={r.id}>
                  <Td>
                    {r.student_name}
                    {r.parent_name && (
                      <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                        {r.parent_name}
                      </span>
                    )}
                  </Td>
                  <Td>{r.class_sought ?? '—'}</Td>
                  <Td>{r.source}</Td>
                  <Td>{r.counsellor ?? 'Unassigned'}</Td>
                  <Td>
                    {r.reason ? (
                      r.reason_label
                    ) : (
                      <Badge tone="warning">Not recorded</Badge>
                    )}
                  </Td>
                  <Td className="text-[12.5px] text-muted-foreground">{r.note ?? '—'}</Td>
                  <Td className="text-right tabular-nums">{r.days_worked} d</Td>
                  <Td>{r.lost_on ?? '—'}</Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => reopen.mutate(r.id)}
                      disabled={reopen.isPending}
                    >
                      Reopen
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {unrecorded > 0 && (
          <EmptyState
            title={`${unrecorded} lost leads carry no reason`}
            body="They predate this screen, or were closed elsewhere. They are counted as “Not recorded” rather than dropped, because pretending they do not exist would flatter every other number on this page."
          />
        )}
      </PageBody>
    </>
  )
}
