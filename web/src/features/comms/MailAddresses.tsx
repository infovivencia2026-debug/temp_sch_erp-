import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { StaffMailAddress } from '@shared/api/feature_mail_addresses'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Dialog, ErrorState, Field, FormNotice, Input, Loading, Table, Td,
} from '@/components/ui'

/* The school's mail domain and each member of staff's address
   (worker/src/routes/comms/mail_addresses.ts). Nothing on this screen reads
   mail: each mailbox opens only for its owner, on Communication > Inbox. */
export default function MailAddresses() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['mail-addresses'], queryFn: () => api.call('GET /comms/mail-addresses') })
  const [domain, setDomain] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<StaffMailAddress | null>(null)

  const saveDomain = useMutation({
    mutationFn: (d: string) => api.call('PUT /comms/mail-addresses/domain', { body: { domain: d } }),
    onSuccess: () => { setDomain(null); qc.invalidateQueries({ queryKey: ['mail-addresses'] }) },
  })
  const setStatus = useMutation({
    mutationFn: (v: { user_id: string; status: 'active' | 'disabled' }) =>
      api.call('PUT /comms/mail-addresses/{user_id}', { params: { user_id: v.user_id }, body: { status: v.status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mail-addresses'] }),
  })

  const head = <PageHead eyebrow="Communication" title="Mail addresses" />
  if (q.isError) return <>{head}<PageBody><ErrorState error={q.error} /></PageBody></>
  if (!q.data) return <>{head}<PageBody><Loading shape="table" /></PageBody></>
  const current = q.data.domain
  const shownDomain = domain ?? current ?? ''
  const f = filter.trim().toLowerCase()
  const rows = q.data.items.filter((s) => !f || s.full_name.toLowerCase().includes(f) || (s.address ?? '').includes(f) || (s.login_email ?? '').toLowerCase().includes(f))

  return (
    <>
      {head}
      <PageBody>
        <div className="space-y-4">
          <Card>
            <CardHeader title="School mail domain" />
            <div className="space-y-3 px-[var(--card-pad)] py-4">
              <p className="text-[13px] text-muted-foreground">
                Mail for any address on this domain comes to the staff member who holds it. The domain also needs Email Routing set up on Cloudflare and a verified sender for outgoing mail.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 sm:max-w-sm">
                  <Field label="Domain"><Input value={shownDomain} onChange={setDomain} autoComplete="off" /></Field>
                </div>
                <Button variant={current ? 'secondary' : 'primary'} pending={saveDomain.isPending}
                  disabled={!shownDomain.trim() || shownDomain.trim().toLowerCase() === current}
                  onClick={() => saveDomain.mutate(shownDomain.trim())}>
                  {current ? 'Change domain' : 'Set domain'}
                </Button>
              </div>
              {current && domain !== null && domain.trim().toLowerCase() !== current && (
                <p className="text-[13px] text-muted-foreground">Every address moves to the new domain, keeping the part before the @.</p>
              )}
              <FormNotice error={saveDomain.error} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Staff" action={<Input value={filter} onChange={setFilter} placeholder="Search name or address" srLabel="Search staff" type="search" />} />
            <FormNotice error={setStatus.error} />
            <Table head={['Name', 'Address', 'Status', '']} empty={rows.length === 0} emptyLabel={f ? 'No one matches.' : 'No staff found.'}>
              {rows.map((s) => (
                <tr key={s.user_id}>
                  <Td>
                    <span className="block font-medium">{s.full_name}</span>
                    {s.login_email && <span className="block truncate text-[12px] text-muted-foreground">{s.login_email}</span>}
                  </Td>
                  <Td className="break-all">{s.address ?? <span className="text-muted-foreground">None</span>}</Td>
                  <Td>
                    {s.status === 'active' && <Badge tone="success">Active</Badge>}
                    {s.status === 'disabled' && <Badge tone="warning">Switched off</Badge>}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" disabled={!current} onClick={() => setEditing(s)}>{s.address ? 'Change' : 'Give address'}</Button>
                      {s.status && (
                        <Button size="sm" variant="ghost" pending={setStatus.isPending && setStatus.variables?.user_id === s.user_id}
                          onClick={() => setStatus.mutate({ user_id: s.user_id, status: s.status === 'active' ? 'disabled' : 'active' })}>
                          {s.status === 'active' ? 'Switch off' : 'Switch on'}
                        </Button>
                      )}
                    </span>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      </PageBody>
      {editing && current && <AddressDialog person={editing} domain={current} onClose={() => setEditing(null)} />}
    </>
  )
}

function AddressDialog({ person, domain, onClose }: { person: StaffMailAddress; domain: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [local, setLocal] = useState(person.address ? person.address.split('@')[0] : '')
  const save = useMutation({
    mutationFn: () => api.call('PUT /comms/mail-addresses/{user_id}', { params: { user_id: person.user_id }, body: { local_part: local.trim() } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mail-addresses'] }); onClose() },
  })
  return (
    <Dialog
      onClose={onClose}
      title={person.address ? 'Change address' : 'Give an address'}
      description={person.full_name}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button pending={save.isPending} disabled={!local.trim()} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Address" hint={`${local.trim().toLowerCase() || 'name'}@${domain}`}>
          <Input value={local} onChange={setLocal} autoComplete="off" />
        </Field>
        {person.address && (
          <p className="text-[13px] text-muted-foreground">Mail already in this person's Inbox stays there. Mail sent to the old address after the change is refused.</p>
        )}
        <FormNotice error={save.error} />
      </div>
    </Dialog>
  )
}
