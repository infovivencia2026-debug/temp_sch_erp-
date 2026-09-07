import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { code } from './bento-test-render'

/* THE ADD GALLERY'S CONTRACT.

   What the parent relies on: every item is drawn, a tier that does not fit
   is a disabled button that says why, a press or an Enter hands back
   (id, tier), Escape closes, an empty list says so, and — the one every
   bento drawing promises — neither source names a colour. */

vi.mock('@/lib/i18n', () => ({
  useT: () => (k: string, vars?: Record<string, string | number>) =>
    vars ? `${k}[${Object.values(vars).join(',')}]` : k,
}))

/* `useReduceMotion` reads the account through react-query, which needs a
   provider this test has no reason to build; the gallery only asks it
   whether to animate. Still, so the exit unmounts on the next tick. */
vi.mock('./bento-kit', () => ({
  useReduceMotion: () => true,
}))

import { AddGallery, type GalleryItem, type SizeTier } from './AddGallery'

const ITEMS: GalleryItem[] = [
  { id: 'fees', label: 'Fees due', hint: 'What is outstanding', tiers: ['small', 'medium', 'large', 'wide'], defaultTier: 'medium' },
  { id: 'roll', label: 'On the roll', tiers: ['small'], defaultTier: 'small' },
  { id: 'exams', label: 'Exams', tiers: [], defaultTier: 'large' },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const panel = () => document.body.querySelector<HTMLElement>('[data-add-gallery]')
const tile = (id: string) => document.body.querySelector<HTMLElement>(`[data-gallery-tile="${id}"]`)
const size = (id: string, tier: SizeTier) =>
  tile(id)!.querySelector<HTMLButtonElement>(`button[data-tier="${tier}"]`)!

async function render(props: Partial<Parameters<typeof AddGallery>[0]> = {}) {
  const onAdd = vi.fn()
  const onClose = vi.fn()
  await act(async () => {
    root.render(<AddGallery open items={ITEMS} phone={false} onAdd={onAdd} onClose={onClose} {...props} />)
  })
  return { onAdd, onClose }
}

function key(target: Element, k: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('AddGallery', () => {
  it('draws a tile for every item, with its label and hint', async () => {
    await render()
    const dialog = panel()
    expect(dialog, 'the dialog is portalled to the body').not.toBeNull()
    expect(dialog!.getAttribute('role')).toBe('dialog')
    expect(dialog!.getAttribute('aria-label')).toBe('bento.add_gallery.title')
    expect(document.body.querySelectorAll('[data-gallery-tile]')).toHaveLength(3)
    expect(tile('fees')!.textContent).toContain('Fees due')
    expect(tile('fees')!.textContent).toContain('What is outstanding')
    // Four size buttons on every tile, each named for a screen reader.
    expect(tile('fees')!.querySelectorAll('button[data-tier]')).toHaveLength(4)
    expect(size('fees', 'large').getAttribute('aria-label')).toBe(
      'bento.add_gallery.add_as[Fees due,bento.size.large]',
    )
    // The first tile is the tab stop; the rest are reached with the arrows.
    expect(tile('fees')!.tabIndex).toBe(0)
    expect(tile('roll')!.tabIndex).toBe(-1)
  })

  it('a tier that does not fit is disabled and says so', async () => {
    await render()
    expect(size('roll', 'small').disabled).toBe(false)
    expect(size('roll', 'medium').disabled).toBe(true)
    expect(size('roll', 'medium').title).toBe('bento.add_gallery.no_room')
    expect(size('roll', 'small').title).toBe('')
    for (const tier of ['small', 'medium', 'large', 'wide'] as const) {
      expect(size('exams', tier).disabled, `exams ${tier}`).toBe(true)
    }
  })

  it('pressing a size adds at that tier and flashes Added', async () => {
    const { onAdd } = await render()
    await act(async () => { size('fees', 'wide').click() })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith('fees', 'wide')
    expect(tile('fees')!.hasAttribute('data-added')).toBe(true)
    expect(tile('fees')!.textContent).toContain('bento.add_gallery.added')
    // A disabled tier adds nothing.
    await act(async () => { size('roll', 'large').click() })
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('Enter on a tile adds at the default tier; digits pick a tier', async () => {
    const { onAdd } = await render()
    await act(async () => { key(tile('fees')!, 'Enter') })
    expect(onAdd).toHaveBeenLastCalledWith('fees', 'medium')
    await act(async () => { key(tile('fees')!, '4') })
    expect(onAdd).toHaveBeenLastCalledWith('fees', 'wide')
    // 2 is Medium, which does not fit on the roll: nothing happens.
    await act(async () => { key(tile('roll')!, '2') })
    expect(onAdd).toHaveBeenCalledTimes(2)
  })

  it('the arrows move focus between tiles', async () => {
    await render()
    expect(document.activeElement).toBe(tile('fees'))
    await act(async () => { key(tile('fees')!, 'ArrowRight') })
    expect(document.activeElement).toBe(tile('roll'))
    expect(tile('roll')!.tabIndex).toBe(0)
    expect(tile('fees')!.tabIndex).toBe(-1)
    await act(async () => { key(tile('roll')!, 'End') })
    expect(document.activeElement).toBe(tile('exams'))
    await act(async () => { key(tile('exams')!, 'ArrowLeft') })
    expect(document.activeElement).toBe(tile('roll'))
  })

  it('an item that vanishes after adding hands focus to its neighbour', async () => {
    const onAdd = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(<AddGallery open items={ITEMS} phone={false} onAdd={onAdd} onClose={onClose} />)
    })
    await act(async () => { size('fees', 'small').click() })
    // The parent placed it and re-renders without it.
    await act(async () => {
      root.render(<AddGallery open items={ITEMS.slice(1)} phone={false} onAdd={onAdd} onClose={onClose} />)
    })
    expect(tile('fees')).toBeNull()
    expect(document.activeElement).toBe(tile('roll'))
    expect(tile('roll')!.tabIndex).toBe(0)
  })

  it('Escape closes', async () => {
    const { onClose } = await render()
    await act(async () => { key(tile('fees')!, 'Escape') })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a press outside the popover closes it; a press inside does not', async () => {
    const { onClose } = await render()
    await act(async () => {
      tile('roll')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('on a phone it is a sheet with a backdrop that closes on tap', async () => {
    const { onClose } = await render({ phone: true })
    expect(panel()!.hasAttribute('data-phone')).toBe(true)
    const backdrop = document.body.querySelector<HTMLElement>('.bento-gallery__backdrop')
    expect(backdrop).not.toBeNull()
    await act(async () => { backdrop!.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('an empty list says everything is on the board', async () => {
    await render({ items: [] })
    expect(document.body.querySelectorAll('[data-gallery-tile]')).toHaveLength(0)
    expect(panel()!.textContent).toContain('bento.add_gallery.empty')
  })

  it('closed, it draws nothing', async () => {
    await render({ open: false })
    expect(panel()).toBeNull()
  })
})

/* ── no source names a colour ───────────────────────────────────────────── */

describe('the gallery names no colour', () => {
  const files = ['src/features/bento/AddGallery.tsx', 'src/features/bento/add-gallery.css']
  for (const file of files) {
    const source = code(readFileSync(resolve(process.cwd(), file), 'utf8'))
    it(`${file} contains no hex literal`, () => {
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    })
    it(`${file} contains no rgb() or hsl() literal`, () => {
      expect(source).not.toMatch(/\b(rgba?|hsla?)\s*\(/)
    })
  }
  it('the stylesheet states every strength through currentColor mixes', () => {
    const css = code(readFileSync(resolve(process.cwd(), files[1]), 'utf8'))
    expect(css).toMatch(/color-mix\(in srgb, currentColor/)
  })
})
