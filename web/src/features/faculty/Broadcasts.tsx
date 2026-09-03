import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, Users } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Checkbox, Field, FormNotice, Input, Select,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import { useMyClasses, useRoster, type Broadcast } from './comms'

/* Writing home.

   A class teacher's message goes to the same circulars screen the office
   already uses, with the same acknowledgements on it. A second inbox is how a
   parent ends up missing the one that mattered.

   Two kinds of message, and the second is the one that did not exist before:
   the whole class, or one child's family. "Aarav has not returned the consent
   form" was being sent by telephone because there was no way to address it. */

export default function Broadcasts() {
  const [composing, setComposing] = useState(false)

  const list = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => api.get<List<Broadcast>>('/api/v1/teaching/broadcasts'),
  })

  if (list.isLoading) return <SkeletonTiles count={3} />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Classroom communication"
        description="Notices to the parents of a whole class, or of one child. They appear in the parent's circulars, and you can ask for an acknowledgement."
        actions={
          <Button onClick={() => setComposing((c) => !c)}>
            <Send className="h-3.5 w-3.5" />
            {composing ? 'Close' : 'Write a notice'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Notices" value={rows.length} />
          <Stat
            label="Awaiting a reply"
            value={rows.filter((b) => b.requires_ack && b.acknowledgements === 0).length}
          />
          <Stat
            label="Acknowledgements"
            value={rows.reduce((n, b) => n + b.acknowledgements, 0)}
            icon={Users}
          />
        </CellGrid>

        {composing && <Compose onClose={() => setComposing(false)} />}

        <Card>
          <CardHeader title="Sent" description="Most recent first" />
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing sent yet"
              body="A notice you send appears here with a running count of how many parents have acknowledged it."
            />
          ) : (
            <ul className="divide-y">
              {rows.map((b) => (
                <li key={b.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium">{b.title}</span>
                    <Badge>
                      {b.students > 0
                        ? `${b.students} ${b.students === 1 ? 'child' : 'children'}`
                        : `${b.sections} ${b.sections === 1 ? 'class' : 'classes'}`}
                    </Badge>
                    {b.requires_ack && (
                      <Badge tone={b.acknowledgements ? 'success' : 'warning'}>
                        {b.acknowledgements} acknowledged
                      </Badge>
                    )}
                    {!b.mine && <Badge tone="info">sent to your class</Badge>}
                  </div>
                  <p className="mt-1.5 text-[14px] text-muted-foreground">{b.body}</p>
                  <p className="mt-1.5 text-[13px] text-muted-foreground">{formatDate(b.published_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function Compose({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const classes = useMyClasses()
  const [target, setTarget] = useState<'class' | 'child'>('class')
  const [sectionID, setSectionID] = useState('')
  const [studentID, setStudentID] = useState('')
  const roster = useRoster(sectionID)

  const [f, setF] = useState({
    title: '',
    body: '',
    requires_ack: false,
    /* Off by default, all three.

       A notice in the portal costs nothing; a WhatsApp costs money per
       conversation and an SMS costs a text, so the teacher says so each time
       rather than discovering at the end of the month that every "bring your
       PT kit" went out three ways. */
    send_email: false,
    send_sms: false,
    send_whatsapp: false,
  })

  /* One reference for this composed notice, minted when the form opens and
     kept across every retry of it. It is what makes a double tap, or a resend
     after a dropped response, answer with the notice already published rather
     than texting the class a second time. */
  const [clientRef] = useState(() => crypto.randomUUID())

  const send = useMutation({
    mutationFn: () =>
      api.post<{
        recipients: number
        messages_queued?: number
        messages_failed?: number
        send_error?: string
        duplicate?: boolean
      }>('/api/v1/teaching/broadcasts', {
        client_ref: clientRef,
        title: f.title,
        body: f.body,
        requires_ack: f.requires_ack,
        send_email: f.send_email,
        send_sms: f.send_sms,
        send_whatsapp: f.send_whatsapp,
        // One or the other, never both: a notice addressed to a child and to
        // their whole class reaches the class, which is not what was meant.
        section_ids: target === 'class' && sectionID ? [sectionID] : [],
        student_ids: target === 'child' && studentID ? [studentID] : [],
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] })
      qc.invalidateQueries({ queryKey: ['comms-summary'] })
      if (r.duplicate) {
        toast.ok('Already sent — this notice was published once, not twice')
        onClose()
        return
      }
      /* A notice that went into the portal but whose texts did not leave is
         not a success worth a green toast. The teacher stops chasing it
         otherwise, and nobody outside the app ever hears from them. */
      if (r.send_error || r.messages_failed) {
        // error, not ok: it stays until dismissed, and an unsent notice must be read.
        toast.error(
          `Published to ${r.recipients} ${r.recipients === 1 ? 'household' : 'households'}, but ` +
            `${r.messages_failed ?? 'some'} messages did not go out. The notice is in the parents’ ` +
            `circulars; the email, SMS or WhatsApp was not sent.`,
        )
        onClose()
        return
      }
      toast.ok(
        `Sent to ${r.recipients} ${r.recipients === 1 ? 'household' : 'households'}` +
          (r.messages_queued ? ` · ${r.messages_queued} messages queued` : ''),
      )
      onClose()
    },
  })

  const ready = f.title.trim() && f.body.trim() && (target === 'class' ? sectionID : studentID)

  return (
    <Card>
      <CardHeader title="New notice" description="Goes to the parent's circulars straight away." />
      <form
        className="space-y-4 px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          // Guarded as well as disabled: an Enter key repeat beats the button's
          // disabled state, and the second submit is a second notice.
          if (send.isPending) return
          send.mutate()
        }}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Send to">
            <Select
              value={target}
              onChange={(v) => setTarget(v as 'class' | 'child')}
              options={[
                { value: 'class', label: 'A whole class' },
                { value: 'child', label: 'One child’s parent' },
              ]}
            />
          </Field>
          <Field label="Class" required>
            <Select
              value={sectionID}
              onChange={(v) => {
                setSectionID(v)
                setStudentID('')
              }}
              placeholder="Choose a class you teach"
              options={(classes.data?.items ?? []).map((c) => ({
                value: c.section_id,
                label: `${c.class_name}-${c.section_name}`,
              }))}
            />
          </Field>
          {target === 'child' && (
            <Field label="Child" required wide>
              <Select
                value={studentID}
                onChange={setStudentID}
                placeholder={sectionID ? 'Choose a child' : 'Choose a class first'}
                options={(roster.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: `${s.full_name} — ${s.admission_no}`,
                }))}
              />
            </Field>
          )}
        </div>

        <Input value={f.title} onChange={(v) => setF({ ...f, title: v })} placeholder="Subject" className="w-full" />
        <textarea
          value={f.body}
          onChange={(e) => setF({ ...f, body: e.target.value })}
          rows={4}
          placeholder="Please send the signed consent slip for Friday's field trip by Wednesday."
          className="field h-auto w-full py-2"
        />
        <Checkbox
          checked={f.requires_ack}
          onChange={(v) => setF({ ...f, requires_ack: v })}
          label="Ask for an acknowledgement"
          hint="Use it when you need to know the parent read it — consent, money, a deadline."
        />

        {/* The same three the principal's circular offers. A notice that only
            lands in the portal reaches whichever families opened the app that
            evening, which for most of them is none. */}
        <div className="flex flex-wrap items-center gap-4">
          <Checkbox
            checked={f.send_email}
            onChange={(v) => setF({ ...f, send_email: v })}
            label="Also send email"
          />
          <Checkbox
            checked={f.send_sms}
            onChange={(v) => setF({ ...f, send_sms: v })}
            label="Also send SMS"
          />
          <Checkbox
            checked={f.send_whatsapp}
            onChange={(v) => setF({ ...f, send_whatsapp: v })}
            label="Also send WhatsApp"
          />
        </div>

        <FormNotice error={send.error} />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={send.isPending || !ready}>
            <Send className="h-3.5 w-3.5" />
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
