import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { Env } from '../env'
import { getObject } from './files'
import { DOC_SANS_BOLD, DOC_SANS_REGULAR } from './doc-fonts'

/* THE SCHOOL'S DOCUMENT DESIGN, SERVER SIDE.

   One look for every document the Worker produces -- the PDFs it draws with
   pdf-lib and the printable HTML it hands the report-card viewer -- and the
   same look the web's print sheet gives a screen (web/src/lib/print.ts,
   web/src/components/print-sheet.css):

     - the school's logo, its name as it brands itself, its tagline, and one
       line of address and contact, over a rule in the school's own colour;
     - the document's title with an accent bar, its number and date against
       the right margin;
     - tables with a tinted head and hairline rules, the head repeated on
       every page a table runs onto;
     - a foot on every page: the school and the document number on the left,
       "Page x of y" on the right, the date it was generated in the middle;
     - A4, 16mm margins, text wrapped inside its cell, never clipped.

   Nothing in it names the product. A school with no logo prints its name
   alone; a school that has entered no address prints no empty line for one.

   Type is Noto Sans, subset to Latin and the rupee sign and embedded
   (doc-fonts.ts). The PDF standard fonts have no ₹, which is why amounts
   used to come out as "Rs". Scripts outside that subset -- Telugu among
   them -- are not drawn: pdf-lib does not shape Indic text, and a
   half-shaped word is worse than none, so such characters are dropped from
   PDFs (never from the printable HTML, which the browser shapes). */

export interface SchoolFacts {
  name: string
  tagline?: string
  logoKey?: string
  /** The brand colour, made readable on white (readableAccent). */
  accent: string
  address?: string
  phone?: string
  email?: string
  affiliation?: string
}

/** The school's colour as the document's accent, or a dark slate when there
 *  is none or it is too pale to read as a rule and a heading on white. */
export function readableAccent(hex: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex ?? '').trim())
  if (!m) return '#1f2937'
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return 1.05 / (lum + 0.05) >= 3 ? '#' + h.toLowerCase() : '#1f2937'
}

/** Address, contact and affiliation for a letterhead. Every field optional. */
export async function letterheadFacts(db: D1Database, instId: string): Promise<{ address?: string; phone?: string; email?: string; affiliation?: string }> {
  try {
    const [c, i] = await Promise.all([
      db.prepare(`SELECT address_line1, address_line2, city, state, pincode, phone, email FROM campuses
                   WHERE status = 'active' ORDER BY created_at LIMIT 1`)
        .first<{ address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; pincode: string | null; phone: string | null; email: string | null }>(),
      db.prepare('SELECT affiliation_board, affiliation_no, udise_code FROM institutions WHERE id = ?').bind(instId)
        .first<{ affiliation_board: string | null; affiliation_no: string | null; udise_code: string | null }>(),
    ])
    const t = (v: string | null | undefined) => (v ?? '').trim()
    const cityLine = ([t(c?.city), t(c?.state)].filter(Boolean).join(', ') + (t(c?.pincode) ? ' ' + t(c?.pincode) : '')).trim()
    const address = [t(c?.address_line1), t(c?.address_line2), cityLine].filter(Boolean).join(', ')
    const aff = t(i?.affiliation_no)
      ? `${t(i?.affiliation_board) ? t(i?.affiliation_board).toUpperCase() + ' ' : ''}Affiliation No. ${t(i?.affiliation_no)}`
      : t(i?.udise_code) ? `UDISE ${t(i?.udise_code)}` : ''
    return { address: address || undefined, phone: t(c?.phone) || undefined, email: t(c?.email) || undefined, affiliation: aff || undefined }
  } catch { return {} }
}

/** Everything a school's letterhead carries, from its branding profile, its
 *  main campus and its own row, falling back to the CONTROL row's name,
 *  colour and logo. */
