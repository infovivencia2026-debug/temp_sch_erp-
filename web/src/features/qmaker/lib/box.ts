/**
 * The Box model: a paper is a tree of Boxes. A Box has optional rich content, optional children, and
 * optional behaviours (numbered, marks, choice, visibility, layout, style). Nothing is special-cased:
 * a "question", "section", "MCQ" or "case study" is just a Box with some switches on.
 */

export type NumberFormat = '1' | 'a' | 'A' | 'i' | 'I'

export interface BoxNumber {
  format: NumberFormat
  /** How the number is printed, {n} is the number: "{n}.", "({n})", "Q{n}." … */
  pattern: string
  /** 'local' restarts inside each parent; 'paper' continues through the whole paper (shared by name). */
  scope: 'local' | 'paper'
  /** Boxes with the same counter count together. */
  counter?: string
}

export interface BoxMarks {
  /** fixed: this box is worth `value`; sum: its children added up; best: the best `best` children. */
  mode: 'fixed' | 'sum' | 'best'
  value?: number
  best?: number
  /** Print the marks on the right of the box's first line. */
  show: boolean
  /** How marks print: {m} = marks; {k}/{e} = how many / each (when all equal). */
  pattern?: string
}

export interface BoxLayout {
  mode: 'stack' | 'grid'
  /** Grid columns (0 = one row with every child). */
  cols?: number
  /** Column widths in % (optional; equal if missing). */
  widths?: number[]
  /** Fill order of the grid. */
  order?: 'across' | 'down'
  gapMm?: number
}

export interface BoxStyle {
  border?: boolean
  /** A line under the box's first line (section headings). */
  rule?: boolean
  paddingMm?: number
  align?: 'left' | 'center' | 'right'
  bold?: boolean
  italic?: boolean
  /** Font size relative to the paper (1 = normal). */
  scale?: number
  /** Space above, in points. */
  spaceBefore?: number
  /** Start a new page before this box. */
  pageBreak?: boolean
}

export interface BoxMeta {
  subject?: string
  chapter?: string
  difficulty?: 'easy' | 'medium' | 'hard'
  tags?: string[]
}

export interface Box {
  id: string
  /** Rich content (editor HTML). */
  content?: string
  /** Second-language version of the content (bilingual papers). */
  content2?: string
  children?: Box[]
  layout?: BoxLayout
  style?: BoxStyle
  number?: BoxNumber
  marks?: BoxMarks
  /** Print "OR" between children (the student answers some of them; use marks "best" to count them). */
  choice?: boolean
  /** paper = only on the question paper; key = only in the answer key. */
  visible?: 'both' | 'paper' | 'key'
  /** Highlighted in the answer key (e.g. the correct option). */
  correct?: boolean
  /** Children print in a fixed shuffled order; the answer key keeps the original (correct) order. */
  shuffle?: boolean
  meta?: BoxMeta
  /** Name when saved in the library or used as a preset. */
  name?: string
  /** Library items: last edit time (sharing keeps the newer copy). */
  updatedAt?: number
}

// ---------- numbering ----------

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
const roman = (n: number) => ROMAN.reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '')
const letters = (n: number) => { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }

export function formatNumber(n: number, f: NumberFormat) {
  switch (f) {
    case 'a': return letters(n)
    case 'A': return letters(n).toUpperCase()
    case 'i': return roman(n)
    case 'I': return roman(n).toUpperCase()
    default: return String(n)
  }
}

export const numberLabel = (num: BoxNumber, n: number) => num.pattern.replace('{n}', formatNumber(n, num.format))

/** Which boxes are shown in this view (paper or answer key). */
export const shownIn = (b: Box, key: boolean) => (b.visible ?? 'both') === 'both' || (b.visible === 'key') === key

/** Children in print order: shuffled boxes keep a stable shuffled order on the paper, original order in the key. */
export function printOrder(b: Box, key: boolean): Box[] {
  const kids = b.children ?? []
  if (!b.shuffle || key || kids.length < 2) return kids
  let h = 2166136261
  for (let i = 0; i < b.id.length; i++) h = Math.imul(h ^ b.id.charCodeAt(i), 16777619)
  const rand = () => { h = (h + 0x6d2b79f5) | 0; let x = Math.imul(h ^ (h >>> 15), 1 | h); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }
  const order = kids.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  if (order.every((v, i) => v === i)) order.push(order.shift()!)
  return order.map((i) => kids[i])
}

