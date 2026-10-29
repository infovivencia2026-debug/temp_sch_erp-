import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Select } from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'

vi.mock('@/lib/session', async (orig) => ({ ...(await orig<object>()), useCan: () => () => false }))

let host: HTMLDivElement
let root: Root
function phone(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: on && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  phone(false)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = '' })

/* Owner, 2026-10-26: "this button is not working for all dropdown and also
   when I click once unable to close it using same button". */
const OPTS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]
function S() { const [v, setV] = useState(''); return <Select value={v} onChange={setV} options={OPTS} placeholder="Pick" /> }
function P() { const [v, setV] = useState<'a' | 'b'>('a'); return <PickerMenu value={v} onChange={setV} options={OPTS as { value: 'a' | 'b'; label: string }[]} ariaLabel="Pick" /> }
const press = (el: Element) => act(() => {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  ;(el as HTMLElement).focus?.()
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
const listOpen = () => !!document.querySelector('[role="listbox"]')

describe('dropdown chevron toggles', () => {
  it('Select: the chevron opens, the chevron again closes', () => {
    act(() => root.render(<S />))
    const chev = host.querySelector('button[aria-label="Open list"]')!
    press(chev); expect(listOpen()).toBe(true)
    expect(host.querySelector('input')!.getAttribute('aria-expanded')).toBe('true')
    press(chev); expect(listOpen()).toBe(false)
  })
  it('Select: a second click on the box closes it', () => {
    act(() => root.render(<S />))
    const input = host.querySelector('input')!
    press(input); expect(listOpen()).toBe(true)
    press(input); expect(listOpen()).toBe(false)
    press(host.querySelector('button[aria-label="Open list"]')!); expect(listOpen()).toBe(true)
    press(input); expect(listOpen()).toBe(false)
  })
  it('PickerMenu: the chevron opens, a second click on the trigger closes', () => {
    act(() => root.render(<P />))
    const trig = host.querySelector('button[aria-haspopup="listbox"]')!
    press(trig.querySelector('.field-chevron')!); expect(trig.getAttribute('aria-expanded')).toBe('true')
    press(trig); expect(trig.getAttribute('aria-expanded')).toBe('false')
  })
})
