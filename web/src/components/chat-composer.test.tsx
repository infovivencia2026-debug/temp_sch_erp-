import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ChatThread, COMPOSER_PLACEHOLDER } from './Chat'

/* The owner (2026-10-24): the message box says "Message", never
   "Write to <person>", on phones and on the web. */
describe('chat composer placeholder', () => {
  it('is a short neutral word', () => {
    expect(COMPOSER_PLACEHOLDER).toBe('Message')
  })

  it('renders "Message" in the box, not "Write to …"', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<ChatThread messages={[]} onSend={() => {}} peerName="Asha Rao" />))
    const box = host.querySelector('textarea')!
    expect(box.placeholder).toBe('Message')
    expect(box.placeholder).not.toMatch(/^Write to/)
    act(() => root.unmount())
  })

  it('no messages screen passes a person-named placeholder', () => {
    for (const f of ['src/features/comms/StaffMessages.tsx', 'src/features/communication/AllMessages.tsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(/placeholder=\{`(Write|Reply) to \$\{/)
    }
  })
})
