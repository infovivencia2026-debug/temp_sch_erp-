import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { buzz } from '@/lib/haptics'
import { useToast } from '@/components/Toast'
import { readMailImportCsv, type MailImportPreview, type MailImportResult, type MailImportRow, type MailServerSettings, type StaffMailAddress } from '@shared/api/feature_mail_addresses'
import { parseCsv } from '@/components/BulkImport'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Dialog, ErrorState, Field, FormNotice, Input, Loading, Table, Td, SEG_BAR, segClass,
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
  const [importing, setImporting] = useState(false)

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

          <MailServerCard />

          <Card>
            <CardHeader title="Staff" action={
              <div className="flex items-center gap-2">
                <Input value={filter} onChange={setFilter} placeholder="Search name or address" srLabel="Search staff" type="search" />
                <Button variant="secondary" onClick={() => setImporting(true)}>Import from file</Button>
              </div>
            } />
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
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  )
}

/* The school's own mail server. Each member of staff connects their own
   mailbox to it from their Inbox, with their own password; no password is
   kept here. */
function MailServerCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['mail-addresses', 'server'], queryFn: () => api.call('GET /comms/mail-addresses/server') })
  const [edit, setEdit] = useState<MailServerSettings | null>(null)
  const save = useMutation({
    mutationFn: (v: MailServerSettings) => api.call('PUT /comms/mail-addresses/server', { body: v }),
    onSuccess: (v) => { qc.setQueryData(['mail-addresses', 'server'], v); setEdit(null); buzz('tap'); toast.ok('Saved') },
  })
  const v = edit ?? q.data
  const set = <K extends keyof MailServerSettings>(k: K) => (x: MailServerSettings[K]) => setEdit({ ...v!, [k]: x })
  const port = (k: 'imap_port' | 'smtp_port') => (x: string) => set(k)(Number(x.replace(/\D/g, '')) || 0)
  return (
    <Card>
      <CardHeader title="School mail server" />
      <div className="space-y-3 px-[var(--card-pad)] py-4">
        <p className="text-[13px] text-muted-foreground">
          With these set, each member of staff can connect their own mailbox on Communication &gt; Inbox with their own password. Their mail is then sent through this server as them, and they can copy their old mail in.
        </p>
        {q.isError ? <ErrorState error={q.error} /> : !v ? <Loading shape="inline" /> : (
          <>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field label="IMAP server" hint="For copying old mail. Secure connection (SSL/TLS)."><Input value={v.imap_host} onChange={set('imap_host')} placeholder="mail.example.org" autoComplete="off" /></Field>
              <Field label="IMAP port"><Input value={String(v.imap_port || '')} onChange={port('imap_port')} type="number" min={1} max={65535} autoComplete="off" /></Field>
              <Field label="SMTP server" hint="For sending."><Input value={v.smtp_host} onChange={set('smtp_host')} placeholder="mail.example.org" autoComplete="off" /></Field>
              <Field label="SMTP port"><Input value={String(v.smtp_port || '')} onChange={port('smtp_port')} type="number" min={1} max={65535} autoComplete="off" /></Field>
            </div>
            <div className={SEG_BAR} role="radiogroup" aria-label="SMTP security">
              <button type="button" role="radio" aria-checked={v.smtp_security === 'tls'} className={segClass(v.smtp_security === 'tls')}
                onClick={() => setEdit({ ...v, smtp_security: 'tls', smtp_port: v.smtp_port === 587 ? 465 : v.smtp_port })}>SSL/TLS (465)</button>
              <button type="button" role="radio" aria-checked={v.smtp_security === 'starttls'} className={segClass(v.smtp_security === 'starttls')}
                onClick={() => setEdit({ ...v, smtp_security: 'starttls', smtp_port: v.smtp_port === 465 ? 587 : v.smtp_port })}>STARTTLS (587)</button>
            </div>
            <div>
              <Button variant="secondary" pending={save.isPending} disabled={!edit} onClick={() => edit && save.mutate(edit)}>Save server</Button>
            </div>
            <FormNotice error={save.error} />
          </>
        )}
      </div>
    </Card>
  )
}

