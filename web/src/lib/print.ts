import '@/components/print-sheet.css'

/* Print, wherever the page happens to be running.

   window.print() is what a browser answers with its print dialog and what a
   WebView answers with nothing: neither the Android WebView nor WKWebView
   wires it to the system's print service, so every "Print" button in the
   product -- the fee receipt, the report card, the ID card, the bus sticker
   -- did nothing at all inside the parent app. No error, no dialog, a button
   that pressed and stayed pressed.

   The shells now expose ErpShell.print (mobile/apps/parent MainActivity.kt,
   mobile/apps/parent-ios BridgeScript.swift), which hands the page to the
   phone's own print sheet. Both sheets include "Save as PDF", which is what
   a parent on a phone actually wants from "Print": a file to keep or send.
   The site's print stylesheet applies in the WebView exactly as in a
   browser, so what comes out is the same document. Older builds of the app
   have no such method and fall through to window.print, which is no worse
   than before. */
export function printPage(): void {
  if (typeof window === 'undefined') return
  const shell = window.ErpShell?.print
  if (typeof shell === 'function') {
    shell.call(window.ErpShell)
    return
  }
  window.print()
}

/* THE PRINT SHEET: A WEB PAGE THAT IS THE DOCUMENT.

   Printing the screen, however well the print stylesheet strips it, prints
   a screen: a page head with a breadcrumb, a filter bar, a card with a
   scrollbar's worth of table, in whatever colours the theme had. What a
   school hands over the counter is a document -- letterhead at the top,
   a title, the table, who printed it and when at the foot -- and it is the
   same document on paper, in "Save as PDF" on a phone, and on the screen
   while the dialog is up.

   So "Print" now builds that document as a page: the printable part of the
   screen is copied into a white A4 sheet under the school's letterhead,
   the copy is tidied (buttons gone, form controls flattened to the value
   they showed, canvases turned into pictures, colour tokens forced to black
   on white), everything else on the page is hidden behind it, and only
   then is the print dialog asked for. The sheet stays up after the dialog
   closes -- it is the document, readable, with its own Print and Close --
   so a cancelled dialog leaves the person looking at what they meant to
   print instead of back at the screen wondering whether anything happened.

   Everything here is plain DOM rather than React: it has to work from a
   click handler in any screen, and the copy it makes is dead markup that
   React neither owns nor needs to. */

export interface PrintLetterhead {
  name: string
  tagline?: string
  logoKey?: string
  /** The school's brand colour (#rrggbb): the letterhead's rule, the title's
   *  mark and the table heads. A dark neutral when absent or unreadable. */
  accent?: string
  address?: string
  phone?: string
  email?: string
  /** Board affiliation or UDISE code. */
  affiliation?: string
  /** Who is printing, for the foot of the sheet. */
  printedBy?: string
}

let letterhead: PrintLetterhead | null = null

/** Called by SessionProvider during render, so every sheet carries the
 *  school's name and logo without each screen having to hand them over. */
export function setPrintLetterhead(next: PrintLetterhead | null): void {
  letterhead = next
}

export interface PrintDocumentOptions {
  /** The document's title. Derived from the source's first heading if omitted. */
  title?: string
  subtitle?: string
  /** What to print. The page's <main> when omitted. */
  source?: HTMLElement | null
  /** Wide tables want the sheet on its side. Decided from the widest table
   *  in the copy when not given. */
  landscape?: boolean
  /** Whether to open the print dialog at once (the default) or only show
   *  the document with its Print button. */
  open?: boolean
  /** The document's own number -- a receipt, a certificate serial, a
   *  ticket -- printed beside the title and at the foot of every page. */
  docNo?: string
}

const SHEET_ID = 'erp-print-sheet'

/** The sheet currently up, if any. */
export function printSheet(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(SHEET_ID)
}

export function closePrintSheet(): void {
  const sheet = printSheet()
  if (!sheet) return
  sheet.remove()
  delete document.documentElement.dataset.printing
  document.removeEventListener('keydown', onKey)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closePrintSheet()
}

