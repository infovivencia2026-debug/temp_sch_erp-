import type { Box } from './box'
import { richPlain } from './richdoc'
import { paperLabels, type LabelKey, type PaperLang } from './labels'
import { esc } from './util'

/* Files from the desktop QMaker made before it moved to boxes.

   Those papers were sections of questions, and each question filled in the
   fields of a template (stem, options, pairs, parts, answer). Nothing in
   XULO is stored that way; this file only turns such a .qbank or .qpaper into
   boxes once, on import, the same way the desktop app converts them. Text in
   those files is plain with picture tokens ([[img:id|width|align]]), turned
   into editor HTML here too. */

type FieldType = 'text' | 'options' | 'truefalse' | 'pairs' | 'lines' | 'parts'
interface FieldDef { key: string; label: string; type: FieldType; answer?: boolean; default?: unknown }
export interface Template { id: string; name: string; builtin: boolean; fields: FieldDef[] }
interface QuestionLayout { optionCols?: number; optionOrder?: 'across' | 'down'; partCols?: number }
interface Part { id: string; templateId: string; marks: number; data: Record<string, unknown>; layout?: QuestionLayout }
export interface Question {
  id: string; templateId: string; subject: string; chapter: string; difficulty: 'easy' | 'medium' | 'hard'
  marks: number; data: Record<string, unknown>; layout?: QuestionLayout; updatedAt: number
}
interface Section {
  id: string; title: string; instruction: string; questionIds: string[]
  marksEach?: number; attempt?: number; layout?: QuestionLayout; alternatives?: Record<string, string>
}
export interface OldPaper {
  id: string; examName: string; subject: string; className: string; duration: string; date: string
  instructions: string; answerSpace: boolean; labelLang?: PaperLang; sections: Section[]
  locked?: { questions: Question[]; templates: Template[] }
}

const t = (id: string, name: string, fields: FieldDef[]): Template => ({ id, name, builtin: true, fields })

/** The desktop app's built-in templates; a file names them by id and carries only its own. */
export const BUILTIN_TEMPLATES: Template[] = [
  t('mcq', 'Multiple Choice', [
    { key: 'stem', label: 'Question', type: 'text' },
    { key: 'options', label: 'Options', type: 'options', default: { items: ['', '', '', ''], correct: null } },
  ]),
  t('fib', 'Fill in the Blank', [{ key: 'stem', label: 'Sentence', type: 'text' }, { key: 'answer', label: 'Answer', type: 'text', answer: true }]),
  t('tf', 'True / False', [{ key: 'stem', label: 'Statement', type: 'text' }, { key: 'answer', label: 'Answer', type: 'truefalse', answer: true, default: null }]),
  t('match', 'Match the Following', [
    { key: 'stem', label: 'Instruction', type: 'text', default: 'Match the following:' },
    { key: 'pairs', label: 'Pairs', type: 'pairs', default: [] },
  ]),
  t('short', 'Short Answer', [
    { key: 'stem', label: 'Question', type: 'text' }, { key: 'lines', label: 'Answer lines', type: 'lines', default: 3 },
    { key: 'answer', label: 'Model answer', type: 'text', answer: true },
  ]),
  t('long', 'Long Answer', [
    { key: 'stem', label: 'Question', type: 'text' }, { key: 'lines', label: 'Answer lines', type: 'lines', default: 12 },
    { key: 'answer', label: 'Model answer', type: 'text', answer: true },
  ]),
  t('multi', 'Question with Parts', [{ key: 'stem', label: 'Main question', type: 'text' }, { key: 'parts', label: 'Parts', type: 'parts', default: { numbering: 'a', items: [] } }]),
  t('case', 'Case Study / Passage', [{ key: 'stem', label: 'Passage', type: 'text' }, { key: 'parts', label: 'Questions', type: 'parts', default: { numbering: 'i', items: [] } }]),
]

// ---------- picture tokens to editor HTML ----------

const TOKEN_RE =
  /\[\[img:([A-Za-z0-9-]+)\|(\d+(?:\.\d+)?)\|(inline|left|center|right)\]\]|\[\[imgs:([^|\]]*)\|(\d+)\|(\d+(?:\.\d+)?)\|(none|a|i|1|A)\|(left|center)\]\]/g
type GroupLabel = 'none' | 'a' | 'i' | '1' | 'A'
type Seg =
  | { kind: 'text'; text: string }
  | { kind: 'img'; id: string; width: number; align: string }
  | { kind: 'grp'; items: { id: string; caption: string }[]; cols: number; width: number; label: GroupLabel }

