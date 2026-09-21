import { describe, expect, it } from 'vitest'
import { buildUpiIntent, isValidVpa, upiAmount, upiNote } from './upi'

describe('isValidVpa', () => {
  it('accepts the shapes banks issue', () => {
    for (const v of ['kalyan.qb@axl', 'school@sbi', 'vhs-fees_2026@okhdfcbank', '9876543210@ybl', ' school@sbi ']) {
      expect(isValidVpa(v), v).toBe(true)
    }
  })
  it('refuses what is not an address', () => {
    for (const v of ['', 'school', '@sbi', 'school@', 'sc@sbi', 'school @sbi', 'school@sbi@axl', 'school@sbi.co', 'school%40sbi']) {
      expect(isValidVpa(v), v).toBe(false)
    }
  })
})

describe('buildUpiIntent', () => {
  /* The example pinned on both sides: internal/fees/upi_test.go builds the
     same intent from the same inputs and expects the same string. */
  it('encodes as a URI, not a form', () => {
    const uri = buildUpiIntent({
      vpa: 'kalyan.qb@axl',
      payeeName: 'Vivencia High School',
      amountPaise: 1183300,
      note: 'Fee 2026/0142 INV-7',
    })
    expect(uri).toBe(
      'upi://pay?pa=kalyan.qb@axl&pn=Vivencia%20High%20School&am=11833.00&cu=INR&tn=Fee%202026%2F0142%20INV-7',
    )
    expect(uri).not.toContain('+')
    expect(uri).not.toContain('%40')
  })

  it('omits an empty note', () => {
    expect(buildUpiIntent({ vpa: 'school@sbi', payeeName: 'S', amountPaise: 100, note: '  ' })).not.toContain('tn=')
    expect(buildUpiIntent({ vpa: 'school@sbi', payeeName: 'S', amountPaise: 100 })).not.toContain('tn=')
  })

  it('clips the name and note to the specification limits, by character', () => {
    const uri = buildUpiIntent({
      vpa: 'school@sbi',
      payeeName: 'x'.repeat(120),
      amountPaise: 100,
      note: 'క'.repeat(60),
    })
    expect(uri).toContain(`pn=${'x'.repeat(99)}&`)
    expect(uri.slice(uri.indexOf('&tn=') + 4)).toBe('%E0%B0%95'.repeat(50))
  })
})

describe('upiAmount', () => {
  it('writes paise as two-place rupees with no grouping', () => {
    expect(upiAmount(0)).toBe('0.00')
    expect(upiAmount(1)).toBe('0.01')
    expect(upiAmount(150)).toBe('1.50')
    expect(upiAmount(1183300)).toBe('11833.00')
    expect(upiAmount(10000000)).toBe('100000.00')
  })
})

describe('upiNote', () => {
  it('joins parts, drops what an app may refuse, and clips to 50', () => {
    expect(upiNote('Fee', 'ADM/2026/0142', undefined, '', 'INV-7')).toBe('Fee ADM/2026/0142 INV-7')
    expect(upiNote('Fee', 'Term 1 (Q3) & books!')).toBe('Fee Term 1 Q3 books')
    expect(upiNote('రవి కుమార్', 'ADM-1')).toBe('రవి కుమార్ ADM-1')
    expect(Array.from(upiNote('Fee', 'y'.repeat(80))).length).toBe(50)
  })
})
