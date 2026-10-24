import { esc } from './util'
import { imgSrc, type ImageAsset } from './images'

/* Rich content (questions, options, answers, instructions) is stored as a
   small, safe subset of HTML produced by the editor: paragraphs, bold, italic,
   underline, strike, sub- and superscript, lists, tables, pictures (by file
   id), answer lines and drawing boxes. Plain text (a question banked from the
   form, before Question maker) becomes one paragraph per line. */

export const isHtml = (s: string) => s.trimStart().startsWith('<')

/** Plain text, one paragraph per line. */
export const textToHtml = (s: string) => (s ? s.split('\n').map((l) => `<p>${esc(l)}</p>`).join('') : '')

export const toHtml = (s: string) => (isHtml(s) ? s : textToHtml(s))

// ---------- sanitising ----------

const ALLOWED: Record<string, string[]> = {
  P: ['style'], BR: [], STRONG: [], B: [], EM: [], I: [], U: [], S: [], SUB: [], SUP: [],
  UL: [], OL: ['start'], LI: [],
  TABLE: ['data-borderless', 'style'], TBODY: [], THEAD: [], TR: [], TD: ['colspan', 'rowspan', 'colwidth', 'style'], TH: ['colspan', 'rowspan', 'colwidth', 'style'],
  COLGROUP: [], COL: ['style'],
  IMG: ['data-id', 'data-width', 'data-align'],
  DIV: ['data-lines', 'data-box'],
  HR: [],
}
const RENAME: Record<string, string> = { B: 'STRONG', I: 'EM' }

/** Keeps only the tags and attributes the editor produces; anything else is unwrapped or dropped. */
function sanitizeNode(node: Node, doc: Document): Node[] {
  if (node.nodeType === 3) return [doc.createTextNode(node.textContent ?? '')]
  if (node.nodeType !== 1) return []
  const el = node as Element
  const tag = el.tagName.toUpperCase()
  if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META'].includes(tag)) return []
  const kids = [...el.childNodes].flatMap((c) => sanitizeNode(c, doc))
  const allowed = ALLOWED[tag]
  if (!allowed || (tag === 'DIV' && !el.hasAttribute('data-lines') && !el.hasAttribute('data-box'))) return kids
  const out = doc.createElement(RENAME[tag] ?? tag)
  for (const a of allowed) {
    const v = el.getAttribute(a)
    if (v == null) continue
    if (a === 'style') {
      // Only alignment (paragraphs) and widths or vertical alignment (cells) survive.
      const keep = v.split(';').map((x) => x.trim()).filter((x) => /^(text-align|vertical-align|width)\s*:\s*[a-z0-9.%\s-]+$/i.test(x))
      if (keep.length) out.setAttribute('style', keep.join('; '))
    } else out.setAttribute(a, v.replace(/[^\w\s.,%-]/g, ''))
  }
  kids.forEach((k) => out.appendChild(k))
  return [out]
}

/** Parses stored content into a clean body element. */
export function richBody(s: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<body>${toHtml(s)}</body>`, 'text/html')
  const clean = doc.createElement('body')
  ;[...doc.body.childNodes].flatMap((n) => sanitizeNode(n, doc)).forEach((n) => clean.appendChild(n))
  return clean
}

export const sanitizeRich = (s: string) => (s ? richBody(s).innerHTML : '')

// ---------- print HTML ----------

/** Stored content to HTML for the printed paper: picture sources resolved, lines drawn, tables classed. */
export function renderRich(s: string, images: Record<string, ImageAsset>): string {
  if (!s) return ''
  const body = richBody(s)
  body.querySelectorAll('img[data-id]').forEach((img) => {
    const id = img.getAttribute('data-id') ?? ''
    if (!images[id]) return img.remove()
    img.setAttribute('src', imgSrc({ id }))
    img.setAttribute('class', `qi al-${img.getAttribute('data-align') ?? 'inline'}`)
    img.setAttribute('style', `width:${Number(img.getAttribute('data-width')) || 30}mm`)
  })
  body.querySelectorAll('div[data-lines]').forEach((d) => {
    const n = Math.min(Number(d.getAttribute('data-lines')) || 0, 60)
    d.setAttribute('class', 'lines')
    d.innerHTML = '<div></div>'.repeat(n)
  })
  body.querySelectorAll('div[data-box]').forEach((d) => {
    d.setAttribute('class', 'drawbox')
    d.setAttribute('style', `height:${Math.min(Number(d.getAttribute('data-box')) || 40, 250)}mm`)
  })
  body.querySelectorAll('table').forEach((t) => t.setAttribute('class', t.getAttribute('data-borderless') === 'true' ? 'rt borderless' : 'rt'))
  // Empty paragraphs would collapse; keep them as blank lines, as the editor shows them.
  body.querySelectorAll('p').forEach((p) => {
    if (!p.childNodes.length) p.innerHTML = '<br>'
  })
  return body.innerHTML
}

/** Like renderRich, but a lone paragraph comes back unwrapped so it can follow "(a) " on the same line. */
export function renderRichInline(s: string, images: Record<string, ImageAsset>): string {
  const html = renderRich(s, images)
  const m = /^<p(?: style="[^"]*")?>([\s\S]*?)<\/p>$/.exec(html)
  return m && !m[1].includes('<p') ? m[1] : html
}

// ---------- queries ----------

const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** One-line text for lists, summaries and the bank's searchable stem. A picture reads as [picture]. */
export function richPlain(s: string): string {
  if (!isHtml(s)) return s.replace(/\s+/g, ' ').trim()
  return decode(s.replace(/<img[^>]*>/g, ' [picture] ').replace(/<\/(p|li|tr|td|th)>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

export const richHasImage = (s: string) => /<img\b/.test(s)
