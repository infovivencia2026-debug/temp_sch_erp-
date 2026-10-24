import {
  AlignmentType, BorderStyle, Document, SectionType, HorizontalPositionAlign, HorizontalPositionRelativeFrom, ImageRun, Packer, Paragraph, Table,
  TableCell, TableRow, TabStopType, TextRun, TextWrappingSide, TextWrappingType, VerticalPositionRelativeFrom, WidthType,
  type IRunOptions, type ParagraphChild,
} from 'docx'
import { richBody } from './richdoc'
import { collectImageIds, imageBytes, imgType, type ImageAlign, type ImageAsset } from './images'
import { effectiveStyle, wordLatinFont } from './fonts'
import { paperLabels, type LabelKey } from './labels'
import { computeNumbers, marksLabel, marksOf, printOrder, shownIn, type Box } from './box'
import { optionGrid } from './grid'
import type { PaperDoc, SchoolHead } from './doc'

/* The paper as a Word file, for a school that sends its papers to a press or
   edits the last details in Word. Built from the same boxes as the printed
   sheet, so numbering, marks, OR choices and the answer key match it. */

const CONTENT_WIDTH = 9906; // A4 width (11906 twips) minus 1000 twip margins
const COLUMN_GAP = 400

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE }

/** Invisible table used to lay things out side by side (option grids, parts in columns). */
function layoutTable(cells: (Paragraph | Table)[][], cols: number, width: number, indent: number, alignment?: (typeof AlignmentType)[keyof typeof AlignmentType]) {
  const colWidth = Math.floor((width - indent) / cols)
  const rows: TableRow[] = []
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols)
    while (row.length < cols) row.push([new Paragraph({ children: [] })])
    rows.push(new TableRow({ children: row.map((children) => new TableCell({ children, width: { size: colWidth, type: WidthType.DXA }, borders: NO_BORDERS })) }))
  }
  return new Table({ rows, borders: NO_BORDERS, alignment, indent: alignment ? undefined : { size: indent, type: WidthType.DXA }, columnWidths: Array(cols).fill(colWidth), width: { size: colWidth * cols, type: WidthType.DXA } })
}
const INDENT = 560
const PX_PER_MM = 96 / 25.4

type RunOpts = Partial<IRunOptions>
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED } as const

/** A paragraph's worth of content; block images (left/center) get a paragraph of their own. */
interface Chunk {
  children: ParagraphChild[]
  align?: 'left' | 'center' | 'right' | 'justify'
  table?: Table
  /** Answer lines to draw. */
  lines?: number
  /** Horizontal rule. */
  rule?: boolean
  /** List nesting depth (extra indent). */
  extraIndent?: number
}

class DocxWriter {
  readonly size: number; // half-points
  readonly gap: number; // twips before each question
  private font: { ascii: string; hAnsi: string; eastAsia: string; cs: string }
  readonly L: (k: LabelKey) => string
  readonly bilingual: boolean
  /** Right edge for marks: the page, or one column on a 2-column page. */
  readonly width: number

  constructor(private images: Record<string, ImageAsset>, paper: PaperDoc, private imageData: Map<string, Uint8Array>) {
    const style = effectiveStyle(undefined, paper.style)
    this.size = Math.round(style.fontSize * 2)
    this.gap = Math.round(style.questionGap * 20)
    this.L = paperLabels(paper.labelLang)
    this.bilingual = !!paper.bilingual
    this.width = paper.pageCols === 2 ? Math.floor((CONTENT_WIDTH - COLUMN_GAP) / 2) : CONTENT_WIDTH
    const latin = wordLatinFont(style)
    // Word renders Devanagari/Telugu with the complex-script (cs) font. Nirmala UI ships with every Windows since 8.
    this.font = { ascii: latin, hAnsi: latin, eastAsia: latin, cs: 'Nirmala UI' }
  }

  run(text: string, opts: RunOpts = {}) {
    const size = (opts.size as number | undefined) ?? this.size
    return new TextRun({ text, font: this.font, size, sizeComplexScript: size, boldComplexScript: opts.bold, ...opts })
  }

  scaled(factor: number): RunOpts {
    const size = Math.round(this.size * factor)
    return { size, sizeComplexScript: size }
  }

