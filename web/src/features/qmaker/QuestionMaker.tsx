import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import {
  Badge, Button, Card, CardHeader, ConfirmButton, Dialog, EmptyState, ErrorState, Field, FormNotice, PageBody, PageHead, Select, Table, Td,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useRouteFeature } from '@/lib/catalog'
import { formatDate } from '@/lib/utils'
import { EmbeddedBody, EmbeddedHead } from '@/features/exams/embedded'
import { emptyDoc, type PaperDoc } from './lib/doc'
import { parseBundle, readBundle, uploadBundleImages } from './lib/bundle'
import PaperEditor, { type Slot } from './PaperEditor'

/* Question maker: question papers written on an A4 page in the browser, the
   way the desktop QMaker writes them, kept by the school instead of on one
   computer. A teacher's papers are theirs until they send one for approval;
   then the head of department reads that copy in Question papers. */

interface DraftRow {
  id: string
  title: string
  exam_subject_id: string | null
  exam_name: string | null
  class: string | null
  subject: string | null
  updated_at: string
  sent_status: 'submitted' | 'approved' | 'changes_needed' | null
  review_note: string | null
}

const SENT: Record<string, { label: string; tone: 'warning' | 'success' | 'danger' }> = {
  submitted: { label: 'Waiting for approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  changes_needed: { label: 'Sent back', tone: 'danger' },
}

/** A new paper, set up from the exam it is for when one is chosen. */
function NewPaper({ slots, onClose, onMade }: { slots: Slot[]; onClose: () => void; onMade: (id: string) => void }) {
  const [slot, setSlot] = useState('')
  const make = useMutation({
    mutationFn: () => {
      const s = slots.find((x) => x.exam_subject_id === slot)
      const doc = emptyDoc(s ? { examName: s.exam_name, className: s.class, subject: s.subject, maxMarks: Number(s.max_marks) || 0, date: s.exam_date ? formatDate(s.exam_date) : '' } : {})
      return api.post<{ id: string }>('/api/v1/exams/paper-drafts', { title: doc.examName, exam_subject_id: slot || null, doc })
    },
    onSuccess: (r) => onMade(r.id),
  })
  return (
    <Dialog
      title="New paper"
      description="Choose the exam it is for and the paper starts with its name, class, subject and marks filled in. You can also start blank."
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={make.isPending} pending={make.isPending} onClick={() => make.mutate()}>{slot ? 'Start the paper' : 'Start a blank paper'}</Button>
      </>}
    >
      <div className="space-y-4">
        <Field label="Exam" hint="Optional. Exams of the classes you teach.">
          <Select value={slot} onChange={setSlot} placeholder={slots.length ? 'Choose' : 'No exams scheduled for your classes'}
            options={slots.filter((s) => s.status !== 'approved').map((s) => ({ value: s.exam_subject_id, label: `${s.class} · ${s.subject} · ${s.exam_name}` }))} />
        </Field>
        <FormNotice error={make.error} />
      </div>
    </Dialog>
  )
}

/* A .qpaper from the desktop QMaker or another teacher: its pictures are
   uploaded and each paper in it becomes one of your papers. */
function useOpenFile(onOpened: (ids: string[]) => void) {
  const toast = useToast()
  const [progress, setProgress] = useState('')
  const open = useMutation({
    mutationFn: async (file: File) => {
      const got = readBundle(parseBundle(await file.text()))
      if (!got.papers.length) throw new Error(got.questions.length ? 'This file is a question bank. Open it in the Question bank tab.' : 'This file has no paper in it.')
      const ids: string[] = []
      for (const p of got.papers) {
        const { boxes: [body], images } = await uploadBundleImages([p.body], got.images, (d, t) => setProgress(`Uploading pictures: ${d} of ${t}`))
        const doc: PaperDoc = { ...p, body, images }
        const r = await api.post<{ id: string }>('/api/v1/exams/paper-drafts', { title: doc.examName, doc })
        ids.push(r.id)
      }
      return ids
    },
    onSuccess: (ids) => { setProgress(''); toast.ok(ids.length === 1 ? 'Paper opened' : `${ids.length} papers opened`); onOpened(ids) },
    onError: () => setProgress(''),
  })
  return { open, progress }
}