function parseRich(s: string): Seg[] {
  const segs: Seg[] = []
  let last = 0
  for (const m of s.matchAll(TOKEN_RE)) {
    segs.push({ kind: 'text', text: s.slice(last, m.index) })
    if (m[1]) segs.push({ kind: 'img', id: m[1], width: Number(m[2]), align: m[3] })
    else {
      const items = m[4].split(',').filter(Boolean).map((part) => {
        const cut = part.indexOf('~')
        let caption = ''
        try { caption = cut < 0 ? '' : decodeURIComponent(part.slice(cut + 1)) } catch { caption = part.slice(cut + 1) }
        return { id: cut < 0 ? part : part.slice(0, cut), caption }
      })
      segs.push({ kind: 'grp', items, cols: Number(m[5]), width: Number(m[6]), label: m[7] as GroupLabel })
    }
    last = m.index! + m[0].length
  }
  segs.push({ kind: 'text', text: s.slice(last) })
  return segs
}

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx']
function groupLabel(label: GroupLabel, i: number) {
  if (label === 'none') return ''
  if (label === 'i') return `(${ROMAN[i] ?? i + 1})`
  if (label === '1') return `(${i + 1})`
  return `(${String.fromCharCode((label === 'A' ? 65 : 97) + (i % 26))})`
}

/** Old plain text with picture tokens to editor HTML. Rows of pictures become a borderless table. */
export function legacyToHtml(s: string): string {
  if (!s) return ''
  if (s.trimStart().startsWith('<')) return s
  const paras: string[] = []
  let cur = ''
  const flush = () => { paras.push(`<p>${cur}</p>`); cur = '' }
  const segs = parseRich(s)
  const isBlock = (x?: Seg) => (x?.kind === 'img' && x.align !== 'inline' && x.align !== 'right') || x?.kind === 'grp'
  segs.forEach((seg, i) => {
    if (seg.kind === 'text') {
      let text = seg.text
      if (isBlock(segs[i - 1])) text = text.replace(/^\n/, '')
      if (isBlock(segs[i + 1])) text = text.replace(/\n$/, '')
      text.split('\n').forEach((line, k) => { if (k) flush(); cur += esc(line) })
      return
    }
    if (seg.kind === 'img') {
      const tag = `<img data-id="${seg.id}" data-width="${seg.width}" data-align="${seg.align}">`
      if (seg.align === 'inline' || seg.align === 'right') cur += tag
      else { if (cur) flush(); paras.push(`<p>${tag}</p>`) }
      return
    }
    if (cur) flush()
    const cols = Math.max(1, Math.min(seg.cols || seg.items.length, seg.items.length || 1))
    const cells = seg.items.map((it, k) => {
      const cap = [groupLabel(seg.label, k), it.caption].filter(Boolean).join(' ')
      return `<td><p style="text-align: center"><img data-id="${it.id}" data-width="${seg.width || 25}" data-align="inline"></p>${cap ? `<p style="text-align: center">${esc(cap)}</p>` : ''}</td>`
    })
    const rows: string[] = []
    for (let r = 0; r < cells.length; r += cols) rows.push(`<tr>${cells.slice(r, r + cols).join('')}</tr>`)
    paras.push(`<table data-borderless="true"><tbody>${rows.join('')}</tbody></table>`)
  })
  if (cur || !paras.length) flush()
  return paras.join('')
}

// ---------- fields to boxes ----------

const asText = (v: unknown) => (typeof v === 'string' ? v : '')
const asOptions = (v: unknown) => {
  const o = v as { items?: unknown; items2?: unknown; correct?: unknown } | undefined
  return { items: Array.isArray(o?.items) ? (o.items as string[]) : [], items2: Array.isArray(o?.items2) ? (o.items2 as string[]) : undefined, correct: typeof o?.correct === 'number' ? o.correct : null }
}
const asPairs = (v: unknown): [string, string][] => (Array.isArray(v) ? (v as [string, string][]).filter((p) => p[0] || p[1]) : [])
const asParts = (v: unknown) => {
  const p = v as { numbering?: 'a' | 'i' | '1'; items?: Part[] } | undefined
  return { numbering: p?.numbering ?? 'a', items: Array.isArray(p?.items) ? p!.items : [] }
}
const fieldValue = (q: { data: Record<string, unknown> }, f: FieldDef) => q.data[f.key] ?? f.default
const secondKey = (key: string) => `${key}@2`