export async function schoolFacts(db: D1Database, inst: { id: string; name: string; primary_color?: string | null; logo_key?: string | null; tagline?: string | null }): Promise<SchoolFacts> {
  const b = await db.prepare(`SELECT display_name, tagline, logo_key, primary_color, support_email, support_phone
      FROM branding_profiles WHERE campus_id IS NULL LIMIT 1`)
    .first<{ display_name: string | null; tagline: string | null; logo_key: string | null; primary_color: string | null; support_email: string | null; support_phone: string | null }>()
    .catch(() => null)
  const lh = await letterheadFacts(db, inst.id)
  const t = (v: string | null | undefined) => (v ?? '').trim() || undefined
  return {
    name: t(b?.display_name) ?? inst.name,
    tagline: t(b?.tagline) ?? t(inst.tagline),
    logoKey: t(b?.logo_key) ?? t(inst.logo_key),
    accent: readableAccent(t(b?.primary_color) ?? inst.primary_color),
    address: lh.address,
    phone: t(b?.support_phone) ?? lh.phone,
    email: t(b?.support_email) ?? lh.email,
    affiliation: lh.affiliation,
  }
}

/** The logo's bytes, for a PDF. Null when there is none, it cannot be
 *  found, or it is not a PNG or JPEG (the two formats a PDF embeds). */
export async function logoBytes(env: Env, db: D1Database, fileId: string | undefined): Promise<Uint8Array | null> {
  if (!fileId) return null
  try {
    const f = await db.prepare('SELECT object_key FROM files WHERE id = ? AND deleted_at IS NULL').bind(fileId).first<{ object_key: string }>()
    if (!f) return null
    const obj = await getObject(env, f.object_key)
    if (!obj) return null
    const bytes = new Uint8Array(await obj.arrayBuffer())
    return isPng(bytes) || isJpeg(bytes) ? bytes : null
  } catch { return null }
}
const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8

/** Rupees from paise, Indian grouping: ₹12,34,567.50 (the paise only when
 *  there are any, unless `always` asks for them). */
export function inr(paise: number, always = false): string {
  const neg = paise < 0
  const abs = Math.abs(Math.round(paise))
  const rupees = Math.floor(abs / 100)
  const p = abs % 100
  const s = String(rupees)
  const grouped = s.length <= 3 ? s : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3)
  return (neg ? '-' : '') + '₹' + grouped + (p || always ? '.' + String(p).padStart(2, '0') : '')
}

export function docDate(d = new Date(), tz = 'Asia/Kolkata'): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz })
}

// ---------------------------------------------------------------------------
// HTML: the letterhead for printable HTML documents (certificates, the staff
// overview). Inline styles, because the viewer inserts the HTML as it is.

const escH = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export function letterheadHTML(f: SchoolFacts, doc: { title: string; subtitle?: string; docNo?: string; date?: string }): string {
  const contact = [f.address, f.phone, f.email].filter(Boolean).map((v) => escH(v!)).join('<span style="margin:0 5pt;color:#9ca3af">·</span>')
  const logo = f.logoKey && /^[0-9a-f-]{36}$/i.test(f.logoKey)
    ? `<img src="/api/v1/files/${escH(f.logoKey)}?inline=1" alt="" style="height:52px;width:auto;max-width:140px;object-fit:contain;flex:none">` : ''
  const meta = [doc.docNo ? ['No.', doc.docNo] : null, ['Date', doc.date ?? docDate()]].filter(Boolean) as string[][]
  return `<header style="display:flex;align-items:center;gap:14pt;padding-bottom:10pt;margin-bottom:14pt;border-bottom:2.5pt solid ${f.accent}">${logo}` +
    `<div style="min-width:0"><div style="font-size:18pt;font-weight:700;line-height:1.15;color:#111827;overflow-wrap:anywhere">${escH(f.name)}</div>` +
    (f.tagline ? `<div style="margin-top:2pt;font-size:10pt;font-style:italic;color:#4b5563">${escH(f.tagline)}</div>` : '') +
    (contact ? `<div style="margin-top:3pt;font-size:8.5pt;color:#4b5563;overflow-wrap:anywhere">${contact}</div>` : '') +
    (f.affiliation ? `<div style="margin-top:1pt;font-size:8.5pt;color:#4b5563">${escH(f.affiliation)}</div>` : '') +
    `</div></header>` +
    `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16pt;margin:0 0 14pt">` +
    `<div style="min-width:0;border-left:3pt solid ${f.accent};padding-left:8pt"><div style="font-size:15pt;font-weight:700;color:#111827;overflow-wrap:anywhere">${escH(doc.title)}</div>` +
    (doc.subtitle ? `<div style="margin-top:2pt;font-size:10pt;color:#4b5563">${escH(doc.subtitle)}</div>` : '') + `</div>` +
    `<table style="border-collapse:collapse;font-size:9pt;flex:none">${meta.map(([k, v]) => `<tr><td style="color:#6b7280;padding:0 8pt 1pt 0;text-align:right">${escH(k)}</td><td style="font-weight:600;color:#111827;white-space:nowrap;text-align:right">${escH(v)}</td></tr>`).join('')}</table></div>`
}

