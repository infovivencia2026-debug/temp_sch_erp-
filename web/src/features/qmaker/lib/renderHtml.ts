import { marksOf } from './box'
import { BOX_CSS, renderBody } from './renderBox'
import { effectiveStyle, styleVars } from './fonts'
import { paperLabels } from './labels'
import { esc } from './util'
import type { PaperDoc, SchoolHead } from './doc'

/* The printed paper. Black on white whatever the app's theme, because it is
   ink on A4: every size relates to --fs (the body size), so the font-size
   setting scales the whole sheet. */
export const PAPER_CSS = `
.qp { --fs: 12pt; --lh: 1.45; --gap: 6pt; font-size: var(--fs); line-height: var(--lh); color: #000; background: #fff; }
.qp * { box-sizing: border-box; }
.qp .hd { text-align: center; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
.qp .hd-top { display: flex; align-items: center; justify-content: center; gap: 12px; }
.qp .hd img { max-height: 60px; max-width: 80px; }
.qp .inst { font-size: calc(var(--fs) * 1.33); font-weight: 700; }
.qp .addr { font-size: calc(var(--fs) * 0.83); }
.qp .exam { font-size: calc(var(--fs) * 1.08); font-weight: 700; margin-top: 4px; }
.qp .meta { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; margin: 2px 0; }
.qp .cols2 { column-count: 2; column-gap: 8mm; column-rule: 1px solid #999; }
.qp .lines { clear: both; }
.qp .lines div { border-bottom: 1px solid #999; height: calc(var(--fs) * 2.1); }
.qp p { margin: 0; }
.qp ul, .qp ol { margin: 2pt 0; padding-left: 1.6em; }
.qp table.rt { border-collapse: collapse; margin: 4pt 0; width: 100%; table-layout: fixed; }
.qp table.rt td, .qp table.rt th { border: 1px solid #000; padding: 2pt 6pt; vertical-align: top; }
.qp table.rt th { font-weight: 700; background: #f2f2f2; }
.qp table.rt.borderless td, .qp table.rt.borderless th { border: 0; background: none; padding: 1pt 4pt; }
.qp .drawbox { border: 1px solid #000; margin: 4pt 0; }
.qp hr { border: 0; border-top: 1px solid #000; margin: 4pt 0; }
${BOX_CSS}
.qp .end { text-align: center; margin-top: 18px; font-weight: 600; clear: both; }
.qp img.qi { max-width: 100%; height: auto; }
.qp img.qi.al-inline { display: inline-block; vertical-align: middle; margin: 0 2px; }
.qp img.qi.al-left { display: block; margin: 4px 0; }
.qp img.qi.al-center { display: block; margin: 4px auto; }
.qp img.qi.al-right { float: right; margin: 2px 0 4px 10px; }
`

export function paperHeaderHtml(doc: PaperDoc, school: SchoolHead, answerKey: boolean, totalMarks: number) {
  const L = paperLabels(doc.labelLang)
  return `
    <div class="hd">
      <div class="hd-top">
        ${school.logo ? `<img src="/api/v1/files/${esc(school.logo)}?inline=1" alt="" />` : ''}
        <div>
          ${school.name ? `<div class="inst">${esc(school.name)}</div>` : ''}
          ${school.address ? `<div class="addr">${esc(school.address)}</div>` : ''}
        </div>
      </div>
      <div class="exam">${esc(doc.examName)}${answerKey ? ` — ${L('answerKey')}` : ''}</div>
    </div>
    <div class="meta"><span>${L('class')}: ${esc(doc.className)}</span><span>${L('subject')}: ${esc(doc.subject)}</span></div>
    <div class="meta"><span>${L('time')}: ${esc(doc.duration)}</span>${doc.date ? `<span>${L('date')}: ${esc(doc.date)}</span>` : ''}<span>${L('maxMarks')}: ${totalMarks}</span></div>`
}

export function renderPaperHtml(doc: PaperDoc, school: SchoolHead, answerKey: boolean) {
  const L = paperLabels(doc.labelLang)
  const style = effectiveStyle(undefined, doc.style)
  const content = renderBody(doc.body, { images: doc.images, answerKey, bilingual: !!doc.bilingual, L })
  const body = doc.pageCols === 2 ? `<div class="cols2">${content}</div>` : content
  return `<div class="qp" style="${styleVars(style)}">${paperHeaderHtml(doc, school, answerKey, marksOf(doc.body))}${body}<div class="end">${L('end')}</div></div>`
}

/* The paper as a page of its own, with the app's styles (so the paper fonts
   come along): what is printed, and what a preview frame shows. */
export function paperDocumentHtml(doc: PaperDoc, school: SchoolHead, answerKey: boolean, padding = '0') {
  const styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.outerHTML).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.examName || 'Question paper')}</title>${styles}
    <style>${PAPER_CSS}@page{size:A4;margin:14mm}html,body{background:#fff!important;background-image:none!important;margin:0;color-scheme:light}body::before,body::after{display:none!important}body{padding:${padding}}</style></head>
    <body>${renderPaperHtml(doc, school, answerKey)}</body></html>`
}

/* Printing, which is also how a PDF is made: the browser's own dialog offers
   "Save as PDF". The page goes into a hidden frame, waits for its fonts and
   pictures, then prints. */
export async function printPaper(doc: PaperDoc, school: SchoolHead, answerKey: boolean) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  const w = frame.contentWindow!
  const d = w.document
  d.open()
  d.write(paperDocumentHtml(doc, school, answerKey))
  d.close()
  await d.fonts?.ready
  await Promise.all([...d.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r }))))
  w.focus()
  w.print()
  setTimeout(() => frame.remove(), 60_000)
}