/** Options print in 4, 2 or 1 columns depending on how long they are. */
function optionColumns(items: string[]) {
  const img = Math.max(0, ...items.map((s) => Math.max(0, ...parseRich(s).map((x) => (x.kind === 'img' ? x.width : x.kind === 'grp' ? (x.width || 20) * x.items.length : 0)))))
  if (img) return img <= 35 ? 4 : img <= 80 ? 2 : 1
  const longest = Math.max(0, ...items.map((s) => richPlain(s).length))
  return longest <= 18 ? 4 : longest <= 40 ? 2 : 1
}

const answerLabel = (template: Template, label: string, L: (k: LabelKey) => string) =>
  !template.builtin ? label : /model/i.test(label) ? L('modelAnswer') : L('answer')

let seq = 0
const bid = (base: string, part: string) => `${base}~${part}~${seq++}`
const html = (s: string) => (s ? legacyToHtml(s) : '')
const withLabel = (label: string, body: string) =>
  /^<p(\s[^>]*)?>/.test(body) ? body.replace(/^<p(\s[^>]*)?>/, (m) => `${m}<strong>${esc(label)}:</strong> `) : `<p><strong>${esc(label)}:</strong></p>${body}`

interface Ctx { templates: Map<string, Template>; L: (k: LabelKey, vars?: Record<string, string | number>) => string; answerSpace: boolean }

function fieldsToBoxes(q: { id: string; data: Record<string, unknown>; layout?: QuestionLayout }, t: Template, ctx: Ctx, sectionLayout?: QuestionLayout): Box[] {
  const layout = { optionCols: q.layout?.optionCols || sectionLayout?.optionCols || 0, optionOrder: q.layout?.optionOrder ?? sectionLayout?.optionOrder ?? 'across', partCols: q.layout?.partCols || sectionLayout?.partCols || 1 }
  const out: Box[] = []
  for (const f of t.fields) {
    const v = fieldValue(q, f)
    switch (f.type) {
      case 'text': {
        const text = asText(v), text2 = asText(q.data[secondKey(f.key)])
        if (!text && !text2) break
        if (f.answer) out.push({ id: bid(q.id, f.key), visible: 'key', content: withLabel(answerLabel(t, f.label, ctx.L), html(text)), content2: text2 ? html(text2) : undefined })
        else out.push({ id: bid(q.id, f.key), content: html(text), content2: text2 ? html(text2) : undefined })
        break
      }
      case 'truefalse':
        if (typeof v === 'boolean') out.push({ id: bid(q.id, f.key), visible: 'key', content: `<p><strong>${esc(answerLabel(t, f.label, ctx.L))}:</strong> ${ctx.L(v ? 'true' : 'false')}</p>` })
        break
      case 'options': {
        const o = asOptions(v)
        out.push({
          id: bid(q.id, 'options'), name: 'Options',
          layout: { mode: 'grid', cols: layout.optionCols || optionColumns(o.items), order: layout.optionOrder },
          children: o.items.map((it, i) => ({
            id: bid(q.id, `opt${i}`), content: html(it), content2: o.items2?.[i] ? html(o.items2[i]) : undefined,
            number: { format: 'a', pattern: '({n})', scope: 'local' }, correct: i === o.correct || undefined,
          })),
        })
        break
      }
      case 'pairs': {
        const pairs = asPairs(v)
        if (!pairs.length) break
        out.push({
          id: bid(q.id, 'match'), name: 'Match columns', layout: { mode: 'grid', cols: 2 }, style: { border: true },
          children: [
            { id: bid(q.id, 'colA'), content: '<p><strong>A</strong></p>', children: pairs.map((p, i) => ({ id: bid(q.id, `a${i}`), content: html(p[0]), number: { format: '1', pattern: '{n}.', scope: 'local' } })) },
            { id: bid(q.id, 'colB'), content: '<p><strong>B</strong></p>', shuffle: true, children: pairs.map((p, i) => ({ id: bid(q.id, `b${i}`), content: html(p[1]), number: { format: 'a', pattern: '({n})', scope: 'local' } })) },
          ],
        })
        break
      }
      case 'lines': {
        const n = Math.min(Number(v) || 0, 60)
        if (n && ctx.answerSpace) out.push({ id: bid(q.id, 'lines'), visible: 'paper', content: `<div data-lines="${n}"></div>` })
        break
      }
      case 'parts': {
        const { numbering, items } = asParts(v)
        const pc = Math.min(layout.partCols, Math.max(1, items.length))
        const partBoxes: Box[] = items.map((p) => {
          const pt = ctx.templates.get(p.templateId)
          return {
            id: bid(q.id, `part-${p.id}`),
            number: { format: numbering === 'i' ? 'i' : numbering === '1' ? '1' : 'a', pattern: '({n})', scope: 'local' },
            marks: { mode: 'fixed', value: p.marks, show: true, pattern: '[{m}]' },
            children: pt ? fieldsToBoxes(p, pt, ctx, sectionLayout) : [],
          }
        })
        out.push(pc > 1 ? { id: bid(q.id, 'parts'), layout: { mode: 'grid', cols: pc }, children: partBoxes } : { id: bid(q.id, 'parts'), children: partBoxes })
        break
      }
    }
  }
  return out
}

