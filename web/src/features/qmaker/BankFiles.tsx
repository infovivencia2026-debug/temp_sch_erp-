import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileDown, FileUp } from 'lucide-react'
import { api } from '@/lib/api'
import { buzz } from '@/lib/haptics'
import { Button, Dialog, Field, FormNotice, Select } from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useTeachingSubjects, type BankOption, type BankQuestion } from '@/features/faculty/teaching'
import type { Box } from './lib/box'
import { bankItemBox } from './lib/bankbox'
import { bankFields, bankFile, parseBundle, readBundle, uploadBundleImages, type Received } from './lib/bundle'
import { collectImageIds, lookupImages } from './lib/images'
import { download, safeFileName } from './lib/util'

const CHUNK = 500

/* A .qbank brought in: which subject its questions belong to is asked, because
   the desktop file names a subject as free text and the school's subjects are
   class by class. Pictures go up first, then the questions in one go per 500. */
function ImportDialog({ got, name, onClose }: { got: Received; name: string; onClose: () => void }) {
  const subjects = useTeachingSubjects()
  const toast = useToast()
  const qc = useQueryClient()
  const [subject, setSubject] = useState('')
  const [progress, setProgress] = useState('')
  const named = [...new Set(got.questions.map((b) => b.meta?.subject).filter(Boolean))].join(', ')
  const run = useMutation({
    mutationFn: async () => {
      const { boxes } = await uploadBundleImages(got.questions, got.images, (d, t) => setProgress(`Uploading pictures: ${d} of ${t}`))
      let added = 0
      for (let i = 0; i < boxes.length; i += CHUNK) {
        setProgress(`Adding questions: ${i} of ${boxes.length}`)
        const items = boxes.slice(i, i + CHUNK).map((b) => ({ ...bankFields(b), body: b }))
        added += (await api.post<{ added: number }>('/api/v1/teaching/question-bank/import', { class_subject_id: subject, items })).added
      }
      return added
    },
    onSuccess: (added) => {
      buzz('tap')
      toast.ok(`Added ${added} ${added === 1 ? 'question' : 'questions'} to the bank`)
      qc.invalidateQueries({ queryKey: ['question-bank'] })
      qc.invalidateQueries({ queryKey: ['question-bank-summary'] })
      onClose()
    },
    onSettled: () => setProgress(''),
  })
  return (
    <Dialog
      title={`Add ${got.questions.length} ${got.questions.length === 1 ? 'question' : 'questions'} from ${name}`}
      description={named ? `The file says: ${named}.` : undefined}
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!subject || run.isPending} pending={run.isPending} onClick={() => run.mutate()}>Add to the bank</Button>
      </>}
    >
      <div className="space-y-4">
        <Field label="Add them to" required>
          <Select value={subject} onChange={setSubject} placeholder="Choose a subject"
            options={(subjects.data?.items ?? []).map((s) => ({ value: s.class_subject_id, label: `${s.class_name} · ${s.subject}` }))} />
        </Field>
        {progress && <FormNotice ok={progress} />}
        <FormNotice error={run.error} />
      </div>
    </Dialog>
  )
}

/** Open a .qbank (into the bank) and save the shown questions as one (to share or open in the desktop QMaker). */
export default function BankFiles({ shown, subjectName }: { shown: BankQuestion[]; subjectName: string }) {
  const file = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const [got, setGot] = useState<{ data: Received; name: string } | null>(null)
  const read = useMutation({
    mutationFn: async (f: File) => {
      const data = readBundle(parseBundle(await f.text()))
      if (!data.questions.length) throw new Error(data.papers.length ? 'This file is a paper. Open it in the Question maker tab.' : 'This file has no questions in it.')
      return { data, name: f.name }
    },
    onSuccess: setGot,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'That file could not be read.'),
  })
  /* Every question as the box it prints as; the plain ones need their answer
     key read, one request each, so the file marks the correct options. */
  const save = useMutation({
    mutationFn: async () => {
      const boxes: Box[] = []
      for (const q of shown) {
        if (q.body) { boxes.push({ ...q.body, meta: { ...q.body.meta, subject: q.subject } }); continue }
        const full = q.options.length ? await api.get<BankQuestion & { answer_key?: BankOption[] }>(`/api/v1/teaching/question-bank/${q.id}`) : null
        const b = bankItemBox({ ...q, correct: full?.answer_key?.map((o) => o.is_correct) })
        boxes.push({ ...b, meta: { ...b.meta, subject: q.subject } })
      }
      const text = await bankFile(boxes, await lookupImages(collectImageIds(boxes)))
      download(text, `${safeFileName(`${subjectName} question bank ${new Date().toISOString().slice(0, 10)}`)}.qbank`, 'application/json')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'The file could not be made.'),
  })
  return (
    <>
      <Button variant="secondary" pending={read.isPending} disabled={read.isPending} onClick={() => file.current?.click()}><FileUp className="size-4" /> Open a .qbank file</Button>
      <Button variant="secondary" pending={save.isPending} disabled={save.isPending || !shown.length} title={shown.length ? undefined : 'No questions shown to save'} onClick={() => save.mutate()}>
        <FileDown className="size-4" /> Save as .qbank
      </Button>
      <input ref={file} type="file" accept=".qbank,.qpaper,application/json" hidden onChange={(e) => {
        const f = e.target.files?.[0]
        if (f) read.mutate(f)
        e.target.value = ''
      }} />
      {got && <ImportDialog got={got.data} name={got.name} onClose={() => setGot(null)} />}
    </>
  )
}