/** Build the document and print it. Returns the sheet element, for tests
 *  and for a caller that wants to close it itself. */
export function printDocument(opts: PrintDocumentOptions = {}): HTMLElement | null {
  if (typeof document === 'undefined') return null
  closePrintSheet()

  const source = opts.source ?? document.querySelector<HTMLElement>('main')
  if (!source) {
    printPage()
    return null
  }
  const copy = tidyCopy(source)

  /* The title is the page's own heading unless the caller names one, and
     the heading block is not repeated below it. */
  /* The page's own heading block (PageHead). Only that: PageBody carries the
     same entrance attribute, and taking "the first [data-page-enter]" -- or
     hiding every one of them in the sheet's stylesheet, as this once did --
     took the whole body of the page with it and printed a letterhead over an
     empty sheet. */
  const head = copy.querySelector('[data-page-head]')
  const h1 = copy.querySelector('h1')
  const title = opts.title ?? h1?.textContent?.trim() ?? document.title
  const subtitle = opts.subtitle ?? (head ? head.querySelector('p')?.textContent?.trim() : undefined)
  if (head) head.remove()
  else h1?.remove()

  const landscape = opts.landscape ?? widestTable(copy) > 7

  const sheet = document.createElement('div')
  sheet.id = SHEET_ID
  sheet.className = 'print-sheet'
  sheet.setAttribute('role', 'document')
  sheet.setAttribute('aria-label', 'Print preview')
  if (landscape) sheet.dataset.landscape = ''

  const bar = document.createElement('div')
  bar.className = 'print-sheet__bar no-print'
  const barTitle = document.createElement('span')
  barTitle.className = 'print-sheet__bar-title'
  barTitle.textContent = 'Print preview'
  const actions = document.createElement('span')
  actions.className = 'print-sheet__bar-actions'
  const printBtn = document.createElement('button')
  printBtn.type = 'button'
  printBtn.className = 'print-sheet__btn print-sheet__btn--primary'
  printBtn.textContent = 'Print'
  printBtn.addEventListener('click', () => printPage())
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'print-sheet__btn'
  closeBtn.dataset.close = ''
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', () => closePrintSheet())
  actions.append(printBtn, closeBtn)
  bar.append(barTitle, actions)

  const paper = document.createElement('div')
  paper.className = 'print-sheet__paper'

  const lh = letterhead
  const accent = readableAccent(lh?.accent)
  paper.style.setProperty('--doc-accent', accent)
  paper.appendChild(pageRules(lh?.name ?? '', opts.docNo, landscape, generatedLine(lh)))
  paper.appendChild(buildLetterhead(lh))

  const titleBlock = document.createElement('div')
  titleBlock.className = 'print-sheet__title'
  const titleText = document.createElement('div')
  titleText.className = 'print-sheet__title-text'
  const h = document.createElement('h1')
  h.textContent = title
  titleText.appendChild(h)
  if (subtitle) {
    const p = document.createElement('p')
    p.textContent = subtitle
    titleText.appendChild(p)
  }
  titleBlock.appendChild(titleText)
  const meta = document.createElement('dl')
  meta.className = 'print-sheet__meta'
  const addMeta = (k: string, v: string) => {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    meta.append(dt, dd)
  }
  if (opts.docNo) addMeta('No.', opts.docNo)
  addMeta('Date', new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }))
  titleBlock.appendChild(meta)
  paper.appendChild(titleBlock)

  const body = document.createElement('div')
  body.className = 'print-sheet__body'
  body.appendChild(copy)
  paper.appendChild(body)

  const foot = document.createElement('footer')
  foot.className = 'print-sheet__foot'
  const left = document.createElement('span')
  left.textContent = generatedLine(lh)
  const right = document.createElement('span')
  right.textContent = [lh?.name, opts.docNo].filter(Boolean).join(' · ')
  foot.append(left, right)
  paper.appendChild(foot)

  sheet.append(bar, paper)
  document.body.appendChild(sheet)
  document.documentElement.dataset.printing = ''
  document.addEventListener('keydown', onKey)
  closeBtn.focus()

  if (opts.open !== false) {
    /* The logo and any pictures in the copy have to be on the page before
       the dialog snapshots it; a moment, and no longer than a moment. */
    void whenPicturesReady(paper, 1200).then(() => {
      if (printSheet() !== sheet) return
      printPage()
    })
  }
  return sheet
}

