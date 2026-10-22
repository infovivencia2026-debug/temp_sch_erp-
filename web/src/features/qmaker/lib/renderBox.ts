import type { ImageAsset } from './images'
import { computeNumbers, marksLabel, printOrder, shownIn, type Box } from './box'
import { optionGrid } from './grid'
import { renderRich, renderRichInline } from './richdoc'

export interface BoxRenderCtx {
  images: Record<string, ImageAsset>
  answerKey: boolean
  bilingual: boolean
  L: (k: 'or' | 'marks') => string
}

/** CSS for boxes; sizes relate to the paper's --fs like the rest of PAPER_CSS. */
export const BOX_CSS = `
.qp .bx { break-inside: auto; min-width: 0; }
.qp .bx .bb, .qp .bx .bc, .qp .bgrid > * { min-width: 0; overflow-wrap: break-word; }
.qp .bx.numbered > .qn { white-space: nowrap; }
/* Keep a question with its options when a page or column breaks (long ones still split). */
.qp .bx.numbered { break-inside: avoid; }
.qp .bx.numbered, .qp .bx.marked { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 0 6px; }
.qp .bx.numbered > .qn { min-width: 1.6em; font-weight: 600; }
.qp .bx > .qm { font-weight: 600; white-space: nowrap; }
.qp .bx.heading > .bh { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #000; margin-bottom: 4px; align-items: baseline; }
.qp .bx.bordered { border: 1px solid #000; }
.qp .bgrid { display: grid; gap: var(--bgap, 2px 12px); }
.qp .bx.ok > .bb, .qp .bx.ok > .bc { font-weight: 700; text-decoration: underline; }
.qp .bx .c2 { margin-top: 1pt; }
.qp .or { text-align: center; font-weight: 700; margin: 2pt 0; }
.qp .bx.pb { break-before: page; }
.qp .bx .bc > p:first-child { margin-top: 0; }
`

/** Text style of the box's own content (not inherited by its children). */
function textStyle(b: Box) {
  const s = b.style ?? {}
  const css: string[] = []
  if (s.align) css.push(`text-align:${s.align}`)
  if (s.bold) css.push('font-weight:700')
  if (s.italic) css.push('font-style:italic')
  if (s.scale && s.scale !== 1) css.push(`font-size:calc(var(--fs) * ${s.scale})`)
  return css.length ? ` style="${css.join(';')}"` : ''
}

/** Box-level spacing and padding. */
function styleAttr(b: Box) {
  const s = b.style ?? {}
  const css: string[] = []
  if (s.paddingMm) css.push(`padding:${s.paddingMm}mm`)
  if (s.spaceBefore) css.push(`margin-top:${s.spaceBefore}pt`)
  else if (b.number?.scope === 'paper') css.push('margin-top:var(--gap)')
  return css.length ? ` style="${css.join(';')}"` : ''
}

function childrenHtml(b: Box, ctx: BoxRenderCtx, labels: Map<string, string>): string {
  const kids = printOrder(b, ctx.answerKey).filter((c) => shownIn(c, ctx.answerKey))
  if (!kids.length) return ''
  const rendered = kids.map((c) => boxHtml(c, ctx, labels))
  if (b.choice) return rendered.join(`<div class="or">${ctx.L('or')}</div>`)
  const layout = b.layout
  if (layout?.mode !== 'grid') return rendered.join('')
  const g = optionGrid(kids.length, layout.cols || kids.length, layout.order ?? 'across')
  const widths = layout.widths?.length === g.cols ? layout.widths.map((w) => `minmax(0, ${w}fr)`).join(' ') : `repeat(${g.cols}, minmax(0, 1fr))`
  const gap = layout.gapMm != null ? `;--bgap:${layout.gapMm}mm` : ''
  return `<div class="bgrid" style="grid-template-columns:${widths}${gap}">${g.cells.map((i) => (i === null ? '<div></div>' : rendered[i])).join('')}</div>`
}

/** One box as printed HTML (recursive). */
export function boxHtml(b: Box, ctx: BoxRenderCtx, labels: Map<string, string>): string {
  if (!shownIn(b, ctx.answerKey)) return ''
  const num = labels.get(b.id) ?? ''
  const marks = marksLabel(b, ctx.L('marks'))
  const hasKids = !!b.children?.length
  // Content next to a number prints inline when it is a single paragraph, like "(a) Plane".
  const content = b.content ? (num && !hasKids ? renderRichInline(b.content, ctx.images) : renderRich(b.content, ctx.images)) : ''
  const content2 = ctx.bilingual && b.content2 ? `<div class="c2">${renderRich(b.content2, ctx.images)}</div>` : ''
  const kids = childrenHtml(b, ctx, labels)
  const cls = ['bx', b.style?.border && 'bordered', ctx.answerKey && b.correct && 'ok', b.style?.pageBreak && 'pb'].filter(Boolean)

  if (b.style?.rule) {
    // Heading: content and marks share a ruled line; children follow full width.
    return `<div class="${[...cls, 'heading'].join(' ')}"${styleAttr(b)}><div class="bh"${textStyle(b)}><span>${num ? `${num} ` : ''}${content}</span><span>${marks}</span></div>${content2}${kids}</div>`
  }
  const body = `${content ? `<div class="bc"${textStyle(b)}>${content}</div>` : ''}${content2}${kids}`
  if (num || marks) {
    cls.push(num ? 'numbered' : 'marked')
    return `<div class="${cls.join(' ')}"${styleAttr(b)}><div class="qn">${num}</div><div class="bb">${body}</div><div class="qm">${marks}</div></div>`
  }
  return `<div class="${cls.join(' ')}"${styleAttr(b)}>${body}</div>`
}

export function renderBody(root: Box, ctx: BoxRenderCtx) {
  const labels = computeNumbers(root, ctx.answerKey)
  return childrenHtml(root, ctx, labels)
}