/** Number labels for every numbered box in print order (paper-scope counters continue across the tree). */
export function computeNumbers(root: Box, key = false): Map<string, string> {
  const labels = new Map<string, string>()
  const global = new Map<string, number>()
  const walk = (b: Box) => {
    const local = new Map<string, number>()
    for (const c of printOrder(b, key)) {
      if (!shownIn(c, key)) continue
      if (c.number) {
        const name = c.number.counter || `${c.number.format}${c.number.scope}`
        const map = c.number.scope === 'paper' ? global : local
        const n = (map.get(name) ?? 0) + 1
        map.set(name, n)
        labels.set(c.id, numberLabel(c.number, n))
      }
      walk(c)
    }
  }
  walk(root)
  return labels
}

// ---------- marks ----------

/** What a box contributes to its parent: its own marks if set, otherwise its children's contributions. */
export function marksOf(b: Box): number {
  const kids = (b.children ?? []).filter((c) => c.visible !== 'key')
  const contributions = kids.map(marksOf)
  const m = b.marks
  if (m?.mode === 'fixed') return m.value ?? 0
  if (m?.mode === 'best') return [...contributions].sort((x, y) => y - x).slice(0, Math.max(0, m.best ?? 1)).reduce((a, c) => a + c, 0)
  return contributions.reduce((a, c) => a + c, 0)
}

/** Printed marks text, e.g. "[2]", "10 Marks", "5 × 2 = 10". */
export function marksLabel(b: Box, marksWord = 'Marks') {
  const m = b.marks
  if (!m?.show) return ''
  const total = marksOf(b)
  const kids = (b.children ?? []).filter((c) => c.visible !== 'key' && marksOf(c) > 0)
  const each = kids.length && kids.every((c) => marksOf(c) === marksOf(kids[0])) ? marksOf(kids[0]) : 0
  const k = m.mode === 'best' ? Math.min(m.best ?? 1, kids.length) : kids.length
  const pattern = m.pattern || (m.mode === 'fixed' ? '[{m}]' : `{m} ${marksWord}`)
  if (pattern.includes('{e}') && !each) return `${total} ${marksWord}`
  return pattern.replace('{m}', String(total)).replace('{k}', String(k)).replace('{e}', String(each))
}

// ---------- tree helpers ----------

export function findBox(root: Box, id: string): { box: Box; parent: Box | null; index: number } | null {
  if (root.id === id) return { box: root, parent: null, index: -1 }
  const kids = root.children ?? []
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].id === id) return { box: kids[i], parent: root, index: i }
    const f = findBox(kids[i], id)
    if (f) return f
  }
  return null
}

/** Returns a new tree with the box `id` replaced by fn(box) (null removes it). */
export function mapBox(root: Box, id: string, fn: (b: Box) => Box | Box[] | null): Box {
  if (root.id === id) {
    const r = fn(root)
    return Array.isArray(r) ? r[0] : r ?? root
  }
  if (!root.children) return root
  let changed = false
  const children = root.children.flatMap((c) => {
    if (c.id === id) {
      changed = true
      const r = fn(c)
      return r === null ? [] : Array.isArray(r) ? r : [r]
    }
    const n = mapBox(c, id, fn)
    if (n !== c) changed = true
    return [n]
  })
  return changed ? { ...root, children } : root
}

/** Inserts `box` into `parentId` at `index` (end if omitted). */
export function insertBox(root: Box, parentId: string, box: Box, index?: number): Box {
  return mapBox(root, parentId, (p) => {
    const kids = [...(p.children ?? [])]
    kids.splice(index ?? kids.length, 0, box)
    return { ...p, children: kids }
  })
}

export function moveBox(root: Box, id: string, toParent: string, index: number): Box {
  const found = findBox(root, id)
  if (!found || !found.parent || found.box.id === toParent || findBox(found.box, toParent)) return root; // can't move into itself
  let removed = mapBox(root, id, () => null)
  const adjust = found.parent.id === toParent && found.index < index ? index - 1 : index
  removed = insertBox(removed, toParent, found.box, adjust)
  return removed
}

/** Deep copy with fresh ids (copying from the library, duplicating). */
export function cloneBox(b: Box, uid: () => string): Box {
  return { ...structuredClone(b), id: uid(), children: b.children?.map((c) => cloneBox(c, uid)) }
}

export function walkBoxes(root: Box, fn: (b: Box, depth: number) => void, depth = 0) {
  fn(root, depth)
  for (const c of root.children ?? []) walkBoxes(c, fn, depth + 1)
}