export function docFooterHTML(f: SchoolFacts, docNo?: string): string {
  return `<footer style="display:flex;justify-content:space-between;gap:12px;margin-top:18pt;padding-top:6pt;border-top:0.75pt solid #d1d5db;font-size:8pt;color:#6b7280">` +
    `<span>Generated ${escH(docDate())}</span><span>${escH([f.name, docNo].filter(Boolean).join(' · '))}</span></footer>`
}

/** Paper rules for documentHTML, handed to the viewer as its css: on paper
 *  the page's own margin is the document's margin. */
export const DOC_PRINT_CSS = `@media print { .school-doc { width: auto !important; padding: 0 !important; margin: 0 !important; }
  .school-doc table { break-inside: auto; } .school-doc tr { break-inside: avoid; } .school-doc header { break-inside: avoid; } }`

/** The page wrapper every printable HTML document sits in. */
export function documentHTML(f: SchoolFacts, doc: { title: string; subtitle?: string; docNo?: string; date?: string }, body: string): string {
  return `<div class="school-doc" style="box-sizing:border-box;width:190mm;max-width:100%;margin:0 auto;padding:12mm;background:#fff;color:#111827;` +
    `font:10.5pt/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Telugu',Arial,sans-serif">` +
    letterheadHTML(f, doc) + body + docFooterHTML(f, doc.docNo) + `</div>`
}

// ---------------------------------------------------------------------------
// PDF

const MM = 72 / 25.4
const INK = rgb(0.067, 0.094, 0.153)
const MUTED = rgb(0.294, 0.333, 0.388)
const FAINT = rgb(0.42, 0.447, 0.502)
const RULE = rgb(0.898, 0.906, 0.922)

function hexRGB(hex: string): RGB {
  const h = hex.replace('#', '')
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255)
}
function tint(c: RGB, amount: number): RGB {
  return rgb(1 - (1 - c.red) * amount, 1 - (1 - c.green) * amount, 1 - (1 - c.blue) * amount)
}

export interface Column { label: string; width: number; align?: 'left' | 'right' | 'center' }

export interface DocOptions {
  title: string
  subtitle?: string
  docNo?: string
  /** Shown in the meta block; today when absent. */
  date?: string
  logo?: Uint8Array | null
  landscape?: boolean
  /** A watermark word across each page (VOID). */
  watermark?: string
}

/** A school's document as a PDF: letterhead, flowing content, footers. */
export class SchoolPDF {
  private page!: PDFPage
  private y = 0 // points from the top
  private pages: PDFPage[] = []
  private readonly W: number
  private readonly H: number
  private readonly M = 16 * MM
  private readonly bottom = 20 * MM
  private readonly accent: RGB
  private charset: Set<number>

  private constructor(private doc: PDFDocument, private reg: PDFFont, private bold: PDFFont,
    private school: SchoolFacts, private opts: DocOptions, private logo: PDFImage | null) {
    this.W = (opts.landscape ? 297 : 210) * MM
    this.H = (opts.landscape ? 210 : 297) * MM
    this.accent = hexRGB(school.accent)
    this.charset = new Set(reg.getCharacterSet())
  }

  static async create(school: SchoolFacts, opts: DocOptions): Promise<SchoolPDF> {
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
    const reg = await doc.embedFont(b64(DOC_SANS_REGULAR), { subset: true })
    const bold = await doc.embedFont(b64(DOC_SANS_BOLD), { subset: true })
    let logo: PDFImage | null = null
    if (opts.logo) {
      try { logo = isPng(opts.logo) ? await doc.embedPng(opts.logo) : await doc.embedJpg(opts.logo) } catch { logo = null }
    }
    doc.setTitle(`${opts.title}${opts.docNo ? ' ' + opts.docNo : ''}`)
    doc.setAuthor(school.name)
    doc.setCreator(school.name)
    doc.setProducer(school.name)
    const pdf = new SchoolPDF(doc, reg, bold, school, opts, logo)
    pdf.firstPage()
    return pdf
  }

  get contentWidth(): number { return this.W - 2 * this.M }

