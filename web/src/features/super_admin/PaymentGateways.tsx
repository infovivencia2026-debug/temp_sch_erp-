import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, ConfirmButton,
  Input, Select, Checkbox, Field, FormGrid, FormNotice, Reload,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'

/* Merchant keys, per school and gateway.

   A record, not a checkout. Nothing in this product takes a card payment
   today, and the server says so on every response (live_checkout_available);
   the screen repeats it in one line rather than hiding a key behind a button
   that would fail. Secrets are written and never read back — the row shows
   whether one is set, which is all a screen needs to know. */

interface Row {
  id: string
  institution_id: string | null
  school: string
  provider: string
  provider_label: string
  mode: 'test' | 'live'
  key_id: string
  has_secret: boolean
  has_webhook_secret: boolean
  is_enabled: boolean
  notes: string
  updated_at?: string
}

interface Opt { value: string; label: string }

interface Resp {
  items: Row[]
  providers: Opt[]
  schools: Opt[]
  live_checkout_available: boolean
  note: string
  credential_key_present: boolean
}

const BASE = '/api/v1/admin/connectors/payment-gateways'
const QK = ['payment-gateways']

const blank = {
  institution_id: '', provider: 'razorpay', mode: 'test', key_id: '',
  secret: '', webhook_secret: '', is_enabled: false, notes: '',
}

export default function PaymentGateways() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<typeof blank | null>(null)
  const q = useQuery({ queryKey: QK, queryFn: () => api.get<Resp>(BASE) })

  const save = useMutation({
    mutationFn: (f: typeof blank) =>
      api.put<{ id: string; is_enabled: boolean; note?: string }>(BASE, {
        institution_id: f.institution_id,
        provider: f.provider,
        mode: f.mode,
        key_id: f.key_id,
        // Blank means "leave the stored secret alone", so it is not sent.
        secret: f.secret ? f.secret : undefined,
        webhook_secret: f.webhook_secret ? f.webhook_secret : undefined,
        is_enabled: f.is_enabled,
        notes: f.notes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK })
      setEditing(null)
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK }),
  })

  const d = q.data
  const rows = d?.items ?? []
  const canSeal = d?.credential_key_present ?? true

  return (
    <>
      <PageHead eyebrow="Payments & devices" title="Payment gateways" />
      <PageBody>
        <Card>
          <CardHeader
            title="Merchant keys"
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(editing ? null : { ...blank })}>
                  <Plus className="h-3.5 w-3.5" /> Add a key
                </Button>
                <Reload onClick={() => q.refetch()} busy={q.isFetching} />
              </div>
            }
          />
          {d && (
            <p className="border-b px-5 py-3 text-[13px] text-muted-foreground">{d.note}</p>
          )}
          {editing && d && (
            <div className="space-y-3 border-b px-5 py-4">
              <FormGrid>
                <Field label="School">
                  <Select
                    value={editing.institution_id}
                    onChange={(v) => setEditing({ ...editing, institution_id: v })}
                    options={[{ value: '', label: 'Every school' }, ...d.schools]}
                  />
                </Field>
                <Field label="Gateway" required>
                  <Select
                    value={editing.provider}
                    onChange={(v) => setEditing({ ...editing, provider: v })}
                    options={d.providers}
                  />
                </Field>
                <Field label="Mode">
                  <Select
                    value={editing.mode}
                    onChange={(v) => setEditing({ ...editing, mode: v })}
                    options={[{ value: 'test', label: 'Test' }, { value: 'live', label: 'Live' }]}
                  />
                </Field>
                <Field label="Key id" hint="Merchant id, access code or key id. Not secret.">
                  <Input value={editing.key_id} onChange={(v) => setEditing({ ...editing, key_id: v })} />
                </Field>
                <Field
                  label="Key secret"
                  hint={canSeal ? 'Stored sealed. Leave blank to keep what is there.' : 'CREDENTIAL_KEY is not set on the server, so a secret cannot be stored.'}
                >
                  <Input type="password" value={editing.secret} onChange={(v) => setEditing({ ...editing, secret: v })} />
                </Field>
                <Field label="Webhook secret" hint="Leave blank to keep what is there.">
                  <Input type="password" value={editing.webhook_secret} onChange={(v) => setEditing({ ...editing, webhook_secret: v })} />
                </Field>
                <Field label="Notes" wide>
                  <Input value={editing.notes} onChange={(v) => setEditing({ ...editing, notes: v })} />
                </Field>
              </FormGrid>
              <Checkbox
                checked={editing.is_enabled}
                onChange={(v) => setEditing({ ...editing, is_enabled: v })}
                label="Switched on"
                hint="Stays off until a secret is stored."
              />
              <FormNotice error={save.error} ok={save.data?.note} />
              <div className="flex gap-2">
                <Button disabled={save.isPending} onClick={() => save.mutate(editing)}>Save</Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </div>
          )}

          {q.isLoading ? (
            <SkeletonTable columns={6} />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : rows.length === 0 ? (
            <EmptyState title="No keys recorded" body="Add a key for a school, or one for every school." />
          ) : (
            <Table head={['School', 'Gateway', 'Mode', 'Key id', 'Secrets', 'On', '']}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.school}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      {r.provider_label}
                    </span>
                  </Td>
                  <Td>{r.mode === 'live' ? <Badge tone="warning">Live</Badge> : <Badge>Test</Badge>}</Td>
                  <Td className="font-mono text-xs">{r.key_id || '—'}</Td>
                  <Td>
                    {r.has_secret ? 'Key' : <span className="text-muted-foreground">No key</span>}
                    {r.has_webhook_secret ? ' · webhook' : ''}
                  </Td>
                  <Td>{r.is_enabled ? <Badge tone="success">On</Badge> : <span className="text-muted-foreground">Off</span>}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setEditing({
                            institution_id: r.institution_id ?? '',
                            provider: r.provider, mode: r.mode, key_id: r.key_id,
                            secret: '', webhook_secret: '', is_enabled: r.is_enabled, notes: r.notes,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <ConfirmButton
                        confirmLabel="Remove"
                        question="The key and its secrets are deleted."
                        tone="danger"
                        variant="ghost"
                        disabled={remove.isPending}
                        onConfirm={() => remove.mutate(r.id)}
                      >
                        Remove
                      </ConfirmButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
