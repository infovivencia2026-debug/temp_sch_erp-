import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, } from '@/components/ui'
import { ScreenError } from './screen-error'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'

/* Letting somebody else collect your child.

   The paper version is a telephone call to the front desk, and it is the
   weakest point in a school's day: the receptionist cannot tell a driver from
   a stranger who has learnt a child's name.

   The code on screen is the whole point. The person collecting has to recite
   six digits the school never told them — only this screen did — and the pass
   dies the moment it is used. */

interface Pass {
  id: string
  student_id: string
  student_name: string
  full_name: string
  phone: string
  relation: string
  id_type?: string
  id_last4?: string
  valid_on: string
  reason: string
  code: string
  used_at?: string
  released_by?: string
  revoked_at?: string
  status: 'live' | 'used' | 'revoked' | 'expired'
  created_at: string
}

const TONE: Record<Pass['status'], 'success' | 'neutral' | 'danger'> = {
  live: 'success',
  used: 'neutral',
  revoked: 'danger',
  expired: 'neutral',
}

const RELATIONS = ['Driver', 'Grandparent', 'Uncle / Aunt', 'Neighbour', 'Parent friend', 'Other']

export default function Pickup() {
  const t = useT()
  const qc = useQueryClient()
  const passes = useQuery({
    queryKey: ['portal-pickup'],
    queryFn: () => api.get<List<Pass>>('/api/v1/portal/pickup'),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/portal/pickup/${id}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-pickup'] }),
  })

  if (passes.isLoading) return <Loading label={t('portal.pickup.loading')} />
  if (passes.error) return <ScreenError error={passes.error} />

  const rows = passes.data?.items ?? []
  const live = rows.filter((p) => p.status === 'live')

  return (
    <>
      <PageHead
        eyebrow={t('portal.pickup.eyebrow')}
        title={t('portal.pickup.title')}
        description={t('portal.pickup.description')}
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.pickup.stat_in_force')} value={live.length} icon={KeyRound} />
          <Stat label={t('portal.pickup.stat_used')} value={rows.filter((p) => p.status === 'used').length} />
          <Stat label={t('portal.pickup.stat_cancelled')} value={rows.filter((p) => p.status === 'revoked').length} icon={ShieldAlert} />
        </CellGrid>

        {live.length > 0 && (
          <Card>
            <CardHeader
              title={t('portal.pickup.code_title')}
              description={t('portal.pickup.code_description')}
            />
            <ul className="divide-y">
              {live.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="font-mono text-[28px] font-semibold tracking-[0.2em] tabular-nums">
                    {p.code}
                  </div>
                  <div className="min-w-[14rem] flex-1">
                    <div className="font-medium">
                      {p.full_name} · {p.relation}
                    </div>
                    <div className="text-[13px] text-muted-foreground">
                      {t('portal.pickup.collecting', {
                        child: p.student_name,
                        date: formatDate(p.valid_on),
                      })}
                    </div>
                  </div>
                  <ConfirmButton
                    confirmLabel={t('portal.pickup.cancel_confirm')}
                    question={t('portal.pickup.cancel_question')}
                    tone="danger"
                    onConfirm={() => revoke.mutate(p.id)}
                  >
                    {t('portal.pickup.action_cancel')}
                  </ConfirmButton>
                </li>
              ))}
            </ul>
            <FormNotice error={revoke.error} />
          </Card>
        )}

        <AuthoriseSomeone />

        <Card>
          <CardHeader
            title={t('portal.pickup.history_title')}
            description={t('portal.pickup.history_description')}
          />
          <Table
            head={[
              t('portal.pickup.col_person'),
              t('portal.pickup.col_child'),
              t('portal.pickup.col_day'),
              t('portal.pickup.col_why'),
              t('portal.pickup.col_what_happened'),
            ]}
            empty={rows.length === 0}
            emptyLabel={t('portal.pickup.empty')}
          >
            {rows.map((p) => (
              <tr key={p.id}>
                <Td>
                  <div className="font-medium">{p.full_name}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {p.relation} · {p.phone}
                    {p.id_last4 && ` · ${p.id_type ?? t('portal.pickup.id_fallback')} ••${p.id_last4}`}
                  </div>
                </Td>
                <Td>{p.student_name}</Td>
                <Td>{formatDate(p.valid_on)}</Td>
                <Td className="max-w-[16rem]">{p.reason}</Td>
                <Td>
                  <Badge tone={TONE[p.status]}>{p.status}</Badge>
                  {p.used_at && (
                    <div className="text-[12px] text-muted-foreground">
                      {t('portal.pickup.collected_on', { date: formatDate(p.used_at) })}
                      {p.released_by && t('portal.pickup.released_by', { name: p.released_by })}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

function AuthoriseSomeone() {
  const t = useT()
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [relation, setRelation] = useState('Driver')
  const [idType, setIdType] = useState('')
  const [idLast4, setIdLast4] = useState('')
  const [validOn, setValidOn] = useState('')
  const [reason, setReason] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api.post<{ code: string }>('/api/v1/portal/pickup', {
        student_id: studentId,
        full_name: name,
        phone,
        relation,
        id_type: idType || undefined,
        id_last4: idLast4 || undefined,
        valid_on: validOn || undefined,
        reason,
      }),
    onSuccess: () => {
      setName('')
      setPhone('')
      setIdLast4('')
      setReason('')
      qc.invalidateQueries({ queryKey: ['portal-pickup'] })
    },
  })

  const ready =
    studentId !== '' && name.trim() !== '' && phone.trim() !== '' && reason.trim() !== ''

  return (
    <Card>
      <CardHeader
        title={t('portal.pickup.form_title')}
        description={t('portal.pickup.form_description')}
      />
      <div className="p-4">
        <FormGrid>
          {children.length > 1 && (
            <Field label={t('portal.pickup.field_child')} required>
              <Select
                value={chosen}
                onChange={setChosen}
                placeholder={t('portal.pickup.child_placeholder')}
                options={childOptions(children)}
              />
            </Field>
          )}
          <Field label={t('portal.pickup.field_name')} required>
            <Input value={name} onChange={setName} placeholder={t('portal.pickup.name_placeholder')} />
          </Field>
          <Field label={t('portal.pickup.field_phone')} required>
            <Input value={phone} onChange={setPhone} placeholder="98480 12345" />
          </Field>
          <Field label={t('portal.pickup.field_relation')} required>
            <Select
              value={relation}
              onChange={setRelation}
              options={RELATIONS.map((r) => ({ value: r, label: r }))}
            />
          </Field>
          <Field label={t('portal.pickup.field_day')} hint={t('portal.pickup.field_day_hint')}>
            <Input type="date" value={validOn} onChange={setValidOn} />
          </Field>
          <Field label={t('portal.pickup.field_id')}>
            <Select
              value={idType}
              onChange={setIdType}
              placeholder={t('portal.pickup.id_placeholder')}
              options={[
                { value: 'Aadhaar', label: 'Aadhaar' },
                { value: 'Driving licence', label: 'Driving licence' },
                { value: 'Voter ID', label: 'Voter ID' },
              ]}
            />
          </Field>
          <Field label={t('portal.pickup.field_id_last4')}>
            <Input value={idLast4} onChange={setIdLast4} placeholder="4821" />
          </Field>
          <Field label={t('portal.pickup.field_reason')} wide required>
            <Textarea
              rows={2}
              value={reason}
              onChange={setReason}
              placeholder={t('portal.pickup.reason_placeholder')}
            />
          </Field>
        </FormGrid>
        <div className="mt-4">
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? t('portal.pickup.action_creating') : t('portal.pickup.action_create')}
          </Button>
        </div>
        <FormNotice
          error={create.error}
          ok={create.data ? t('portal.pickup.created_ok', { code: create.data.code }) : undefined}
        />
      </div>
    </Card>
  )
}