  /** Text the embedded font can draw: control characters and characters
   *  outside the subset are dropped (see the note at the top). */
  clean(s: string): string {
    let out = ''
    for (const ch of s.replace(/\r/g, '').replace(/\t/g, ' ')) {
      const c = ch.codePointAt(0)!
      if (c === 10 || this.charset.has(c)) out += ch
      else if (c === 0x2011) out += '-'
    }
    return out
  }

  /** One line: the text, or as much of it as fits followed by an ellipsis. */
  fit(s: string, size: number, maxW: number, bold = false): string {
    let t = this.clean(s)
    if (this.width(t, size, bold) <= maxW) return t
    while (t && this.width(t + '…', size, bold) > maxW) t = t.slice(0, -1)
    return t.trimEnd() + '…'
  }

  width(s: string, size: number, bold = false): number { return (bold ? this.bold : this.reg).widthOfTextAtSize(s, size) }

  /** Word wrap to a width; a word longer than the line is broken by character. */
  wrap(text: string, size: number, maxW: number, bold = false): string[] {
    const lines: string[] = []
    for (const para of this.clean(text).split('\n')) {
      let line = ''
      for (const word of para.split(' ')) {
        const cand = line ? line + ' ' + word : word
        if (this.width(cand, size, bold) <= maxW) { line = cand; continue }
        if (line) lines.push(line)
        line = ''
        let part = ''
        for (const ch of word) {
          if (part && this.width(part + ch, size, bold) > maxW) { lines.push(part); part = '' }
          part += ch
        }
        line = part
      }
      lines.push(line)
    }
    return lines
  }

  private text(s: string, x: number, yTop: number, size: number, opts: { bold?: boolean; color?: RGB } = {}): void {
    const t = this.clean(s)
    if (!t) return
    this.page.drawText(t, { x, y: this.H - yTop - size * 0.8, size, font: opts.bold ? this.bold : this.reg, color: opts.color ?? INK })
  }

  private newPage(): void {
    this.page = this.doc.addPage([this.W, this.H])
    this.pages.push(this.page)
    if (this.opts.watermark) {
      const size = 90
      const w = this.bold.widthOfTextAtSize(this.opts.watermark, size)
      this.page.drawText(this.opts.watermark, { x: this.W / 2 - w * 0.35, y: this.H / 2 - w * 0.35, size, font: this.bold, color: rgb(0.86, 0.15, 0.15), opacity: 0.12, rotate: degrees(45) })
    }
  }

  private firstPage(): void {
    this.newPage()
    const s = this.school
    let x = this.M
    let top = this.M
    const logoH = 15 * MM
    if (this.logo) {
      const scale = logoH / this.logo.height
      const w = Math.min(this.logo.width * scale, 40 * MM)
      const h = this.logo.height * (w / this.logo.width)
      this.page.drawImage(this.logo, { x, y: this.H - top - h, width: w, height: h })
      x += w + 5 * MM
    }
    const textW = this.W - this.M - x
    let ty = top
    for (const l of this.wrap(s.name, 17, textW, true)) { this.text(l, x, ty, 17, { bold: true }); ty += 20 }
    if (s.tagline) for (const l of this.wrap(s.tagline, 9.5, textW)) { this.text(l, x, ty + 1, 9.5, { color: MUTED }); ty += 12.5 }
    /* Address, phone and email break between themselves, never inside a
       phone number; only an address longer than the line wraps within. */
    const items = [s.address, s.phone, s.email].filter((v): v is string => !!v)
    const lines: string[] = []
    let cur = ''
    for (const it of items) {
      const cand = cur ? cur + '  ·  ' + it : it
      if (this.width(this.clean(cand), 8) <= textW) { cur = cand; continue }
      if (cur) lines.push(cur)
      const parts = this.wrap(it, 8, textW)
      cur = parts.pop() ?? ''
      lines.push(...parts)
    }
    if (cur) lines.push(cur)
    for (const l of lines) { this.text(l, x, ty + 2, 8, { color: MUTED }); ty += 10.5 }
    if (s.affiliation) { this.text(s.affiliation, x, ty + 2, 8, { color: MUTED }); ty += 10.5 }
    const headBottom = Math.max(ty, this.logo ? top + logoH : ty) + 6
    this.page.drawRectangle({ x: this.M, y: this.H - headBottom - 2.5, width: this.contentWidth, height: 2.5, color: this.accent })
    this.y = headBottom + 16

    // Title block, with the number and date set against the right margin.
    const meta: [string, string][] = []
    if (this.opts.docNo) meta.push(['No.', this.opts.docNo])
    meta.push(['Date', this.opts.date ?? docDate()])
    const metaW = Math.max(...meta.map(([k, v]) => this.width(k, 8.5) + 8 + this.width(v, 9, true)))
    const titleW = this.contentWidth - metaW - 20
    const titleTop = this.y
    let yy = this.y
    for (const l of this.wrap(this.opts.title, 15, titleW, true)) { this.text(l, this.M + 9, yy, 15, { bold: true }); yy += 18 }
    if (this.opts.subtitle) for (const l of this.wrap(this.opts.subtitle, 9.5, titleW)) { this.text(l, this.M + 9, yy + 1, 9.5, { color: MUTED }); yy += 12.5 }
    this.page.drawRectangle({ x: this.M, y: this.H - yy, width: 3, height: yy - titleTop, color: this.accent })
    let my = titleTop + 2
    for (const [k, v] of meta) {
      const vw = this.width(v, 9, true)
      this.text(v, this.W - this.M - vw, my, 9, { bold: true })
      this.text(k, this.W - this.M - vw - 8 - this.width(k, 8.5), my + 0.5, 8.5, { color: FAINT })
      my += 12.5
    }
    this.y = Math.max(yy, my) + 14
  }

