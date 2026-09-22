import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePrintSheet, printDocument, printSheet, setPrintLetterhead } from './print'

/* The print sheet is a copy of the screen made into a document. These pin
   what "made into a document" means, because each item was a real printout
   that came out wrong: a button on paper, a blank square where the QR code
   was, a filter box with nothing in it, a heading printed twice. */

function screen(html: string): HTMLElement {
  const main = document.createElement('main')
  main.innerHTML = html
  document.body.appendChild(main)
  return main
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.print = vi.fn()
  setPrintLetterhead({ name: 'Vivencia School', tagline: 'Learn. Lead.', printedBy: 'Asha' })
})
afterEach(() => {
  closePrintSheet()
  setPrintLetterhead(null)
})

describe('printDocument', () => {
  it('puts the screen under the letterhead, titled by its own heading, and hides the app', () => {
    screen(`
      <div data-page-enter=""><h1>Fee collection</h1><p>Today's counter</p></div>
      <div class="card"><table><tr><th>Receipt</th><th>Amount</th></tr></table></div>
    `)
    const sheet = printDocument({ open: false })!
    expect(printSheet()).toBe(sheet)
    expect(document.documentElement.dataset.printing).toBe('')
    expect(sheet.querySelector('.print-sheet__school')?.textContent).toBe('Vivencia School')
    expect(sheet.querySelector('.print-sheet__title h1')?.textContent).toBe('Fee collection')
    expect(sheet.querySelector('.print-sheet__title p')?.textContent).toBe("Today's counter")
    // The heading is not repeated inside the body.
    expect(sheet.querySelectorAll('h1')).toHaveLength(1)
    expect(sheet.querySelector('.print-sheet__body table')).not.toBeNull()
    expect(sheet.querySelector('.print-sheet__foot')?.textContent).toContain('by Asha')
  })

  it('drops what only exists to be clicked and flattens form controls to their value', () => {
    const main = screen(`
      <h1>Register</h1>
      <button>Refresh</button>
      <div class="no-print">filters</div>
      <select><option>Term 1</option><option selected>Term 2</option></select>
      <input type="text" />
      <input type="checkbox" checked />
      <a href="/x" target="_blank">Row link</a>
    `)
    main.querySelector<HTMLInputElement>('input[type=text]')!.value = 'Grade 6-B'
    const sheet = printDocument({ open: false })!
    expect(sheet.querySelector('.print-sheet__body button')).toBeNull()
    expect(sheet.querySelector('.print-sheet__body .no-print')).toBeNull()
    expect(sheet.querySelector('.print-sheet__body select')).toBeNull()
    const values = Array.from(sheet.querySelectorAll('.print-sheet__value')).map((v) => v.textContent)
    expect(values).toEqual(['Term 2', 'Grade 6-B', '☑'])
    const a = sheet.querySelector('.print-sheet__body a')!
    expect(a.textContent).toBe('Row link')
    expect(a.hasAttribute('href')).toBe(false)
  })

  it('prints a named source under a given title, and a wide table on its side', () => {
    screen('<h1>Page</h1>')
    const card = document.createElement('div')
    card.innerHTML = '<table><tr>' + '<td>c</td>'.repeat(9) + '</tr></table>'
    document.body.appendChild(card)
    const sheet = printDocument({ source: card, title: 'Fee receipt', subtitle: 'R-1042', open: false })!
    expect(sheet.querySelector('.print-sheet__title h1')?.textContent).toBe('Fee receipt')
    expect(sheet.querySelector('.print-sheet__title p')?.textContent).toBe('R-1042')
    expect(sheet.dataset.landscape).toBe('')
  })

  it('asks for the dialog once the copy is on the page, and closes on Escape', async () => {
    screen('<h1>Slip</h1>')
    printDocument()
    await new Promise((r) => setTimeout(r, 30))
    expect(window.print).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(printSheet()).toBeNull()
    expect(document.documentElement.dataset.printing).toBeUndefined()
  })

  it('prefers the shell print when a phone app provides one', async () => {
    screen('<h1>Slip</h1>')
    const shell = { print: vi.fn() }
    ;(window as unknown as { ErpShell: unknown }).ErpShell = shell
    try {
      printDocument()
      await new Promise((r) => setTimeout(r, 30))
      expect(shell.print).toHaveBeenCalledTimes(1)
      expect(window.print).not.toHaveBeenCalled()
    } finally {
      delete (window as unknown as { ErpShell?: unknown }).ErpShell
    }
  })

  it('opens a second sheet in place of the first rather than on top of it', () => {
    screen('<h1>One</h1>')
    printDocument({ open: false })
    printDocument({ title: 'Two', open: false })
    expect(document.querySelectorAll('.print-sheet')).toHaveLength(1)
    expect(printSheet()?.querySelector('.print-sheet__title h1')?.textContent).toBe('Two')
  })
})