function AddressDialog({ person, domain, onClose }: { person: StaffMailAddress; domain: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [local, setLocal] = useState(person.address ? person.address.split('@')[0] : '')
  const toast = useToast()
  const save = useMutation({
    mutationFn: () => api.call('PUT /comms/mail-addresses/{user_id}', { params: { user_id: person.user_id }, body: { local_part: local.trim() } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mail-addresses'] }); buzz('tap'); toast.ok('Saved'); onClose() },
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

const RESULT: Record<MailImportResult, { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  assign: { label: 'Will assign', tone: 'success' },
  already: { label: 'Already set', tone: 'neutral' },
  unmatched: { label: 'No staff match', tone: 'warning' },
  invalid: { label: 'Not an email', tone: 'danger' },
  duplicate: { label: 'Duplicate address', tone: 'danger' },
  domain: { label: 'Other domain', tone: 'warning' },
}

/* Import from a staff list CSV. Only the code, name and email columns are
   read here; a password column in the file is never read or sent. The server
   dry-runs the match first, and Apply writes only the lines marked Will assign. */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<MailImportRow[] | null>(null)
  const [readError, setReadError] = useState('')
  const [plan, setPlan] = useState<MailImportPreview | null>(null)
  const [assigned, setAssigned] = useState<number | null>(null)
  const toast = useToast()

  const preview = useMutation({
    mutationFn: (r: MailImportRow[]) => api.call('POST /comms/mail-addresses/import/preview', { body: { rows: r } }),
    onSuccess: setPlan,
  })
  const setDomain = useMutation({
    mutationFn: (d: string) => api.call('PUT /comms/mail-addresses/domain', { body: { domain: d } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mail-addresses'] }); if (rows) preview.mutate(rows) },
  })
  const apply = useMutation({
    mutationFn: () => api.call('POST /comms/mail-addresses/import', { body: { rows: rows! } }),
    onSuccess: (res) => {
      setPlan(res); setAssigned(res.assigned); qc.invalidateQueries({ queryKey: ['mail-addresses'] })
      buzz('tap'); toast.ok(`Saved. ${res.assigned} ${res.assigned === 1 ? 'address' : 'addresses'} assigned`)
    },
  })

  async function onFile(file: File | undefined) {
    if (!file) return
    setPlan(null); setAssigned(null); setReadError('')
    if (!/\.(csv|txt)$/i.test(file.name)) { setReadError('Save the sheet as CSV first, then choose that file.'); return }
    const read = readMailImportCsv(parseCsv(await file.text()))
    if ('error' in read) { setReadError(read.error); return }
    if (read.rows.length === 0) { setReadError('The file has a header line but no staff under it.'); return }
    setRows(read.rows)
    preview.mutate(read.rows)
  }

  const ready = plan?.rows.filter((r) => r.result === 'assign').length ?? 0
  return (
    <Dialog
      onClose={onClose}
      title="Import from file"
      description="A CSV with an employee code or Staff Name column and an Email ID column. Other columns are not read."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{assigned === null ? 'Cancel' : 'Close'}</Button>
          {assigned === null && (
            <Button pending={apply.isPending} disabled={!plan || ready === 0 || preview.isPending} onClick={() => apply.mutate()}>
              {ready ? `Assign ${ready} address${ready === 1 ? '' : 'es'}` : 'Assign addresses'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" pending={preview.isPending} onClick={() => fileRef.current?.click()}>{rows ? 'Choose another file' : 'Choose CSV file'}</Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden"
            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
        </div>
        {readError && <FormNotice error={new Error(readError)} />}
        <FormNotice error={preview.error ?? setDomain.error ?? apply.error} ok={assigned !== null ? `${assigned} address${assigned === 1 ? '' : 'es'} assigned.` : undefined} />
        {plan && !plan.domain && (
          plan.suggested_domain ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] text-muted-foreground">No school mail domain is set. Every address in the file is on {plan.suggested_domain}.</p>
              <Button size="sm" variant="secondary" pending={setDomain.isPending} onClick={() => setDomain.mutate(plan.suggested_domain!)}>Set domain to {plan.suggested_domain}</Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">No school mail domain is set. Set it on this screen first, then choose the file again.</p>
          )
        )}
        {plan && (
          <Table head={['Line', 'In the file', 'Staff member', 'Address', 'Result']} empty={plan.rows.length === 0} emptyLabel="No lines read.">
            {plan.rows.map((r) => (
              <tr key={r.line}>
                <Td className="tabular-nums text-muted-foreground">{r.line}</Td>
                <Td>
                  <span className="block">{r.name || <span className="text-muted-foreground">No name</span>}</span>
                  {r.code && <span className="block text-[12px] text-muted-foreground">{r.code}</span>}
                </Td>
                <Td>
                  {r.full_name ?? <span className="text-muted-foreground">None</span>}
                  {r.matched_by && <span className="block text-[12px] text-muted-foreground">{r.matched_by === 'code' ? 'By code' : 'By name'}</span>}
                </Td>
                <Td className="break-all">
                  {r.email}
                  {r.current && r.current !== r.email && <span className="block text-[12px] text-muted-foreground">Now {r.current}</span>}
                </Td>
                <Td><Badge tone={RESULT[r.result].tone}>{RESULT[r.result].label}</Badge></Td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Dialog>
  )
}
