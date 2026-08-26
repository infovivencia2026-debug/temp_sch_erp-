/* Telling families where their application stands.
 *
 * Four messages, because these are the four moments an admissions office
 * actually writes about, and a desk that can write anything writes nothing
 * consistently. Pick the applicants, pick the message, send.
 *
 * The awkward one is the document reminder: this module asks for a reason when
 * a document is rejected, on the grounds that the whole value of a rejection is
 * telling the parent what to bring back — and that reason reached nobody until
 * this screen existed.
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Checkbox, Input, Select, Loading, ErrorState, EmptyState, FormNotice,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

interface Applicant {
  id: string
  application_no: string
  name: string
  class_sought?: string
  parent_name: string
  parent_phone: string
  status: string
  created_at: string
  docs_required: number
  docs_verified: number
  docs_rejected: number
}

/* What each message is for, and who it is normally for.

   `suggests` pre-selects the applicants that message is usually about — the
   offered ones for an offer, the ones short of paperwork for a reminder — so
   the common case is two clicks and the uncommon one is still possible. */
const NOTES: {
  kind: string
  label: string
  says: string
  needsDetail?: string
  suggests: (a: Applicant) => boolean
}[] = [
  {
    kind: 'offer',
    label: 'A place has been offered',
    says: 'Tells the family a place is offered and asks them to confirm by paying the admission fee.',
    suggests: (a) => a.status === 'offered',
  },
  {
    kind: 'documents',
    label: 'Documents still needed',
    says: 'Lists what the office is still waiting for.',
    needsDetail: 'Which documents — birth certificate, transfer certificate…',
    suggests: (a) => a.docs_rejected > 0 || a.docs_verified < a.docs_required,
  },
  {
    kind: 'test',
    label: 'Entrance test',
    says: 'Tells the family when and where the child sits the test.',
    needsDetail: 'When and where — Saturday 14 September, 9am, main hall.',
    suggests: (a) => a.status === 'test_scheduled',
  },
  {
    kind: 'regret',
    label: 'No place this session',
    says: 'Says a place cannot be offered. Sent once a decision is final.',
    suggests: (a) => a.status === 'rejected',
  },
]

