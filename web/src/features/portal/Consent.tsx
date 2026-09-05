import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSignature, ShieldCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Field,
  FormGrid, FormNotice, Input, Select, Textarea, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'

/* What is waiting on a parent's signature.

   Two different things a school asks a guardian to agree to, on one screen
   because from the family's side they are the same errand: a circular that
   carries a consent, and a request to let their child off campus.

   The outpass half is not decoration. The hostel will not sign a boarder out
   until a guardian has consented, so without somewhere to give that consent
   the pass simply never completes — the warden's screen would show "waiting
   on the guardian" forever. */

interface Outpass {
  id: string
  student_name: string
  reason: string
  destination?: string
  escort_name?: string
  escort_phone?: string
  expected_out: string
  expected_in: string
  status: 'requested' | 'approved' | 'rejected' | 'out' | 'returned' | 'cancelled'
  approved_by?: string
  guardian_consent_by?: string
  decision_note?: string
  overdue: boolean
}
interface Circular {
  id: string
  title: string
  body?: string
  kind: string
  requires_ack: boolean
  published_at: string
  acknowledged_by_me: boolean
}
interface Child {
  student_id: string
  full_name: string
}

const TONE: Record<Outpass['status'], 'neutral' | 'warning' | 'success' | 'danger'> = {
  requested: 'warning',
  approved: 'success',
  rejected: 'danger',
  out: 'warning',
  returned: 'neutral',
  cancelled: 'neutral',
}