const templateMap = (custom: Template[]) => new Map([...BUILTIN_TEMPLATES, ...custom.filter((x) => !x.builtin)].map((x) => [x.id, x]))

/** One older bank question as a banked box: numbered, with its marks, content and answers. */
export function questionToBox(q: Question, custom: Template[]): Box | null {
  const templates = templateMap(custom)
  const tpl = templates.get(q.templateId)
  if (!tpl) return null
  return {
    id: `lib~${q.id}`, name: tpl.name, updatedAt: q.updatedAt,
    meta: { subject: q.subject, chapter: q.chapter, difficulty: q.difficulty },
    number: { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' },
    marks: { mode: 'fixed', value: q.marks, show: true, pattern: '[{m}]' },
    children: fieldsToBoxes(q, tpl, { templates, L: paperLabels(), answerSpace: true }),
  }
}

/** A whole older paper as one root box: sections become headed boxes, questions numbered boxes. */
export function paperToBox(paper: OldPaper, questions: Question[], custom: Template[]): Box {
  const templates = templateMap([...custom, ...(paper.locked?.templates ?? [])])
  const byId = new Map((paper.locked?.questions ?? questions).map((q) => [q.id, q]))
  const L = paperLabels(paper.labelLang)
  const ctx: Ctx = { templates, L, answerSpace: paper.answerSpace }
  const root: Box = { id: `${paper.id}~root`, children: [] }
  if (paper.instructions?.trim()) {
    root.children!.push({ id: bid(paper.id, 'instructions'), name: 'Instructions', style: { scale: 0.92 }, content: `<p><strong>${esc(L('instructions'))}:</strong></p>${html(paper.instructions.trim())}` })
  }
  for (const s of paper.sections ?? []) {
    const resolved = s.questionIds.flatMap((qid) => {
      const q = byId.get(qid), tpl = q && templates.get(q.templateId)
      if (!q || !tpl) return []
      const alt = s.alternatives?.[qid] ? byId.get(s.alternatives[qid]) : undefined
      const altT = alt && templates.get(alt.templateId)
      return [{ q, tpl, marks: s.marksEach || q.marks, alt: alt && altT ? { q: alt, tpl: altT } : undefined }]
    })
    const qBox = (q: Question, tpl: Template, marks: number, show: boolean): Box => ({
      id: bid(q.id, 'q'), meta: { subject: q.subject, chapter: q.chapter, difficulty: q.difficulty },
      marks: { mode: 'fixed', value: marks, show, pattern: '[{m}]' }, children: fieldsToBoxes(q, tpl, ctx, s.layout),
    })
    const boxes: Box[] = resolved.map((r) => {
      const main = qBox(r.q, r.tpl, r.marks, !r.alt)
      if (!r.alt) return { ...main, number: { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' } }
      return {
        id: bid(r.q.id, 'or'), number: { format: '1', pattern: '{n}.', scope: 'paper', counter: 'q' }, choice: true,
        marks: { mode: 'best', best: 1, show: true, pattern: '[{m}]' },
        children: [{ ...main, marks: { mode: 'fixed', value: r.marks, show: false } }, qBox(r.alt.q, r.alt.tpl, r.marks, false)],
      }
    })
    const attempt = s.attempt && s.attempt < resolved.length ? s.attempt : 0
    const instr = s.instruction?.trim() || (attempt ? L('anyOf', { n: attempt, m: resolved.length }) : '')
    const children: Box[] = []
    if (instr) children.push({ id: bid(s.id, 'instr'), style: { italic: true, scale: 0.92 }, content: html(instr) })
    children.push(...boxes)
    const each = resolved.length > 1 && resolved.every((r) => r.marks === resolved[0].marks)
    root.children!.push({
      id: bid(s.id, 'section'), name: s.title || 'Section', content: `<p>${esc(s.title)}</p>`,
      style: { bold: true, rule: true, spaceBefore: 8 },
      marks: { mode: attempt ? 'best' : 'sum', best: attempt || undefined, show: true, pattern: each && (attempt || resolved.length) > 1 ? '{k} × {e} = {m}' : `{m} ${L('marks')}` },
      children,
    })
  }
  return root
}