export default function ApplicantMessages() {
  const can = useCan()
  const mayWrite = can('admissions.write')

  const [kind, setKind] = useState('offer')
  const [detail, setDetail] = useState('')
  const [channel, setChannel] = useState('sms')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [sent, setSent] = useState('')

  const q = useQuery({
    queryKey: ['applications', ''],
    queryFn: () => api.get<List<Applicant>>('/api/v1/admissions/applications'),
  })

  const items = q.data?.items ?? []
  const { q: term, setQ: setTerm, shown } = useSearch(items,
    (a) => [a.application_no, a.name, a.parent_name, a.parent_phone, a.class_sought, a.status])

  const note = NOTES.find((n) => n.kind === kind)!

  const send = useMutation({
    mutationFn: () => api.post<{ sent: number; skipped?: string[] }>(
      '/api/v1/admissions/workflow/applicant-messages',
      {
        application_ids: [...picked],
        kind,
        detail: detail.trim() || undefined,
        channel,
      },
    ),
    onSuccess: (r) => {
      const bits = [`${r.sent} sent`]
      if (r.skipped?.length) bits.push(`${r.skipped.length} not sent`)
      setSent(bits.join(', ') + (r.skipped?.length ? `: ${r.skipped.join('; ')}` : ''))
      setPicked(new Set())
      setDetail('')
    },
  })

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />

  const suggested = shown.filter(note.suggests)
  const noPhone = [...picked].filter(
    (id) => !items.find((a) => a.id === id)?.parent_phone,
  ).length

  return (
    <>
      <PageHead
        eyebrow="Admissions"
        title="Applicant communication"
        description="Tell a family their offer is out, what paperwork is missing, or when the test is."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Applications" value={items.length} />
          <Stat label="Offered" value={items.filter((a) => a.status === 'offered').length}
            hint="Waiting on the parent" />
          <Stat
            label="Short of paperwork"
            value={items.filter((a) => a.docs_verified < a.docs_required).length}
          />
          <Stat label="Chosen" value={picked.size}
            hint={picked.size ? 'Ready to send' : 'Tick the families to write to'} />
        </CellGrid>

        <Card>
          <CardHeader title="What to say" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Message</span>
              <Select
                value={kind}
                onChange={(v) => { setKind(v); setDetail(''); setSent('') }}
                options={NOTES.map((n) => ({ value: n.kind, label: n.label }))}
              />
              <span className="text-[12.5px] text-muted-foreground">{note.says}</span>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">How to send it</span>
              <Select
                value={channel}
                onChange={setChannel}
                options={[
                  { value: 'sms', label: 'SMS' },
                  { value: 'whatsapp', label: 'WhatsApp' },
                  { value: 'email', label: 'Email' },
                ]}
              />
            </label>
            {note.needsDetail && (
              <label className="flex flex-col gap-1.5 text-[13px] sm:col-span-2">
                <span className="text-muted-foreground">Detail</span>
                <Input value={detail} onChange={setDetail} placeholder={note.needsDetail} />
                {/* Refused server-side without it, because a reminder that does
                    not say what is missing only tells the family to come to the
                    office and ask — which is the errand it was meant to save. */}
                <span className="text-[12.5px] text-muted-foreground">
                  Goes into the message. Without it the family is only told to come and ask.
                </span>
              </label>
            )}
          </div>

          <FormNotice error={send.error} ok={sent} />

          <div className="flex flex-wrap items-center gap-3 border-t px-5 py-4">
            <Button
              disabled={!mayWrite || !picked.size || send.isPending ||
                (!!note.needsDetail && !detail.trim())}
              onClick={() => send.mutate()}
            >
              <Send className="h-3.5 w-3.5" />
              {send.isPending ? 'Sending…' : `Send to ${picked.size || 'no one'}`}
            </Button>
            {suggested.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => setPicked(new Set(suggested.map((a) => a.id)))}
              >
                Choose the {suggested.length} this usually goes to
              </Button>
            )}
            {picked.size > 0 && (
              <Button variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
            )}
            {noPhone > 0 && (
              <span className="text-[13px] text-muted-foreground">
                {noPhone} of those chosen have no {channel === 'email' ? 'email' : 'phone'} on
                file and will be listed as not sent.
              </span>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Who to write to"
            action={
              <span className="flex flex-wrap items-center gap-2">
                <Showing shown={shown.length} total={items.length} noun="applicants" />
                <SearchBox value={term} onChange={setTerm} placeholder="Name, parent or phone" />
                <ExportRows
                  rows={shown}
                  name="applicants"
                  columns={[
                    { header: 'Application no', value: (a) => a.application_no },
                    { header: 'Applicant', value: (a) => a.name },
                    { header: 'Class', value: (a) => a.class_sought },
                    { header: 'Parent', value: (a) => a.parent_name },
                    { header: 'Phone', value: (a) => a.parent_phone },
                    { header: 'Status', value: (a) => a.status },
                  ]}
                />
              </span>
            }
          />
          {shown.length === 0 ? (
            <EmptyState
              title={term ? 'No applicant matches that' : 'No applications yet'}
              body={term
                ? 'Try the application number, or the parent&rsquo;s phone.'
                : 'Applications appear here as they are filed.'}
            />
          ) : (
            <Table
              wide
              head={['', 'Application', 'Applicant', 'Class', 'Parent', 'Status', 'Applied']}
            >
              {shown.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Checkbox
                      checked={picked.has(a.id)}
                      onChange={(v) => setPicked((s) => {
                        const next = new Set(s)
                        if (v) next.add(a.id)
                        else next.delete(a.id)
                        return next
                      })}
                      label=""
                      srLabel={`Write to ${a.parent_name} about ${a.name}`}
                    />
                  </Td>
                  <Td className="font-mono text-[12px]">{a.application_no}</Td>
                  <Td className="font-medium">{a.name}</Td>
                  <Td className="text-muted-foreground">{a.class_sought ?? '—'}</Td>
                  <Td>
                    {a.parent_name}
                    <div className="text-[12px] text-muted-foreground">
                      {a.parent_phone || 'no phone on file'}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={a.status === 'offered' ? 'success'
                      : a.status === 'rejected' ? 'danger' : 'neutral'}>
                      {a.status.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(a.created_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