  /** A continuation page: the school and the document in one quiet line. */
  private continuation(): void {
    this.newPage()
    const line = [this.school.name, this.opts.title].join('  ·  ')
    this.text(this.fit(line, 8.5, this.contentWidth), this.M, this.M, 8.5, { color: MUTED })
    this.page.drawRectangle({ x: this.M, y: this.H - this.M - 16, width: this.contentWidth, height: 0.75, color: this.accent })
    this.y = this.M + 26
  }

  /** Room for h more points, or a new page. */
  ensure(h: number): void {
    if (this.y + h > this.H - this.bottom) this.continuation()
  }

  space(h: number): void { this.y += h }

  heading(s: string): void {
    this.ensure(40)
    this.y += 4
    for (const l of this.wrap(s, 11.5, this.contentWidth, true)) { this.text(l, this.M, this.y, 11.5, { bold: true }); this.y += 15 }
    this.page.drawRectangle({ x: this.M, y: this.H - this.y - 1, width: 28, height: 1.5, color: this.accent })
    this.y += 8
  }

  paragraph(s: string, opts: { size?: number; color?: RGB; bold?: boolean } = {}): void {
    const size = opts.size ?? 10
    const lh = size * 1.45
    for (const l of this.wrap(s, size, this.contentWidth, opts.bold)) {
      this.ensure(lh)
      this.text(l, this.M, this.y, size, { color: opts.color, bold: opts.bold })
      this.y += lh
    }
    this.y += 4
  }

  /** Label and value pairs in two columns of facts, a hairline under each. */
  facts(pairs: [string, string][]): void {
    const labelW = Math.min(55 * MM, this.contentWidth * 0.38)
    const valW = this.contentWidth - labelW - 8
    for (const [k, v] of pairs) {
      const kl = this.wrap(k, 9, labelW)
      const vl = this.wrap(v || '-', 10, valW, true)
      const h = Math.max(kl.length * 12, vl.length * 13.5) + 7
      this.ensure(h)
      kl.forEach((l, i) => this.text(l, this.M, this.y + 3.5 + i * 12, 9, { color: MUTED }))
      vl.forEach((l, i) => this.text(l, this.M + labelW + 8, this.y + 3 + i * 13.5, 10, { bold: true }))
      this.y += h
      this.page.drawRectangle({ x: this.M, y: this.H - this.y, width: this.contentWidth, height: 0.6, color: RULE })
    }
    this.y += 8
  }

