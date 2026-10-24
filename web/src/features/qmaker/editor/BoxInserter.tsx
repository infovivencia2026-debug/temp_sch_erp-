import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Badge, Dialog, EmptyState, ErrorState, Field, FormNotice, Loading, Select, TAB_BAR, tabClass } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { DIFFICULTIES, label, useTeachingSubjects, type BankOption, type BankQuestion } from '@/features/faculty/teaching'
import type { Box } from '../lib/box'
import { PRESETS, PRESET_GROUPS } from '../lib/presets'
import { bankItemBox } from '../lib/bankbox'
import { collectImageIds, lookupImages, type ImageAsset } from '../lib/images'

type Picked = { box: Box; images: Record<string, ImageAsset> }

/* What goes in at a + on the paper: one of the ready-made types (each an
   ordinary box with some settings on, changed freely once in), or a question
   from the school's bank for a subject the teacher teaches. */
export default function BoxInserter({ onPick, onClose, subjectHint }: {
  onPick: (p: Picked) => void
  onClose: () => void
  /** The paper's own class and subject, chosen first in the bank tab. */
  subjectHint?: string
}) {
  const [tab, setTab] = useState<'types' | 'bank'>('types')
  const [q, setQ] = useState('')
  const subjects = useTeachingSubjects()
  const [subject, setSubject] = useState(subjectHint ?? '')

  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase())
  const presets = PRESETS.filter((p) => match(`${p.name} ${p.group} ${p.hint}`))

  const bank = useQuery({
    queryKey: ['question-bank', `inserter:${subject}:${q.trim()}`],
    queryFn: () => api.get<List<BankQuestion>>(`/api/v1/teaching/question-bank?class_subject_id=${subject}${q.trim() ? `&search=${encodeURIComponent(q.trim())}` : ''}`),
    enabled: tab === 'bank' && !!subject,
  })

  /* A question banked from the plain form keeps its answer key apart; read it
     so the correct option is marked. A rich one already carries it. */
  const take = useMutation({
    mutationFn: async (item: BankQuestion & { body?: Box }) => {
      let correct: boolean[] | undefined
      if (!item.body && item.options.length) {
        const full = await api.get<BankQuestion & { answer_key?: BankOption[] }>(`/api/v1/teaching/question-bank/${item.id}`)
        correct = full.answer_key?.map((o) => o.is_correct)
      }
      const box = bankItemBox({ ...item, correct })
      return { box, images: await lookupImages(collectImageIds(box)) }
    },
    onSuccess: onPick,
  })

  return (
    <Dialog title="Insert" size="xl" onClose={onClose}>
      <div className="space-y-4">
        <div className={TAB_BAR} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'types'} className={tabClass(tab === 'types')} onClick={() => setTab('types')}>Question types</button>
          <button type="button" role="tab" aria-selected={tab === 'bank'} className={tabClass(tab === 'bank')} onClick={() => setTab('bank')}>Question bank</button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {tab === 'bank' && (
            <div className="w-full sm:w-72">
              <Field label="Subject">
                <Select value={subject} onChange={setSubject} placeholder="Choose"
                  options={(subjects.data?.items ?? []).map((s) => ({ value: s.class_subject_id, label: `${s.class_name} · ${s.subject}` }))} />
              </Field>
            </div>
          )}
          <SearchBox value={q} onChange={setQ} placeholder={tab === 'types' ? 'Search question types' : 'Search the questions'} />
        </div>

        {tab === 'types' && (presets.length === 0 ? (
          <EmptyState title="No question type has that name." body="Try a shorter word, such as MCQ, match or passage." />
        ) : PRESET_GROUPS.map((g) => {
          const items = presets.filter((p) => p.group === g)
          if (!items.length) return null
          return (
            <section key={g}>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</h3>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((p) => (
                  <li key={p.name}>
                    <button type="button" className="qm-pick" onClick={() => onPick({ box: p.make(), images: {} })}>
                      <span className="font-medium">{p.name}</span>
                      <span className="text-[12px] text-muted-foreground">{p.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )
        }))}

        {tab === 'bank' && (!subject ? (
          <EmptyState title="Choose a subject." body="The bank shows the questions of one class and subject at a time." />
        ) : bank.isLoading ? <Loading shape="table" rows={4} /> : bank.error ? <ErrorState error={bank.error} /> : !bank.data?.items.length ? (
          <EmptyState title={q.trim() ? 'No question matches.' : 'No questions banked for this subject yet.'}
            body="Save any question on a paper to the bank with the bookmark button over it, or add them in the Question bank tab." />
        ) : (
          <>
            <FormNotice error={take.error} />
            <ul className="space-y-2">
              {bank.data.items.map((item) => (
                <li key={item.id}>
                  <button type="button" className="qm-pick" disabled={take.isPending} onClick={() => take.mutate(item as BankQuestion & { body?: Box })}>
                    <span className="line-clamp-2">{item.stem}</span>
                    <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                      <Badge>{item.default_marks} {item.default_marks === 1 ? 'mark' : 'marks'}</Badge>
                      {label(DIFFICULTIES, item.difficulty)}
                      {item.chapter && <span className="truncate">· {item.chapter}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ))}
      </div>
    </Dialog>
  )
}
