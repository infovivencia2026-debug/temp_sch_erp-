import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { buzz } from '@/lib/haptics'
import { Button, Dialog, Field, FormNotice, Input, Select } from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useTeachingSubjects } from '@/features/faculty/teaching'
import { cloneBox, type Box } from '../lib/box'
import { bankFields } from '../lib/bundle'
import { uid } from '../lib/util'
import { Choice } from './BoxPanel'

/* One box from a paper into the bank, for a subject the teacher teaches. It
   goes in as the box it prints as, with the plain stem and kind the bank and
   online tests read worked out from it. A chapter typed here is matched to
   the subject's syllabus by name. */
export default function SaveToBank({ box, subjectHint, onClose }: { box: Box; subjectHint?: string; onClose: () => void }) {
  const subjects = useTeachingSubjects()
  const toast = useToast()
  const qc = useQueryClient()
  const [subject, setSubject] = useState(subjectHint ?? '')
  const [difficulty, setDifficulty] = useState<string>(box.meta?.difficulty ?? 'medium')
  const [chapter, setChapter] = useState(box.meta?.chapter ?? '')

  const save = useMutation({
    mutationFn: () => {
      const meta = { ...box.meta, difficulty: difficulty as 'easy' | 'medium' | 'hard', chapter: chapter.trim() || undefined }
      const body = { ...cloneBox(box, uid), meta, updatedAt: Date.now() }
      return api.post('/api/v1/teaching/question-bank/import', { class_subject_id: subject, items: [{ ...bankFields(body), body }] })
    },
    onSuccess: () => {
      buzz('tap')
      toast.ok('Saved to the question bank')
      qc.invalidateQueries({ queryKey: ['question-bank'] })
      qc.invalidateQueries({ queryKey: ['question-bank-summary'] })
      onClose()
    },
  })

  return (
    <Dialog
      title="Save to the question bank"
      description="It can then be inserted into any paper for this subject, by you or any teacher of it."
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!subject || save.isPending} pending={save.isPending} onClick={() => save.mutate()}>Save to the bank</Button>
      </>}
    >
      <div className="space-y-4">
        <Field label="Subject" required>
          <Select value={subject} onChange={setSubject} placeholder="Choose"
            options={(subjects.data?.items ?? []).map((s) => ({ value: s.class_subject_id, label: `${s.class_name} · ${s.subject}` }))} />
        </Field>
        <Field label="Difficulty">
          <Choice label="Difficulty" value={difficulty} onChange={setDifficulty} options={[['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']]} />
        </Field>
        <Field label="Chapter" hint="As it is named in the syllabus. Left blank if no chapter has this name.">
          <Input value={chapter} onChange={setChapter} />
        </Field>
        <FormNotice error={save.error} />
      </div>
    </Dialog>
  )
}