export default function Consent() {
  const t = useT()
  const qc = useQueryClient()

  const passes = useQuery({
    queryKey: ['outpasses'],
    queryFn: () => api.get<List<Outpass>>('/api/v1/ops/hostel/outpasses'),
  })
  const circulars = useQuery({
    queryKey: ['circulars'],
    queryFn: () => api.get<List<Circular>>('/api/v1/communication/circulars'),
  })
  const children = useQuery({
    queryKey: ['my-students'],
    queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
  })

  const consent = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/ops/hostel/outpasses/${id}/decide`, { action: 'consent' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outpasses'] }),
  })
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/communication/circulars/${id}/ack`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['circulars'] }),
  })

  if (passes.isLoading) return <ScreenSkeleton label={t('portal.consent.loading')} />
  if (passes.error && !passes.data) return <ScreenError error={passes.error} />

  const allPasses = passes.data?.items ?? []
  const needConsent = allPasses.filter(
    (p) => !p.guardian_consent_by && (p.status === 'requested' || p.status === 'approved'),
  )
  const unsigned = (circulars.data?.items ?? []).filter(
    (c) => c.requires_ack && !c.acknowledged_by_me,
  )

  return (
    <>
      <PageHead
        eyebrow={t('portal.consent.eyebrow')}
        title={t('portal.consent.title')}
        description={t('portal.consent.description')}
      />
      <Freshness query={passes} />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.consent.stat_trips')} value={needConsent.length} icon={ShieldCheck} />
          <Stat label={t('portal.consent.stat_circulars')} value={unsigned.length} icon={FileSignature} />
          <Stat label={t('portal.consent.stat_out_now')} value={allPasses.filter((p) => p.status === 'out').length} />
        </CellGrid>

        <Card>
          <CardHeader
            title={t('portal.consent.trips_title')}
            description={t('portal.consent.trips_description')}
          />
          {needConsent.length === 0 ? (
            <EmptyState
              title={t('portal.consent.trips_empty_title')}
              body={t('portal.consent.trips_empty_body')}
            />
          ) : (
            <ul className="divide-y">
              {needConsent.map((p) => (
                <li key={p.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-[16rem] flex-1">
                      <div className="font-medium">
                        {p.student_name} · {p.destination ?? p.reason}
                      </div>
                      <div className="text-[13px] text-muted-foreground">
                        {t('portal.consent.pass_window', {
                          from: formatDate(p.expected_out),
                          to: formatDate(p.expected_in),
                        })}
                      </div>
                      {p.escort_name && (
                        <div className="text-[13px] text-muted-foreground">
                          {t('portal.consent.going_with', { name: p.escort_name })}
                          {p.escort_phone && ` · ${p.escort_phone}`}
                        </div>
                      )}
                      <div className="mt-1 text-[12px] text-muted-foreground">
                        {p.approved_by
                          ? t('portal.consent.warden_permitted', { name: p.approved_by })
                          : t('portal.consent.warden_not_permitted')}
                      </div>
                    </div>
                    <Button disabled={consent.isPending} onClick={() => consent.mutate(p.id)}>
                      {t('portal.consent.action_agree')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <FormNotice error={consent.error} />
        </Card>

        <RequestTrip children_={children.data?.items ?? []} />

        <Card>
          <CardHeader
            title={t('portal.consent.circulars_title')}
            description={t('portal.consent.circulars_description')}
          />
          {unsigned.length === 0 ? (
            <EmptyState
              title={t('portal.consent.circulars_empty_title')}
              body={t('portal.consent.circulars_empty_body')}
            />
          ) : (
            <ul className="divide-y">
              {unsigned.map((c) => (
                <li key={c.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-[16rem] flex-1">
                    <div className="font-medium">{c.title}</div>
                    {c.body && (
                      <div className="text-[13px] text-muted-foreground">{c.body}</div>
                    )}
                    <div className="text-[12px] text-muted-foreground">
                      {formatDate(c.published_at)}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={ack.isPending}
                    onClick={() => ack.mutate(c.id)}
                  >
                    {t('portal.consent.action_ack')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <FormNotice error={ack.error} />
        </Card>

        <PassHistory rows={allPasses} />
      </PageBody>
    </>
  )
}

/** A guardian asking for a trip, rather than only agreeing to one. */
function RequestTrip({ children_ }: { children_: Child[] }) {
  const t = useT()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('')
  const [reason, setReason] = useState('')
  const [destination, setDestination] = useState('')
  const [escort, setEscort] = useState('')
  const [phone, setPhone] = useState('')
  const [out, setOut] = useState('')
  const [back, setBack] = useState('')

  /* Whose pass this is, decided the same way every other family screen decides
     it: one child needs no choosing, more than one must be chosen. The picker
     below is only drawn for the second case, so a lone child would never set
     the field and requiring it would lock that parent out of the form. */
  const student = picked || (children_.length === 1 ? children_[0].student_id : '')

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/hostel/outpasses', {
        student_id: student,
        reason,
        destination,
        escort_name: escort,
        escort_phone: phone,
        expected_out: out,
        expected_in: back,
      }),
    onSuccess: () => {
      setOpen(false)
      setReason('')
      setDestination('')
      qc.invalidateQueries({ queryKey: ['outpasses'] })
    },
  })

  if (!open) {
    return (
      <Card>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex-1 text-[14px] text-muted-foreground">
            {t('portal.consent.request_prompt')}
          </div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t('portal.consent.request_action')}
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title={t('portal.consent.request_title')}
        description={t('portal.consent.request_description')}
      />
      <div className="p-4">
        <FormGrid>
          {children_.length > 1 && (
            <Field label={t('portal.consent.field_child')}>
              <Select
                value={student}
                onChange={setPicked}
                placeholder={t('portal.consent.field_child_placeholder')}
                options={children_.map((c) => ({ value: c.student_id, label: c.full_name }))}
              />
            </Field>
          )}
          <Field label={t('portal.consent.field_going_to')}>
            <Input
              value={destination}
              onChange={setDestination}
              placeholder={t('portal.consent.field_going_to_placeholder')}
            />
          </Field>
          <Field label={t('portal.consent.field_leaving')} hint={t('portal.consent.field_leaving_hint')}>
            <Input type="datetime-local" value={out} onChange={setOut} />
          </Field>
          <Field label={t('portal.consent.field_back_by')} hint={t('portal.consent.field_back_by_hint')}>
            <Input type="datetime-local" value={back} onChange={setBack} />
          </Field>
          <Field label={t('portal.consent.field_escort')}>
            <Input
              value={escort}
              onChange={setEscort}
              placeholder={t('portal.consent.field_escort_placeholder')}
            />
          </Field>
          <Field label={t('portal.consent.field_escort_phone')}>
            <Input
              value={phone}
              onChange={setPhone}
              placeholder={t('portal.consent.field_escort_phone_placeholder')}
            />
          </Field>
          <Field label={t('portal.consent.field_reason')} wide required>
            <Textarea
              rows={2}
              value={reason}
              onChange={setReason}
              placeholder={t('portal.consent.field_reason_placeholder')}
            />
          </Field>
        </FormGrid>
        <div className="mt-4 flex gap-2">
          <Button
            disabled={create.isPending || !student || reason.trim() === '' || !out || !back}
            onClick={() => create.mutate()}
          >
            {create.isPending ? t('portal.consent.action_sending') : t('portal.consent.action_send')}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
        </div>
        <FormNotice error={create.error} />
      </div>
    </Card>
  )
}

function PassHistory({ rows }: { rows: Outpass[] }) {
  const t = useT()
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader
        title={t('portal.consent.history_title')}
        description={t('portal.consent.history_description')}
      />
      <ul className="divide-y">
        {rows.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="min-w-[14rem] flex-1">
              <span className="font-medium">{p.student_name}</span>
              <span className="text-muted-foreground"> · {p.destination ?? p.reason}</span>
              <div className="text-[12px] text-muted-foreground">
                {formatDate(p.expected_out)}
                {p.decision_note && ` · ${p.decision_note}`}
              </div>
            </div>
            <Badge tone={TONE[p.status]}>{p.status}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  )
}