  /** A table: tinted head repeated on every page, hairline rows, text wrapped
   *  inside its cell. Widths are fractions of the content width. A row in
   *  `strong` is set bold with a rule above (a total). */
  table(cols: Column[], rows: string[][], opts: { strong?: Set<number>; size?: number } = {}): void {
    const size = opts.size ?? 9.5
    const total = cols.reduce((a, c) => a + c.width, 0)
    const widths = cols.map((c) => (c.width / total) * this.contentWidth)
    const pad = 5
    const head = () => {
      const lines = cols.map((c, i) => this.wrap(c.label.toUpperCase(), 7.5, widths[i] - 2 * pad, true))
      const h = Math.max(...lines.map((l) => l.length)) * 9.5 + 10
      this.ensure(h + 20)
      this.page.drawRectangle({ x: this.M, y: this.H - this.y - h, width: this.contentWidth, height: h, color: tint(this.accent, 0.08) })
      this.page.drawRectangle({ x: this.M, y: this.H - this.y - h, width: this.contentWidth, height: 1, color: this.accent })
      let x = this.M
      cols.forEach((c, i) => {
        lines[i].forEach((l, j) => {
          const w = this.width(l, 7.5, true)
          const tx = c.align === 'right' ? x + widths[i] - pad - w : c.align === 'center' ? x + (widths[i] - w) / 2 : x + pad
          this.text(l, tx, this.y + 5 + j * 9.5, 7.5, { bold: true, color: MUTED })
        })
        x += widths[i]
      })
      this.y += h
    }
    head()
    rows.forEach((row, r) => {
      const bold = opts.strong?.has(r) ?? false
      const lines = cols.map((_, i) => this.wrap(row[i] ?? '', size, widths[i] - 2 * pad, bold))
      const h = Math.max(...lines.map((l) => l.length)) * size * 1.35 + 9
      if (this.y + h > this.H - this.bottom) { this.continuation(); head() }
      if (bold) this.page.drawRectangle({ x: this.M, y: this.H - this.y - 0.8, width: this.contentWidth, height: 0.8, color: INK })
      let x = this.M
      cols.forEach((c, i) => {
        lines[i].forEach((l, j) => {
          const w = this.width(l, size, bold)
          const tx = c.align === 'right' ? x + widths[i] - pad - w : c.align === 'center' ? x + (widths[i] - w) / 2 : x + pad
          this.text(l, tx, this.y + 4.5 + j * size * 1.35, size, { bold })
        })
        x += widths[i]
      })
      this.y += h
      this.page.drawRectangle({ x: this.M, y: this.H - this.y, width: this.contentWidth, height: 0.6, color: RULE })
    })
    if (rows.length === 0) {
      this.ensure(20)
      this.text('Nothing to show.', this.M + pad, this.y + 5, size, { color: MUTED })
      this.y += 20
    }
    this.y += 10
  }

  /** A right-aligned label and amount, for totals under a table. */
  total(label: string, value: string, big = false): void {
    const size = big ? 13 : 10
    this.ensure(size + 10)
    const vw = this.width(value, size, true)
    this.text(value, this.W - this.M - vw, this.y, size, { bold: true })
    const lw = this.width(label, 9)
    this.text(label, this.W - this.M - vw - 14 - lw, this.y + (size - 9) * 0.7, 9, { color: MUTED })
    this.y += size + 7
  }

  /** Footers on every page, then the bytes. */
  async save(): Promise<Uint8Array> {
    const n = this.pages.length
    const left = [this.school.name, this.opts.docNo].filter(Boolean).join('  ·  ')
    const mid = `Generated ${docDate()}`
    this.pages.forEach((pg, i) => {
      this.page = pg
      const fy = this.H - 12 * MM
      pg.drawRectangle({ x: this.M, y: this.H - fy + 4, width: this.contentWidth, height: 0.6, color: RULE })
      const right = `Page ${i + 1} of ${n}`
      const rw = this.width(right, 7.5)
      const midW = this.width(mid, 7.5)
      const leftMax = this.contentWidth / 2 - midW / 2 - 10
      this.text(this.fit(left, 7.5, leftMax), this.M, fy, 7.5, { color: FAINT })
      this.text(mid, this.W / 2 - midW / 2, fy, 7.5, { color: FAINT })
      this.text(right, this.W - this.M - rw, fy, 7.5, { color: FAINT })
    })
    const bytes = await this.doc.save()
    if (!bytes || bytes.byteLength < 800 || n === 0) throw new Error('document came out empty')
    return bytes
  }
}

/** The response for a PDF: never an empty body. */
export function pdfResponse(bytes: Uint8Array, name: string, inline = true): Response {
  if (!bytes || bytes.byteLength === 0) {
    return new Response(JSON.stringify({ error: { code: 'pdf_empty', message: 'The document could not be produced. Try again, and tell the office if it keeps happening.' } }),
      { status: 500, headers: { 'content-type': 'application/json' } })
  }
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`,
      'cache-control': 'no-store',
    },
  })
}
