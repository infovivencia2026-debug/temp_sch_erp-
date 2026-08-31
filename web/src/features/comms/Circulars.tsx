import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Paperclip, Send } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { cn, formatDate } from '@/lib/utils'
import { useSMSGateway } from '../communication/sms-gateway-lib'
import { PendingApprovals } from '../communication/SmsGateway'

interface Circular {
  id: string; title: string; kind: string; audience_role: string
  requires_ack: boolean; published_at: string; acknowledgements: number; sections: number
  /* What the notice actually says, and who signed it.

     A parent could see that the school had said something and not what, or
     who. The time matters as much as the date on a notice about this
     afternoon's early closing. */
  published_at_full?: string
  published_by?: string
  body?: string
  acknowledged_by_me?: boolean
}

/** Circulars with targeting and read receipts. SMS goes out one queued task
    per recipient so a single DLT rejection cannot lose the batch. */
export default function Circulars() {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sectionIds, setSectionIds] = useState<Set<string>>(new Set())
  /* Who it is addressed to. audience_role has been a column on announcements
     since the beginning and this form never set it, so every circular went out
     as 'all' and the fan-out ran over guardians regardless — a notice for
     students was delivered to their parents. */
  const [audience, setAudience] = useState('all')
  const [sendEmail, setSendEmail] = useState(false)
  const [requiresAck, setRequiresAck] = useState(true)
  const [sendSMS, setSendSMS] = useState(false)
  const [sendWhatsApp, setSendWhatsApp] = useState(false)
  /* The attachment, uploaded before the circular is published.
   *
   * Half of what a school circulates is a document — the holiday list, the fee
   * notice, the exam timetable. Uploading on choose rather than on publish so
   * the wait happens while the body is still being typed, and so a failed
   * upload is discovered before the notice goes out rather than instead of it. */
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [fileError, setFileError] = useState('')

  // A student and a parent read circulars but cannot send one. The section
  // list behind the composer is staff-only, so asking for it as a family
  // meant a 403 on every visit and a filter that never populated — a screen
  // that works but logs an error each time it opens.
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  const canPublish = session.data?.permissions.includes('comms.announcements.write') ?? false
  /* A handset that enrolled by sign-in waits here for a person to say yes.

     The gateway's own screen is bound to a platform-scoped catalogue key, so
     it appears in the super-admin workspace and nowhere a principal can reach
     — the approval existed on the server and had no door in the product. This
     is that door, on the screen where SMS to parents is written, and it is
     gated on the same permission the approve endpoint requires so a role that
     would only be refused never sees it. */
  const canApproveGateway =
    session.data?.permissions.includes('institution.integrations.write') ?? false
  const gateway = useSMSGateway(canApproveGateway)
  const pendingPhones = canApproveGateway
    ? (gateway.data?.devices ?? []).filter((d) => d.pending)
    : []

  /* Signing a notice that asked to be signed.

     Not a statistic like the acknowledgement counts on the office's register —
     this is the one thing the school actually needs this parent to do, so it
     sits on the notice itself rather than in a column. */
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/communication/circulars/${id}/ack`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['circulars'] }),
  })

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
    enabled: canPublish,
  })
  const list = useQuery({
    queryKey: ['circulars'],
    queryFn: () => api.get<List<Circular>>('/api/v1/communication/circulars'),
  })
  const publish = useMutation({
    mutationFn: () =>
      api.post<{ recipients: number; unreachable_children: number; sms_queued: number; email_queued: number }>(
        '/api/v1/communication/circulars',
        {
          title, body, section_ids: [...sectionIds],
          audience_role: audience,
          requires_ack: requiresAck, send_sms: sendSMS, send_email: sendEmail, send_whatsapp: sendWhatsApp,
          attachment_file_id: file?.id ?? '',
        },
      ),
    onSuccess: () => {
      setTitle(''); setBody(''); setSectionIds(new Set()); setFile(null)
      qc.invalidateQueries({ queryKey: ['circulars'] })
    },
  })

  const [openId, setOpenId] = useState<string | null>(null)
  const rows = list.data?.items ?? []
  const toggle = (id: string) => {
    const n = new Set(sectionIds)
    n.has(id) ? n.delete(id) : n.add(id)
    setSectionIds(n)
  }

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Circulars"
        description={
          canPublish
            ? 'Publish to the portal, and push it as SMS or email as well. Address it to parents, to students or to both, and to the whole school or named sections.'
            : 'Notices the school has published, newest first.'
        }
      />
      <PageBody>
        {pendingPhones.length > 0 && <PendingApprovals devices={pendingPhones} />}
        {!canPublish ? (
          /* A parent reads a notice; they do not administer one. Audience,
             Sections, Acknowledged and "Who got it" all answer questions the
             SCHOOL has about a notice — shown to somebody who cannot act on
             any of them, and standing in front of the one thing they came
             for, which is what it says. */
          <FamilyNotices rows={rows} onAck={(id) => ack.mutate(id)} acking={ack.isPending} />
        ) : (
        <>
        <CellGrid cols={3}>
          <Stat label="Circulars" value={rows.length} />
          <Stat label="Awaiting acknowledgement"
            value={rows.filter((r) => r.requires_ack && r.acknowledgements === 0).length} />
          <Stat label="Total acknowledgements" value={rows.reduce((a, r) => a + r.acknowledgements, 0)} />
        </CellGrid>

        {canPublish && (
        <Card>
          <CardHeader title="New circular" />
          <form className="space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); publish.mutate() }}>
            <Input value={title} onChange={setTitle} placeholder="Title" className="w-full" />
            <Textarea value={body} onChange={setBody} placeholder="Body" rows={4} className="w-full" />
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
                <Paperclip className="h-3.5 w-3.5" />
                {uploading ? 'Uploading…' : file ? 'Replace the file' : 'Attach a file'}
                <input
                  type="file"
                  className="hidden"
                  disabled={uploading}
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    // Cleared so the same file can be chosen twice running.
                    e.target.value = ''
                    if (!f) return
                    setUploading(true); setFileError('')
                    try {
                      const fd = new FormData()
                      fd.append('file', f)
                      fd.append('purpose', 'circular')
                      const res = await fetch('/api/v1/files', {
                        method: 'POST', body: fd, credentials: 'same-origin',
                      })
                      if (!res.ok) throw new Error((await res.text()) || 'Upload failed')
                      const made = await res.json()
                      setFile({ id: made.file_id, name: made.name })
                    } catch (err) {
                      setFileError(err instanceof Error ? err.message : 'Could not upload that file.')
                    } finally {
                      setUploading(false)
                    }
                  }}
                />
              </label>
              {file && (
                <span className="text-[13px]">
                  {file.name}
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="ml-2 underline underline-offset-2 text-muted-foreground hover:text-destructive"
                  >
                    remove
                  </button>
                </span>
              )}
              {fileError && <span className="text-[13px] text-destructive">{fileError}</span>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-muted-foreground">Send to</span>
              <Select
                value={audience}
                onChange={setAudience}
                options={[
                  { value: 'all', label: 'Parents and students' },
                  { value: 'parents', label: 'Parents only' },
                  { value: 'students', label: 'Students only' },
                  { value: 'staff', label: 'Staff only' },
                  { value: 'everyone', label: 'Everyone — parents and staff' },
                ]}
              />
            </div>
            <div>
              {/* A member of staff does not belong to a section the way a
                  child does: a subject teacher stands in five of them and the
                  office in none. Applying the filter to staff would quietly
                  drop the people the notice is for, so it narrows families
                  only — said here rather than discovered afterwards. */}
              <p className="mb-1.5 text-[13px] text-muted-foreground">
                Sections — leave empty to reach the whole school
                {(audience === 'staff' || audience === 'everyone') &&
                  ' · staff are included whichever sections you pick'}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(sections.data?.items ?? []).map((s) => (
                  <button
                    key={s.id} type="button" onClick={() => toggle(s.id)}
                    className={`rounded-md border px-2 py-1 text-[13px] transition-colors ${
                      sectionIds.has(s.id) ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                    }`}
                  >
                    {s.class_name}-{s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-[14px]">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} />
                Require acknowledgement
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={sendSMS} onChange={(e) => setSendSMS(e.target.checked)} />
                Also send SMS
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
                Also send email
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={sendWhatsApp} onChange={(e) => setSendWhatsApp(e.target.checked)} />
                Also send WhatsApp
              </label>
            </div>
            {publish.isError && (
              <p className="text-[13px] text-destructive">
                {publish.error instanceof Error ? publish.error.message : 'Publish failed'}
              </p>
            )}
            {publish.isSuccess && (
              // "Queued", not "sent": neither an SMS gateway nor an SMTP
              // provider is configured here, so the worker holds these until
              // one is. Claiming a delivery nothing performed is the single
              // thing a communication tool must not do.
              <p className="text-[13px] text-success">
                Published to {publish.data.recipients}{' '}
                {audience === 'students' ? 'students' : audience === 'parents' ? 'guardians' : 'recipients'}
                {publish.data.sms_queued > 0 && `, ${publish.data.sms_queued} SMS queued`}
                {publish.data.email_queued > 0 && `, ${publish.data.email_queued} emails queued`}.
              </p>
            )}
            {publish.isSuccess && publish.data.unreachable_children > 0 && (
              /* The other half of the number, and the reason it looks small.
                 A school of sixty children publishing to "all parents" and
                 being told "12 recipients" reads it as a targeting fault. It
                 is not: the other families have never been issued a login, so
                 there is nowhere to deliver a portal notice to. That is worth
                 saying plainly, with where to fix it. */
              <p className="text-[13px] text-warning">
                {publish.data.unreachable_children} children could not be reached — their parent
                has no login yet. Issue logins on School setup → Students to reach them.
              </p>
            )}
            <Button type="submit" disabled={!title.trim() || !body.trim() || publish.isPending}>
              <Send className="h-4 w-4" />
              {publish.isPending ? 'Publishing…' : 'Publish circular'}
            </Button>
          </form>
        </Card>
        )}

        <Card>
          <CardHeader title="Published" description="Most recent first" />
          {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
            /* Seven columns: without `wide` they were divided equally and
               crushed, and scrolling sideways carried the title out of view —
               leaving a column of identical "Who got it" buttons with nothing
               to say which circular each belonged to. */
            <Table wide
              head={['Title', 'Kind', 'Audience', 'Sections', 'Acknowledged', 'Published', '']}
              empty={!rows.length} emptyLabel="Nothing published yet.">
              {rows.map((c) => (
                <tr key={c.id}>
                  <Td className="whitespace-nowrap font-medium">{c.title}</Td>
                  <Td><Badge>{c.kind}</Badge></Td>
                  <Td>{c.audience_role}</Td>
                  <Td>{c.sections || 'all'}</Td>
                  <Td>
                    {c.requires_ack
                      ? <Badge tone={c.acknowledgements ? 'success' : 'warning'}>{c.acknowledgements}</Badge>
                      /* An em dash and a zero were being used for the same
                         state on the same column, which reads as two states.
                         This one means the circular never asked. */
                      : <span className="text-muted-foreground">not asked</span>}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(c.published_at)}</Td>
                  <Td>
                    <Button size="sm" variant="ghost" onClick={() => setOpenId(openId === c.id ? null : c.id)}>
                      {openId === c.id ? 'Hide' : 'Who got it'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {openId && <Delivery id={openId} />}
        </>
        )}
      </PageBody>
    </>
  )
}

/* Who got it, and who said they read it.
 *
 * A principal could publish a notice and then had no way to find out what
 * happened to it: the published rows were not clickable, there was no recipient
 * list, no delivery state and no read receipt. The one question a person asks
 * after sending something to six hundred families had no answer anywhere in the
 * product, so the honest conclusion was that delivery was broken. It was not
 * broken; it was invisible, which for the person relying on it is the same
 * thing.
 *
 * Unreachable is the number that explains a small delivery count. A school of
 * sixty children told "12 reached" assumes the targeting is wrong. Told that
 * forty-nine families have never been issued a login, they know what to do.
 */
function Delivery({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['circular-delivery', id],
    queryFn: () =>
      api.get<{
        title: string
        delivered: number
        acknowledged: number
        unreachable_children: number
        people: { name: string; role: string; student?: string; acked_at?: string }[]
      }>(`/api/v1/communication/circulars/${id}/delivery`),
  })

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data!

  return (
    <Card>
      <CardHeader
        title={d.title}
        description="Everyone this circular was delivered to, and whether they have acknowledged it."
      />
      <CellGrid cols={3}>
        <Stat label="Delivered to" value={d.delivered} hint="On their portal and in their bell" />
        <Stat label="Acknowledged" value={d.acknowledged} />
        <Stat
          label="Could not be reached"
          value={d.unreachable_children}
          hint={d.unreachable_children ? 'Children whose parent has no login' : 'Everyone has a login'}
        />
      </CellGrid>
      <Table
        head={['Name', 'Who they are', 'About', 'Acknowledged']}
        empty={d.people.length === 0}
        emptyLabel="Nobody could be reached — no parent or staff account matches this audience."
      >
        {d.people.map((p, i) => (
          <tr key={`${p.name}-${i}`}>
            <Td className="font-medium">{p.name}</Td>
            <Td>{p.role}</Td>
            <Td className="text-muted-foreground">{p.student ?? '—'}</Td>
            <Td>
              {p.acked_at
                ? <Badge tone="success">{p.acked_at}</Badge>
                : <span className="text-muted-foreground">not yet</span>}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

/* What a parent came to read.

   The office's register answers the school's questions about a notice — who it
   was addressed to, how many acknowledged, who got it. A parent has one
   question, which is what it says, and one obligation, which is to sign the
   ones that ask. Everything else on that table is somebody else's work shown
   to somebody who cannot act on it.
*/
function FamilyNotices({ rows, onAck, acking }: {
  rows: Circular[]
  onAck: (id: string) => void
  acking: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const waiting = rows.filter((r) => r.requires_ack && !r.acknowledged_by_me).length

  return (
    <Card>
      <CardHeader
        title="Notices"
        description={
          waiting
            ? `${waiting} waiting for you to acknowledge`
            : 'Everything the school has published, newest first.'
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="Nothing yet" body="Notices from the school will appear here." />
      ) : (
        <ul className="divide-y">
          {rows.map((c) => {
            const open = openId === c.id
            const needsMe = c.requires_ack && !c.acknowledged_by_me
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : c.id)}
                  aria-expanded={open}
                  className="flex w-full items-start gap-3 px-5 py-3.5 text-left hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14.5px] font-medium">{c.title}</span>
                      {needsMe && <Badge tone="warning">needs your acknowledgement</Badge>}
                      {c.requires_ack && c.acknowledged_by_me && (
                        <Badge tone="success">acknowledged</Badge>
                      )}
                    </div>
                    {/* Date and time, because "24 Aug" on a notice about this
                        afternoon is the half that does not help. */}
                    <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                      {(c.published_at_full ?? c.published_at).replace('T', ' ')}
                      {c.published_by && ` \u00b7 ${c.published_by}`}
                    </div>
                  </div>
                  <ChevronDown
                    className={cn(
                      'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                      open && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>

                {open && (
                  <div className="px-5 pb-4">
                    <p className="max-w-[70ch] whitespace-pre-wrap text-[14px]">
                      {c.body || 'This notice has no further detail.'}
                    </p>
                    {needsMe && (
                      <Button
                        className="mt-3"
                        size="sm"
                        disabled={acking}
                        onClick={() => onAck(c.id)}
                      >
                        I have read this
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
