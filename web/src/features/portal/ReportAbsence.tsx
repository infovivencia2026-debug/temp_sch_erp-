import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Field, FormGrid,
  FormNotice, Input, Select, Textarea, Loading, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { formatDate } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
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
  'Parent emergency',
  'Other',
]

// The value is what the server is told and what the form compares against; only
// the label is shown to a parent, so only the label is translated.
const REASON_KEYS: Record<string, MessageKey> = {
  Fever: 'portal.report_absence.reason_fever',
  'Cold and cough': 'portal.report_absence.reason_cold',
  'Stomach upset': 'portal.report_absence.reason_stomach',
  'Doctor’s appointment': 'portal.report_absence.reason_doctor',
  'Parent emergency': 'portal.report_absence.reason_family',
  Other: 'portal.report_absence.reason_other',
}

export default function ReportAbsence() {
  const t = useT()
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

  if (query.isLoading) return <Loading label={t('portal.report_absence.loading')} />
  if (query.error) return <ScreenError error={query.error} />

  const ready = studentId !== '' && (reason !== 'Other' || detail.trim() !== '')
  const today = (recent.data?.items ?? []).filter(
    (r) => r.status === 'pending' || r.status === 'approved',
  )

  return (
    <>
      <PageHead
        eyebrow={t('portal.report_absence.eyebrow')}
        title={t('portal.report_absence.title')}
        description={t('portal.report_absence.description')}
      />
      <PageBody>
        <Card>
          <CardHeader
            title={t('portal.report_absence.form_title')}
            description={t('portal.report_absence.form_description')}
          />
          <div className="p-4">
            <FormGrid>
              {children.length > 1 && (
                <Field label={t('portal.report_absence.field_child')} required>
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    placeholder={t('portal.report_absence.choose_child')}
                    options={childOptions(children)}
                  />
                </Field>
              )}
              <Field label={t('portal.report_absence.field_why')} required>
                <Select
                  value={reason}
                  onChange={setReason}
                  kind="absence_reason"
                  addLabel="Add a reason"
                  options={REASONS.map((r) => ({ value: r, label: t(REASON_KEYS[r]) }))}
                />
              </Field>
              <Field
                label={t('portal.report_absence.field_day')}
                hint={t('portal.report_absence.field_day_hint')}
              >
                <Input type="date" value={onDate} onChange={setOnDate} />
              </Field>
              <Field
                label={
                  reason === 'Other'
                    ? t('portal.report_absence.field_detail_other')
                    : t('portal.report_absence.field_detail')
                }
                required={reason === 'Other'}
                wide
              >
                <Textarea
                  rows={2}
                  value={detail}
                  onChange={setDetail}
                  placeholder={t('portal.report_absence.detail_placeholder')}
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Button
                disabled={!ready || report.isPending}
                onClick={() => report.mutate()}
              >
                {report.isPending
                  ? t('portal.report_absence.sending')
                  : t('portal.report_absence.action_tell')}
              </Button>
            </div>
            <FormNotice
              error={report.error}
              ok={report.isSuccess ? t('portal.report_absence.sent_ok') : undefined}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('portal.report_absence.list_title')}
            description={t('portal.report_absence.list_description')}
          />
          {today.length === 0 ? (
            <EmptyState
              title={t('portal.report_absence.empty_title')}
              body={t('portal.report_absence.empty_body')}
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