  private image(asset: ImageAsset, widthMm: number, align: ImageAlign) {
    const bytes = this.imageData.get(asset.id) ?? new Uint8Array()
    const width = Math.round(Math.min(widthMm, 170) * PX_PER_MM)
    const height = Math.round((width * asset.h) / asset.w)
    const type = imgType(bytes)
    if (align !== 'right') return new ImageRun({ type, data: bytes, transformation: { width, height } })
    return new ImageRun({
      type, data: bytes, transformation: { width, height },
      floating: {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, align: HorizontalPositionAlign.RIGHT },
        verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: 0 },
        wrap: { type: TextWrappingType.SQUARE, side: TextWrappingSide.LEFT },
        margins: { left: 114300, bottom: 57150 },
      },
    })
  }

  /** Rich content → paragraph-sized chunks; tables and blocks come as tables or paragraphs of their own. */
  chunks(s: string, opts: RunOpts = {}): Chunk[] {
    if (!s) return [{ children: [] }]
    const out: Chunk[] = []
    const walkBlocks = (el: Element, depth = 0) => {
      for (const node of [...el.childNodes]) {
        if (node.nodeType === 3) {
          if (node.textContent?.trim()) out.push({ children: this.inline(node, opts) })
          continue
        }
        if (node.nodeType !== 1) continue
        const n = node as Element
        switch (n.tagName) {
          case 'P': {
            const align = /text-align:\s*(\w+)/.exec(n.getAttribute('style') ?? '')?.[1]
            out.push({ children: this.inline(n, opts), align: align as Chunk['align'], extraIndent: depth })
            break
          }
          case 'UL':
          case 'OL': {
            let k = Number(n.getAttribute('start')) || 1
            for (const li of [...n.children].filter((c) => c.tagName === 'LI')) {
              const bullet = n.tagName === 'UL' ? '•' : `${k++}.`
              const first = out.length
              walkBlocks(li, depth + 1)
              const target = out[first]
              if (target && !target.table) target.children.unshift(this.run(`${bullet}\t`, opts))
              else out.splice(first, 0, { children: [this.run(bullet, opts)], extraIndent: depth + 1 })
            }
            break
          }
          case 'TABLE':
            out.push({ children: [], table: this.table(n, opts) })
            break
          case 'DIV':
            if (n.hasAttribute('data-lines')) out.push({ children: [], lines: Math.min(Number(n.getAttribute('data-lines')) || 1, 60) })
            else if (n.hasAttribute('data-box')) out.push({ children: [], table: this.box(Number(n.getAttribute('data-box')) || 40) })
            else walkBlocks(n, depth)
            break
          case 'HR':
            out.push({ children: [], rule: true })
            break
          default:
            out.push({ children: this.inline(n, opts) })
        }
      }
    }
    walkBlocks(richBody(s))
    return out.length ? out : [{ children: [] }]
  }

  /** Inline content with formatting marks, line breaks and pictures. */
  private inline(node: Node, opts: RunOpts): ParagraphChild[] {
    const runs: ParagraphChild[] = []
    const walk = (n: Node, o: RunOpts) => {
      if (n.nodeType === 3) {
        if (n.textContent) runs.push(this.run(n.textContent, o))
        return
      }
      if (n.nodeType !== 1) return
      const el = n as Element
      const t = el.tagName
      if (t === 'BR') return void runs.push(this.run('', { ...o, break: 1 }))
      if (t === 'IMG') {
        const a = this.images[el.getAttribute('data-id') ?? '']
        if (a && this.imageData.has(a.id)) runs.push(this.image(a, Number(el.getAttribute('data-width')) || 30, (el.getAttribute('data-align') ?? 'inline') as ImageAlign))
        return
      }
      const next: RunOpts = { ...o }
      if (t === 'STRONG') Object.assign(next, { bold: true })
      if (t === 'EM') Object.assign(next, { italics: true })
      if (t === 'U') Object.assign(next, { underline: {} })
      if (t === 'S') Object.assign(next, { strike: true })
      if (t === 'SUB') Object.assign(next, { subScript: true })
      if (t === 'SUP') Object.assign(next, { superScript: true })
      el.childNodes.forEach((c) => walk(c, next))
    }
    if (node.nodeType === 3) walk(node, opts)
    else node.childNodes.forEach((c) => walk(c, opts))
    return runs
  }

  /** Editor table → Word table (merged cells, header row, borders on/off). */
  private table(el: Element, opts: RunOpts): Table {
    const borderless = el.getAttribute('data-borderless') === 'true'
    const rows = [...el.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr')]
    const cols = Math.max(1, ...rows.map((r) => [...r.children].reduce((n, c) => n + (Number(c.getAttribute('colspan')) || 1), 0)))
    const total = this.width - INDENT
    // Column widths dragged in the editor (px, from the first row's colwidth); else equal columns.
    // Any row may carry a column's width (a merged header row often doesn't), so take the first found.
    const dragged: number[] = Array(cols).fill(0)
    for (const tr of rows) {
      let col = 0
      for (const cell of [...tr.children]) {
        const span = Number(cell.getAttribute('colspan')) || 1
        const w = (cell.getAttribute('colwidth') ?? '').split(',').map(Number)
        for (let k = 0; k < span && col + k < cols; k++) if (!dragged[col + k] && w[k] > 0) dragged[col + k] = w[k]
        col += span
      }
    }
    const known = dragged.some((x) => x > 0)
    if (known) {
      // Columns never dragged share what's left equally, like the editor shows them.
      const set = dragged.filter((x) => x > 0)
      const avg = set.reduce((a, b) => a + b, 0) / set.length
      for (let k = 0; k < cols; k++) if (!dragged[k]) dragged[k] = avg
    }
    const scale = known ? Math.min(15, total / dragged.reduce((a, b) => a + b, 0)) : 0; // 1 px ≈ 15 twips
    const widths = known ? dragged.map((px) => Math.round(px * scale)) : Array(cols).fill(Math.floor(total / cols))
    const colWidth = Math.floor(total / cols)
    const line = { style: BorderStyle.SINGLE, size: 4, color: '000000' }
    const borders = borderless ? NO_BORDERS : { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line }
    return new Table({
      borders,
      indent: { size: INDENT, type: WidthType.DXA },
      columnWidths: widths,
      width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      rows: rows.map((tr) => new TableRow({
        tableHeader: [...tr.children].some((c) => c.tagName === 'TH'),
        children: [...tr.children].map((cell) => {
          const span = Number(cell.getAttribute('colspan')) || 1
          const start = [...tr.children].slice(0, [...tr.children].indexOf(cell)).reduce((n, c) => n + (Number(c.getAttribute('colspan')) || 1), 0)
          const cellWidth = widths.slice(start, start + span).reduce((a, b) => a + b, 0) || colWidth * span
          const isHead = cell.tagName === 'TH'
          const inner = this.toBlocks(this.chunks(cell.innerHTML || '<p></p>', isHead ? { ...opts, bold: true } : opts), 0)
          return new TableCell({
            children: inner.length ? inner : [new Paragraph({ children: [] })],
            columnSpan: span > 1 ? span : undefined,
            rowSpan: Number(cell.getAttribute('rowspan')) > 1 ? Number(cell.getAttribute('rowspan')) : undefined,
            width: { size: cellWidth, type: WidthType.DXA },
            borders: borderless ? NO_BORDERS : undefined,
            shading: isHead && !borderless ? { fill: 'F2F2F2', type: 'clear', color: 'auto' } : undefined,
          })
        }),
      })),
    })
  }

  /** Empty bordered box of a given height (mm) for drawings. */
  private box(heightMm: number): Table {
    const line = { style: BorderStyle.SINGLE, size: 6, color: '000000' }
    const width = this.width - INDENT
    return new Table({
      indent: { size: INDENT, type: WidthType.DXA },
      columnWidths: [width],
      width: { size: width, type: WidthType.DXA },
      rows: [new TableRow({ height: { value: Math.round(Math.min(heightMm, 250) * 56.7), rule: 'exact' }, children: [new TableCell({ children: [new Paragraph({ children: [] })], borders: { top: line, bottom: line, left: line, right: line } })] })],
    })
  }


  para(children: ParagraphChild[], extra: Record<string, unknown> = {}) {
    return new Paragraph({ children, spacing: { after: 60 }, ...extra })
  }

  /** Paragraphs and tables for chunks, indented to `left`. */
  toBlocks(chunks: Chunk[], left = INDENT, extra: Record<string, unknown> = {}): (Paragraph | Table)[] {
    return chunks.flatMap((c): (Paragraph | Table)[] => {
      if (c.table) return [c.table]
      if (c.rule) return [new Paragraph({ children: [], indent: { left }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } } })]
      if (c.lines)
        return Array.from({ length: c.lines }, () => new Paragraph({ children: [this.run('')], indent: { left }, spacing: { before: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999', space: 1 } } }))
      const ind = left + (c.extraIndent ?? 0) * 360
      return [this.para(c.children, { indent: c.extraIndent ? { left: ind, hanging: 280 } : { left }, tabStops: c.extraIndent ? [{ type: TabStopType.LEFT, position: ind }] : undefined, alignment: c.align && ALIGN[c.align], ...extra })]
    })
  }


}


/** Content that can't share the question-number line: tables, lines, rules, non-left paragraphs. */
const ownLine = (c: Chunk) => !!(c.table || c.lines || c.rule || (c.align && c.align !== 'left'))

/** One Box (and everything inside it) as Word paragraphs and tables. */
function boxBlocks(w: DocxWriter, b: Box, ctx: { labels: Map<string, string>; key: boolean; marksWord: string }, left: number, right: number): (Paragraph | Table)[] {
  if (!shownIn(b, ctx.key)) return []
  const st = b.style ?? {}
  const opts: RunOpts = {
    ...(st.bold ? { bold: true } : {}),
    ...(st.italic ? { italics: true } : {}),
    ...(st.scale && st.scale !== 1 ? w.scaled(st.scale) : {}),
    ...(ctx.key && b.correct ? { bold: true, underline: {} } : {}),
  }
  const num = ctx.labels.get(b.id) ?? ''
  const marks = marksLabel(b, ctx.marksWord)
  const hang = num ? INDENT : 0
  const textLeft = left + hang
  const chunks = b.content ? w.chunks(b.content, opts) : []
  if (w.bilingual && b.content2) chunks.push(...w.chunks(b.content2, opts))
  let kids = printOrder(b, ctx.key).filter((c) => shownIn(c, ctx.key))
  // A numbered box without text of its own takes its first plain text box onto the number line.
  if ((num || marks) && !chunks.length && kids[0]?.content && !kids[0].number && !kids[0].marks && !kids[0].style?.rule && !kids[0].style?.border && !kids[0].children?.length) {
    chunks.push(...w.chunks(kids[0].content, opts))
    if (w.bilingual && kids[0].content2) chunks.push(...w.chunks(kids[0].content2, opts))
    kids = kids.slice(1)
  }
  const out: (Paragraph | Table)[] = []
  const before = st.spaceBefore ? st.spaceBefore * 20 : b.number?.scope === 'paper' ? w.gap : 40
  const align = st.align ? ALIGN[st.align] : undefined

  // First line: number, first paragraph of the content, marks on the right — like the printed paper.
  const first = chunks[0] && !ownLine(chunks[0]) ? chunks.shift()! : null
  if (num || marks || first || st.rule || st.pageBreak) {
    const runs: ParagraphChild[] = []
    if (num) runs.push(w.run(num, { bold: !b.number || b.number.scope === 'paper', ...opts }), w.run('\t'))
    if (first) runs.push(...first.children)
    if (marks) runs.push(w.run('\t'), w.run(marks, { bold: true }))
    out.push(w.para(runs, {
      indent: num ? { left: textLeft, hanging: hang } : { left },
      spacing: { before, after: 40 },
      alignment: !num && !marks ? align ?? (first?.align && ALIGN[first.align]) : undefined,
      pageBreakBefore: st.pageBreak || undefined,
      keepNext: st.rule || undefined,
      tabStops: [...(num ? [{ type: TabStopType.LEFT, position: textLeft }] : []), { type: TabStopType.RIGHT, position: right }],
      border: st.rule ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } } : undefined,
    }))
  }
  out.push(...w.toBlocks(chunks, st.rule ? left : textLeft, align ? { alignment: align } : {}))

  // Children: stacked, side by side (invisible table), or as a choice with OR between them.
  const childLeft = st.rule ? left : textLeft
  if (b.layout?.mode === 'grid' && kids.length) {
    const g = optionGrid(kids.length, b.layout.cols || kids.length, b.layout.order ?? 'across')
    const cellW = Math.floor((right - childLeft) / g.cols)
    const cells = g.cells.map((i) => {
      const inner = i === null ? [] : boxBlocks(w, kids[i], ctx, 0, cellW - 120)
      return inner.length ? inner : [new Paragraph({ children: [] })]
    })
    out.push(layoutTable(cells, g.cols, right, childLeft))
  } else {
    kids.forEach((c, i) => {
      if (b.choice && i) out.push(w.para([w.run(w.L('or'), { bold: true })], { alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 } }))
      out.push(...boxBlocks(w, c, ctx, childLeft, right))
    })
  }

  if (!st.border) return out
  // A bordered box is a one-cell table around its content.
  const line = { style: BorderStyle.SINGLE, size: 6, color: '000000' }
  const width = right - left
  return [new Table({
    indent: { size: left, type: WidthType.DXA },
    columnWidths: [width],
    width: { size: width, type: WidthType.DXA },
    rows: [new TableRow({ children: [new TableCell({ children: out.length ? out : [new Paragraph({ children: [] })], borders: { top: line, bottom: line, left: line, right: line }, margins: { top: 60, bottom: 60, left: 100, right: 100 } })] })],
  })]
}
/** The school's logo for the letterhead, 60 px tall, or nothing when it cannot be read. */
async function logoRun(fileId: string) {
  const bytes = await imageBytes({ id: fileId })
  const url = URL.createObjectURL(new Blob([bytes.slice()]))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const h = 60
    const w = Math.round((img.naturalWidth / img.naturalHeight) * h) || h
    return new ImageRun({ type: imgType(bytes), data: bytes, transformation: { width: w, height: h } })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function renderPaperDocx(paper: PaperDoc, school: SchoolHead, answerKey: boolean): Promise<Uint8Array> {
  // Word needs the picture bytes up front; read every picture this paper uses once.
  const imageData = new Map<string, Uint8Array>()
  for (const id of collectImageIds(paper.body)) {
    if (paper.images[id]) imageData.set(id, await imageBytes({ id }).catch(() => new Uint8Array()))
  }
  const w = new DocxWriter(paper.images, paper, imageData)
  const totalMarks = marksOf(paper.body)
  const center = (children: ParagraphChild[]) => w.para(children, { alignment: AlignmentType.CENTER })
  const spread = (left: string, right: string) =>
    w.para([w.run(left, { bold: true }), w.run('\t'), w.run(right, { bold: true })], { tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }] })

  const logo = school.logo ? await logoRun(school.logo).catch(() => null) : null
  const header: (Paragraph | Table)[] = []
  if (logo) header.push(center([logo]))
  if (school.name) header.push(center([w.run(school.name, { bold: true, ...w.scaled(1.33) })]))
  if (school.address) header.push(center([w.run(school.address, w.scaled(0.83))]))
  header.push(
    w.para([w.run(paper.examName + (answerKey ? ` — ${w.L('answerKey')}` : ''), { bold: true, ...w.scaled(1.08) })], {
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '000000', space: 4 } },
    }),
    spread(`${w.L('class')}: ${paper.className}`, `${w.L('subject')}: ${paper.subject}`),
    spread(`${w.L('time')}: ${paper.duration}${paper.date ? `    ${w.L('date')}: ${paper.date}` : ''}`, `${w.L('maxMarks')}: ${totalMarks}`),
  )
  // The header spans the page; the boxes go in a second section that may have two columns.
  const ctx = { labels: computeNumbers(paper.body, answerKey), key: answerKey, marksWord: w.L('marks') }
  const body: (Paragraph | Table)[] = (paper.body.children ?? []).flatMap((b) => boxBlocks(w, b, ctx, 0, w.width))
  body.push(center([w.run(w.L('end'), { bold: true })]))

  const style = effectiveStyle(undefined, paper.style)
  const page = { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } }
  const doc = new Document({
    creator: school.name,
    title: paper.examName,
    styles: { default: { document: { paragraph: { spacing: { line: Math.round(240 * style.lineHeight / 1.15) } } } } },
    sections: [
      { properties: { page }, children: header },
      {
        properties: { page, type: SectionType.CONTINUOUS, column: paper.pageCols === 2 ? { count: 2, space: COLUMN_GAP, separate: true, equalWidth: true } : { count: 1 } },
        children: body,
      },
    ],
  })
  const blob = await Packer.toBlob(doc)
  return new Uint8Array(await blob.arrayBuffer())
}
