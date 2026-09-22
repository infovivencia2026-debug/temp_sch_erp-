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
  const head = copy.querySelector('[data-page-enter]')
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
  if (landscape) {
    const style = document.createElement('style')
    style.textContent = '@media print { @page { size: landscape; } }'
    paper.appendChild(style)
  }

  const lh = letterhead
  if (lh) {
    const el = document.createElement('header')
    el.className = 'print-sheet__head'
    if (lh.logoKey) {
      const img = document.createElement('img')
      img.className = 'print-sheet__logo'
      img.alt = ''
      img.src = `/api/v1/files/${lh.logoKey}?inline=1`
      el.appendChild(img)
    }
    const text = document.createElement('div')
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
    el.appendChild(text)
    paper.appendChild(el)
  }

  const titleBlock = document.createElement('div')
  titleBlock.className = 'print-sheet__title'
  const h = document.createElement('h1')
  h.textContent = title
  titleBlock.appendChild(h)
  if (subtitle) {
    const p = document.createElement('p')
    p.textContent = subtitle
    titleBlock.appendChild(p)
  }
  paper.appendChild(titleBlock)

  const body = document.createElement('div')
  body.className = 'print-sheet__body'
  body.appendChild(copy)
  paper.appendChild(body)

  const foot = document.createElement('footer')
  foot.className = 'print-sheet__foot'
  const when = new Date().toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const left = document.createElement('span')
  left.textContent = `Printed ${when}${lh?.printedBy ? ` by ${lh.printedBy}` : ''}`
  const right = document.createElement('span')
  right.textContent = lh?.name ?? ''
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

/* A copy of the source that is a document rather than a screen. */
function tidyCopy(source: HTMLElement): HTMLElement {
  const copy = source.cloneNode(true) as HTMLElement
  copy.removeAttribute('id')
  copy.removeAttribute('style')
  copy.className = 'print-sheet__source'

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
