import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Field, FormGrid,
  FormNotice, Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

/* "He is not coming in today."

   The one thing a parent does on a phone at seven in the morning, and the
   reason the school's office telephone is engaged from 07:30. It writes the
   same record the leave form writes, so the class teacher has one list.

   The screen will not book the future. A parent telling the school about next
   Tuesday is applying for leave, and the server refuses it here rather than
   letting the button quietly become a leave form with no reason field. */

interface LeaveRow {
  id: string
  student_name: string
  from_date: string
  to_date: string
  reason: string
  status: string
}

const REASONS = [
  'Fever',
  'Cold and cough',
  'Stomach upset',
  'Doctor’s appointment',
  'Family emergency',
  'Other',
]

export default function ReportAbsence() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen, query } = useChildren()
  const [reason, setReason] = useState('Fever')
  const [detail, setDetail] = useState('')
  const [onDate, setOnDate] = useState('')

  const recent = useQuery({
    queryKey: ['portal-leave'],
    queryFn: () => api.get<List<LeaveRow>>('/api/v1/portal/leave'),
  })

  const report = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/absence', {
        student_id: studentId,
        on_date: onDate || undefined,
        reason: reason === 'Other' ? detail : detail ? `${reason} — ${detail}` : reason,
      }),
    onSuccess: () => {
      setDetail('')
      setOnDate('')
      qc.invalidateQueries({ queryKey: ['portal-leave'] })
    },
  })

  if (query.isLoading) return <Loading label="Finding your children…" />
  if (query.error) return <ErrorState error={query.error} />

  const ready = studentId !== '' && (reason !== 'Other' || detail.trim() !== '')
  const today = (recent.data?.items ?? []).filter(
    (r) => r.status === 'pending' || r.status === 'approved',
  )

  return (
    <>
      <PageHead
        eyebrow="Attendance"
        title="Report an absence"
        description="Tell the school your child is not coming in. It reaches the class teacher straight away."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Not coming in"
            description="For today, or a day in the last week you have not told us about yet. To book a day off ahead, apply for leave instead."
          />
          <div className="p-4">
            <FormGrid>
              {children.length > 1 && (
                <Field label="Child" required>
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    placeholder="Choose a child"
                    options={childOptions(children)}
                  />
                </Field>
              )}
              <Field label="Why" required>
                <Select
                  value={reason}
                  onChange={setReason}
                  options={REASONS.map((r) => ({ value: r, label: r }))}
                />
              </Field>
              <Field label="Which day" hint="Leave blank for today.">
                <Input type="date" value={onDate} onChange={setOnDate} />
              </Field>
              <Field
                label={reason === 'Other' ? 'Say what happened' : 'Anything else'}
                required={reason === 'Other'}
                wide
              >
                <Textarea
                  rows={2}
                  value={detail}
                  onChange={setDetail}
                  placeholder="Running a temperature since last night"
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Button
                disabled={!ready || report.isPending}
                onClick={() => report.mutate()}
              >
                {report.isPending ? 'Telling the school…' : 'Tell the school'}
              </Button>
            </div>
            <FormNotice
              error={report.error}
              ok={report.isSuccess ? 'The class teacher has it.' : undefined}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Already reported"
            description="Days the school knows about."
          />
          {today.length === 0 ? (
            <EmptyState
              title="Nothing outstanding"
              body="You have not reported any absence the school is still holding."
            />
          ) : (
            <ul className="divide-y">
              {today.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <div className="min-w-[14rem] flex-1">
                    <span className="font-medium">{r.student_name}</span>
                    <div className="text-[12px] text-muted-foreground">
                      {formatDate(r.from_date)}
                      {r.to_date !== r.from_date && ` – ${formatDate(r.to_date)}`} · {r.reason}
                    </div>
                  </div>
                  <Badge tone={r.status === 'approved' ? 'success' : 'warning'}>{r.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}
