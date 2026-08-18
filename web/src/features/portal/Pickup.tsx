import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
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

const RELATIONS = ['Driver', 'Grandparent', 'Uncle / Aunt', 'Neighbour', 'Family friend', 'Other']

export default function Pickup() {
  const qc = useQueryClient()
  const passes = useQuery({
    queryKey: ['portal-pickup'],
    queryFn: () => api.get<List<Pass>>('/api/v1/portal/pickup'),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/portal/pickup/${id}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-pickup'] }),
  })

  if (passes.isLoading) return <Loading label="Checking your passes…" />
  if (passes.error) return <ErrorState error={passes.error} />

  const rows = passes.data?.items ?? []
  const live = rows.filter((p) => p.status === 'live')

  return (
    <>
      <PageHead
        eyebrow="Consent"
        title="Someone else collecting"
        description="Name a person the school may release your child to, once, on one day."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Passes in force" value={live.length} icon={KeyRound} />
          <Stat label="Used" value={rows.filter((p) => p.status === 'used').length} />
          <Stat label="Cancelled" value={rows.filter((p) => p.status === 'revoked').length} icon={ShieldAlert} />
        </CellGrid>

        {live.length > 0 && (
          <Card>
            <CardHeader
              title="Give them this number"
              description="The gate will ask for it. Do not send it to anyone but the person collecting."
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
                      collecting {p.student_name} on {formatDate(p.valid_on)}
                    </div>
                  </div>
                  <ConfirmButton
                    confirmLabel="Cancel it"
                    question="The code stops working immediately."
                    tone="danger"
                    onConfirm={() => revoke.mutate(p.id)}
                  >
                    Cancel
                  </ConfirmButton>
                </li>
              ))}
            </ul>
            <FormNotice error={revoke.error} />
          </Card>
        )}

        <AuthoriseSomeone />

        <Card>
          <CardHeader title="Everything you have authorised" description="Kept so the school can answer who collected whom." />
          <Table
            head={['Person', 'Child', 'Day', 'Why', 'What happened']}
            empty={rows.length === 0}
            emptyLabel="You have not asked anyone else to collect your child."
          >
            {rows.map((p) => (
              <tr key={p.id}>
                <Td>
                  <div className="font-medium">{p.full_name}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {p.relation} · {p.phone}
                    {p.id_last4 && ` · ${p.id_type ?? 'ID'} ••${p.id_last4}`}
                  </div>
                </Td>
                <Td>{p.student_name}</Td>
                <Td>{formatDate(p.valid_on)}</Td>
                <Td className="max-w-[16rem]">{p.reason}</Td>
                <Td>
                  <Badge tone={TONE[p.status]}>{p.status}</Badge>
                  {p.used_at && (
                    <div className="text-[12px] text-muted-foreground">
                      collected {formatDate(p.used_at)}
                      {p.released_by && ` · released by ${p.released_by}`}
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
        title="Authorise somebody"
        description="Good for one collection on one day. Leaving the last four digits of their ID lets the gate check the person in front of them is the person you meant."
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
          <Field label="Their name" required>
            <Input value={name} onChange={setName} placeholder="Suresh Menon" />
          </Field>
          <Field label="Their number" required>
            <Input value={phone} onChange={setPhone} placeholder="98480 12345" />
          </Field>
          <Field label="Who they are to the child" required>
            <Select
              value={relation}
              onChange={setRelation}
              options={RELATIONS.map((r) => ({ value: r, label: r }))}
            />
          </Field>
          <Field label="Which day" hint="Leave blank for today. A month ahead at most.">
            <Input type="date" value={validOn} onChange={setValidOn} />
          </Field>
          <Field label="ID they will carry">
            <Select
              value={idType}
              onChange={setIdType}
              placeholder="None"
              options={[
                { value: 'Aadhaar', label: 'Aadhaar' },
                { value: 'Driving licence', label: 'Driving licence' },
                { value: 'Voter ID', label: 'Voter ID' },
              ]}
            />
          </Field>
          <Field label="Last four digits of it">
            <Input value={idLast4} onChange={setIdLast4} placeholder="4821" />
          </Field>
          <Field label="Why somebody else" wide required>
            <Textarea
              rows={2}
              value={reason}
              onChange={setReason}
              placeholder="I am travelling and will not be back before school closes"
            />
          </Field>
        </FormGrid>
        <div className="mt-4">
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create the pass'}
          </Button>
        </div>
        <FormNotice
          error={create.error}
          ok={create.data ? `Give them the code ${create.data.code}.` : undefined}
        />
      </div>
    </Card>
  )
}