export default function QuestionMaker({ embedded = false, slots: given }: { embedded?: boolean; slots?: Slot[] } = {}) {
  const nav = useRouteFeature()
  const Head = embedded ? EmbeddedHead : PageHead
  const Body = embedded ? EmbeddedBody : PageBody
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const drafts = useQuery({ queryKey: ['paper-drafts'], queryFn: () => api.get<{ items: DraftRow[] }>('/api/v1/exams/paper-drafts') })
  const slotsQ = useQuery({
    queryKey: ['question-paper-slots'],
    queryFn: () => api.get<{ items: Slot[] }>('/api/v1/exams/question-papers/slots'),
    enabled: !given,
  })
  const slots = given ?? slotsQ.data?.items ?? []
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/exams/paper-drafts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper-drafts'] }),
  })
  const { open, progress } = useOpenFile((ids) => {
    qc.invalidateQueries({ queryKey: ['paper-drafts'] })
    if (ids.length === 1) setEditing(ids[0])
  })

  if (editing) return <PaperEditor id={editing} slots={slots} onBack={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['paper-drafts'] }) }} />

  const items = drafts.data?.items ?? []
  return (
    <>
      <Head
        eyebrow={nav.section?.name}
        title={nav.feature?.name ?? 'Question maker'}
        description="Write a question paper on the page, with its answer key, then print it, save it as a Word file or send it for approval."
        actions={<>
          <Button variant="secondary" pending={open.isPending} disabled={open.isPending} onClick={() => file.current?.click()}><FileUp className="size-4" /> Open a .qpaper file</Button>
          <Button onClick={() => setStarting(true)}><Plus className="size-4" /> New paper</Button>
        </>}
      />
      <Body>
        <input ref={file} type="file" accept=".qpaper,.qbank,application/json" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) open.mutate(f)
          e.target.value = ''
        }} />
        {progress && <FormNotice ok={progress} />}
        <FormNotice error={open.error ?? remove.error} />
        <Card>
          <CardHeader title="My papers" description="Only you see these until you send one." />
          {drafts.error ? <ErrorState error={drafts.error} /> : !drafts.isLoading && items.length === 0 ? (
            <EmptyState title="No papers yet." body="Start one with New paper, or open a .qpaper file made in the desktop QMaker." />
          ) : (
            <Table head={['Paper', 'For', 'Changed', 'Status', '']} loading={drafts.isLoading}>
              {items.map((d) => (
                <tr key={d.id}>
                  <Td label="Paper"><span className="font-medium">{d.title || 'Untitled paper'}</span></Td>
                  <Td label="For">{d.exam_name ? `${d.class} · ${d.subject} · ${d.exam_name}` : <span className="text-muted-foreground">Not tied to an exam yet</span>}</Td>
                  <Td label="Changed">{formatDate(d.updated_at)}</Td>
                  <Td label="Status">
                    {d.sent_status ? <Badge tone={SENT[d.sent_status].tone}>{SENT[d.sent_status].label}</Badge> : <Badge>Not sent</Badge>}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(d.id)}>Open</Button>
                      <ConfirmButton size="sm" variant="ghost" tone="danger" confirmLabel="Delete" question={d.sent_status ? 'Delete your copy? The one sent stays.' : 'Delete this paper?'} onConfirm={() => remove.mutate(d.id)}>
                        Delete
                      </ConfirmButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </Body>
      {starting && <NewPaper slots={slots} onClose={() => setStarting(false)} onMade={(id) => { setStarting(false); qc.invalidateQueries({ queryKey: ['paper-drafts'] }); setEditing(id) }} />}
    </>
  )
}