/* THE LETTERHEAD: the school's logo, its name as it brands itself, the
   tagline, and one line of address and contact under it, over a rule in the
   school's own colour. A school without a logo prints its name alone -- the
   name is the mark -- and one that has entered no address prints no empty
   line for it. Nothing here ever names the product. */
function buildLetterhead(lh: PrintLetterhead | null): HTMLElement {
  const el = document.createElement('header')
  el.className = 'print-sheet__head'
  if (!lh) return el
  if (lh.logoKey) {
    const img = document.createElement('img')
    img.className = 'print-sheet__logo'
    img.alt = ''
    img.src = `/api/v1/files/${lh.logoKey}?inline=1`
    /* A logo that fails to load leaves the name, not a broken-image box. */
    img.addEventListener('error', () => img.remove(), { once: true })
    el.appendChild(img)
  }
  const text = document.createElement('div')
  text.className = 'print-sheet__head-text'
  const name = document.createElement('p')
  name.className = 'print-sheet__school'
  name.textContent = lh.name
  text.appendChild(name)
  if (lh.tagline) {
    const tag = document.createElement('p')
    tag.className = 'print-sheet__tagline'
    tag.textContent = lh.tagline
    text.appendChild(tag)
  }
  const contact = [lh.address, lh.phone, lh.email].filter((v): v is string => !!v && !!v.trim())
  if (contact.length) {
    const c = document.createElement('p')
    c.className = 'print-sheet__contact'
    contact.forEach((v, i) => {
      if (i) {
        const dot = document.createElement('span')
        dot.className = 'print-sheet__sep'
        dot.textContent = '·'
        c.appendChild(dot)
      }
      const s = document.createElement('span')
      s.textContent = v
      c.appendChild(s)
    })
    text.appendChild(c)
  }
  if (lh.affiliation) {
    const a = document.createElement('p')
    a.className = 'print-sheet__contact'
    a.textContent = lh.affiliation
    text.appendChild(a)
  }
  el.appendChild(text)
  return el
}

/* The paper's own rules: A4 (on its side for a wide table), margins, and in
   the bottom margin of every page the school's name and document number on
   the left and "Page x of y" on the right. Page margin boxes are drawn by
   Chromium (Chrome, Edge, the Android app's WebView); a browser without them
   still prints the in-flow foot at the end of the document. */
function generatedLine(lh: PrintLetterhead | null): string {
  const when = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `Generated ${when}${lh?.printedBy ? ` by ${lh.printedBy}` : ''}`
}

function pageRules(name: string, docNo: string | undefined, landscape: boolean, generated: string): HTMLStyleElement {
  const style = document.createElement('style')
  /* Three boxes share one line of margin; a long name is shortened there
     (it is in full on the letterhead) so it never wraps into the page. */
  const short = name.length > 48 ? name.slice(0, 46).trimEnd() + '…' : name
  const left = cssString([short, docNo].filter(Boolean).join(' · '))
  style.textContent = `@media print { @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 14mm 14mm 16mm;
    @bottom-left { content: ${left}; font: 8pt system-ui, sans-serif; color: #6b7280; }
    @bottom-center { content: ${cssString(generated)}; font: 8pt system-ui, sans-serif; color: #6b7280; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt system-ui, sans-serif; color: #6b7280; } }
    /* The foot is in every page's margin now; in the flow it only ever
       added a page of its own when a document ended near the bottom. */
    .print-sheet__foot { display: none !important; } }`
  return style
}

function cssString(v: string): string {
  return '"' + v.replace(/[\\"]/g, (c) => '\\' + c).replace(/[\n\r]/g, ' ') + '"'
}

/** The school's colour as the document's accent, or a dark slate when there
 *  is none or it is too pale to read as a rule and a heading on white. */
export function readableAccent(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex ?? '').trim())
  if (!m) return '#1f2937'
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  /* Contrast against white of at least 3:1 (large text and rules). */
  return 1.05 / (lum + 0.05) >= 3 ? '#' + h.toLowerCase() : '#1f2937'
}

