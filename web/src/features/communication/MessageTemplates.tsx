import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Search } from 'lucide-react'
import {
  Card, CardHeader, Button, Input, Textarea, Loading, ErrorState, Badge, FormNotice,
} from '@/components/ui'
import { api, type List } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The words the school actually sends.
 *
 * Every message this product puts in a parent's hand comes from a template, and
 * until now not one of them could be read, let alone changed. The endpoints have
 * been here all along — the list even merges the built-ins with a school's own
 * overrides and marks each one editable — and nothing in the interface called
 * them. So a school's fee reminder said what a developer in another city had
 * decided it said, and the only evidence a template existed at all was the error
 * you got when one did not:
 *
 *     0 sent, 1 not sent: ... no template "admissions.offer" for sms
 *
 * That message named a thing the reader had never seen and could not act on.
 *
 * WHAT A BUILT-IN IS. Not a locked row: a default. Editing one writes a row of
 * the school's own, which the resolver prefers from then on — the database is
 * checked before the built-in list. Nothing is destroyed and the original text
 * stays in the product, so a school that edits badly is one Reset away from the
 * wording that worked.
 *
 * ONE CODE, FOUR CHANNELS. The same code exists per channel because the same
 * fact needs different words in each: an SMS is billed by the character and a
 * DLT-registered sender cannot improvise, while an email can carry a paragraph.
 * They are listed together under the code so the difference is visible rather
 * than discovered.
 */
interface Template {
  code: string
  channel: string
  subject: string
  body: string
  dlt_template_id: string
  is_active: boolean
  built_in: boolean
  editable: boolean
}

const CHANNEL_LABEL: Record<string, string> = {
  email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', in_app: 'In app',
}

export default function MessageTemplates() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const templates = useQuery({
    queryKey: ['message-templates'],
    queryFn: () => api.get<List<Template>>('/api/v1/admin/messaging/templates'),
  })

  const save = useMutation({
    mutationFn: (t: Pick<Template, 'code' | 'channel' | 'subject' | 'body'>) =>
      api.put('/api/v1/admin/messaging/templates', t),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['message-templates'] }),
  })

  /* Grouped by code, because that is the unit a person thinks in: "what do we
     say when a place is offered", not "what does admissions.offer say on SMS". */
  const groups = useMemo(() => {
    const items = templates.data?.items ?? []
    const needle = q.trim().toLowerCase()
    const by = new Map<string, Template[]>()
    for (const t of items) {
      if (needle && !`${t.code} ${t.subject} ${t.body}`.toLowerCase().includes(needle)) continue
      const list = by.get(t.code) ?? []
      list.push(t)
      by.set(t.code, list)
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [templates.data, q])

  if (templates.isLoading) return <Loading />
  if (templates.error) return <ErrorState error={templates.error} />

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={setQ}
            placeholder="Search the wording, or the code"
            className="w-full pl-8"
          />
        </div>
        <p className="text-[13px] text-muted-foreground">
          {groups.length} message{groups.length === 1 ? '' : 's'}
        </p>
      </div>

      {groups.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          Nothing matches “{q}”.
        </p>
      )}

      {groups.map(([code, rows]) => (
        <Card key={code}>
          <CardHeader
            title={titleFor(code)}
            description={code}
            action={
              <Button
                variant="secondary"
                onClick={() => setOpen(open === code ? null : code)}
              >
                {open === code ? 'Close' : 'Edit wording'}
              </Button>
            }
          />
          {open === code && (
            <div className="space-y-4 border-t p-5">
              {rows.map((t) => (
                <ChannelEditor
                  key={t.channel}
                  t={t}
                  onSave={(subject, body) =>
                    save.mutate({ code: t.code, channel: t.channel, subject, body })
                  }
                  saving={save.isPending}
                />
              ))}
              <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
            </div>
          )}
        </Card>
      ))}
    </div>
  )
}

/* One channel of one message. Its own component because each keeps its own
   draft: opening a card and typing into the SMS body must not mark the email
   dirty, and a save sends one channel rather than all four. */
function ChannelEditor({
  t, onSave, saving,
}: {
  t: Template
  onSave: (subject: string, body: string) => void
  saving: boolean
}) {
  const [subject, setSubject] = useState(t.subject)
  const [body, setBody] = useState(t.body)
  const dirty = subject !== t.subject || body !== t.body

  return (
    <div className={cn('rounded-md border p-4', dirty && 'border-primary/50')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-[13px] font-medium">{CHANNEL_LABEL[t.channel] ?? t.channel}</span>
        {/* Said plainly, because 'built-in' is the state people misread as
            'locked'. It is a default, and editing it makes one of your own. */}
        {t.built_in && <Badge tone="neutral">Default wording — editing makes it yours</Badge>}
        {!t.built_in && <Badge tone="success">This school&rsquo;s own</Badge>}
      </div>

      {/* SMS carries no subject line. Showing the field would invite somebody
          to write one and wonder where it went. */}
      {t.channel !== 'sms' && (
        <label className="mb-3 block">
          <span className="mb-1 block text-[13px] text-muted-foreground">Subject</span>
          <Input value={subject} onChange={setSubject} className="w-full" />
        </label>
      )}

      <label className="block">
        <span className="mb-1 block text-[13px] text-muted-foreground">
          Message. {'{{'}placeholders{'}}'} are filled in when it is sent.
        </span>
        <Textarea value={body} onChange={setBody} rows={5} className="w-full" />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={!dirty || saving}
          onClick={() => onSave(subject.trim(), body.trim())}
        >
          {saving ? 'Saving…' : 'Save this wording'}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            onClick={() => { setSubject(t.subject); setBody(t.body) }}
          >
            Undo
          </Button>
        )}
        {t.channel === 'sms' && (
          <span className="text-[13px] text-muted-foreground">
            {body.length} characters · {Math.max(1, Math.ceil(body.length / 160))} SMS
          </span>
        )}
      </div>
    </div>
  )
}

/* A human title from a code. The codes are namespaced by the thing that sends
   them, which is the right key and the wrong heading. */
function titleFor(code: string): string {
  const [group, ...rest] = code.split('.')
  const name = rest.join('.').replace(/_/g, ' ')
  const area = group.replace(/_/g, ' ')
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} — ${area}`
}
