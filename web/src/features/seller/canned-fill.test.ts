import { describe, it, expect } from 'vitest'
import { fillCanned, screenLabel } from './canned-fill'

describe('canned replies name real screens', () => {
  it('resolves a section.feature id from the catalogue the menu is built from', () => {
    expect(screenLabel('fees.fee_dashboard')).toBe('Fees → Fee Dashboard')
    expect(screenLabel('institution_admin.fees.fee_default')).toBe('Fees → Fee Default')
    expect(screenLabel('fees.no_such_screen')).toBeNull()
    expect(screenLabel('nonsense')).toBeNull()
  })

  it('fills the people and the screens, and leaves an unknown screen for the sender to see', () => {
    const out = fillCanned('Hello {{name}}, open {{screen:fees.fee_dashboard}} at {{school}}. {{screen:fees.gone}} -- {{agent}}',
      { raised_by: 'Meena Rao', school: 'Test School' }, 'Asha')
    expect(out).toBe('Hello Meena, open Fees → Fee Dashboard at Test School. {{screen:fees.gone}} -- Asha')
  })
})