/* A copy of the source that is a document rather than a screen. */
function tidyCopy(source: HTMLElement): HTMLElement {
  const copy = source.cloneNode(true) as HTMLElement
  copy.removeAttribute('id')
  copy.removeAttribute('style')
  /* The page's <main> is a screen layout and loses its classes; a named
     source keeps them -- they are its layout (a grid of ID cards, a receipt's
     columns), and dropping them printed six cards in one column. */
  if (source.tagName === 'MAIN') copy.className = 'print-sheet__source'
  else copy.classList.add('print-sheet__source')

  /* Canvases clone blank; the drawing lives on the original. A QR code or a
     chart becomes a picture of itself. */
  const srcCanvases = source.querySelectorAll('canvas')
  const dstCanvases = copy.querySelectorAll('canvas')
  dstCanvases.forEach((c, i) => {
    const original = srcCanvases[i]
    let url = ''
    try { url = original?.toDataURL('image/png') ?? '' } catch { url = '' }
    if (url) {
      const img = document.createElement('img')
      img.src = url
      img.alt = original.getAttribute('aria-label') ?? ''
      img.className = c.className
      img.style.cssText = c.style.cssText
      c.replaceWith(img)
    } else {
      c.remove()
    }
  })

  /* Form controls become the value they were showing. A filter reading
     "Term 2" is context the document needs; the box it sat in is not. */
  type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  const srcFields = source.querySelectorAll<Field>('input, select, textarea')
  const dstFields = copy.querySelectorAll<Field>('input, select, textarea')
  dstFields.forEach((f, i) => {
    const original = srcFields[i]
    const span = document.createElement('span')
    span.className = 'print-sheet__value'
    if (original instanceof HTMLSelectElement) {
      span.textContent = original.selectedOptions[0]?.textContent?.trim() ?? ''
    } else if (original instanceof HTMLInputElement && (original.type === 'checkbox' || original.type === 'radio')) {
      span.textContent = original.checked ? '☑' : '☐'
    } else if (original instanceof HTMLInputElement && (original.type === 'search' || original.type === 'hidden')) {
      f.remove()
      return
    } else {
      span.textContent = original?.value ?? ''
    }
    f.replaceWith(span)
  })

  /* Anything that only exists to be clicked. */
  copy.querySelectorAll(
    'button, .no-print, [role="dialog"], [aria-live], nav[aria-label], [data-assistant], .bento-coach, script, style, [hidden]',
  ).forEach((el) => el.remove())
  /* Links are their text on paper. */
  copy.querySelectorAll('a[href]').forEach((a) => {
    a.removeAttribute('href')
    a.removeAttribute('target')
  })
  /* Scrollers clip; on the sheet everything unrolls. */
  copy.querySelectorAll<HTMLElement>('.scroll-x, .overflow-x-auto, .overflow-y-auto').forEach((el) => {
    el.style.overflow = 'visible'
    el.style.maxHeight = 'none'
  })
  return copy
}

function widestTable(root: HTMLElement): number {
  let widest = 0
  root.querySelectorAll('table').forEach((t) => {
    const row = t.querySelector('tr')
    if (row) widest = Math.max(widest, row.children.length)
  })
  return widest
}

function whenPicturesReady(root: HTMLElement, timeoutMs: number): Promise<void> {
  const frame = (fn: () => void) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : window.setTimeout(fn, 0)
  const pending = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete)
  if (pending.length === 0) {
    return new Promise((resolve) => frame(() => resolve()))
  }
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      frame(() => resolve())
    }
    const timer = window.setTimeout(finish, timeoutMs)
    let left = pending.length
    const one = () => {
      left -= 1
      if (left <= 0) {
        window.clearTimeout(timer)
        finish()
      }
    }
    pending.forEach((img) => {
      img.addEventListener('load', one, { once: true })
      img.addEventListener('error', one, { once: true })
    })
  })
}
