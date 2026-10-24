import { cloneBox, type Box, type BoxMeta, type BoxNumber } from './box'
import { textToHtml } from './richdoc'
import { uid } from './util'

/* Questions from the bank as boxes on the paper.

   A question banked from Question maker carries the box it prints as; it is
   copied with fresh ids so the same question can sit on two papers. One
   banked from the plain form (a stem and options) is drawn the way the
   built-in "Question" and "MCQ" types are, so it prints like the rest. */

export interface BankItem {
  id: string
  stem: string
  kind: string
  difficulty: string
  chapter?: string | null
  default_marks?: number
  marks?: number
  options: string[]
  /** Which options are correct, when known (read one question for its answer key). */
  correct?: boolean[]
  explanation?: string
  body?: Box | null
}

const LEVELS = ['easy', 'medium', 'hard'] as const
const Q_NUM: BoxNumber = { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' }

export function bankItemBox(q: BankItem): Box {
  const meta: BoxMeta = { chapter: q.chapter || undefined, difficulty: LEVELS.find((l) => l === q.difficulty) }
  if (q.body) return { ...cloneBox(q.body, uid), meta: { ...q.body.meta, ...meta } }
  const marks = q.marks ?? q.default_marks ?? 1
  const children: Box[] = [{ id: uid(), content: textToHtml(q.stem) }]
  if (q.options.length) {
    children.push({
      id: uid(), name: 'Options', layout: { mode: 'grid', cols: q.options.every((o) => o.length <= 18) ? 4 : q.options.every((o) => o.length <= 40) ? 2 : 1 },
      children: q.options.map((o, i) => ({ id: uid(), content: textToHtml(o), number: { format: 'a', pattern: '({n})', scope: 'local' }, correct: q.correct?.[i] || undefined })),
    })
  }
  if (q.explanation) children.push({ id: uid(), visible: 'key', content: textToHtml(q.explanation) })
  if (q.kind === 'short' || q.kind === 'long') children.push({ id: uid(), visible: 'paper', content: `<div data-lines="${q.kind === 'long' ? 10 : 4}"></div>` })
  return { id: uid(), name: q.options.length ? 'MCQ' : 'Question', number: Q_NUM, marks: { mode: 'fixed', value: marks, show: true, pattern: '[{m}]' }, meta, children }
}

/** A section of the paper: a ruled heading carrying the marks of what is inside. */
export function sectionBox(title: string, questions: Box[]): Box {
  const marks = questions.map((q) => q.marks?.value ?? 0)
  const same = questions.length > 1 && marks.every((m) => m === marks[0]) && questions.every((q) => q.marks?.mode === 'fixed')
  return {
    id: uid(), name: 'Section', content: `<p>${title}</p>`, style: { bold: true, rule: true, spaceBefore: 8 },
    marks: { mode: 'sum', show: true, pattern: same ? '{k} × {e} = {m}' : '{m} Marks' }, children: questions,
  }
}
