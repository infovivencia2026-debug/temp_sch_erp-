import { describe, expect, it } from 'vitest'
import { packPhone, PHONE_GRID_COLS } from './widgets'

const icons = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, kind: 'icon' as const }))

describe('packPhone', () => {
  it('lays the rhythm: two small, a row of icons, one big, a row of icons', () => {
    const s = packPhone(
      [{ id: 's1', kind: 'small' }, { id: 's2', kind: 'small' }, { id: 'b1', kind: 'big' }, ...icons(8)],
      4,
      true,
    )
    const at = Object.fromEntries(s.map((x) => [x.id, x]))
    expect([at.s1.row, at.s1.col, at.s1.w, at.s2.col]).toEqual([0, 0, 6, 6])
    expect(['i0', 'i1', 'i2', 'i3'].map((k) => [at[k].row, at[k].w])).toEqual([[2, 3], [2, 3], [2, 3], [2, 3]])
    expect([at.b1.row, at.b1.w, at.b1.h]).toEqual([3, PHONE_GRID_COLS, 2])
    expect(at.i4.row).toBe(5)
    expect(s.every((x) => x.page === 0)).toBe(true)
  })
  it('every icon is its own unit, three a row when asked', () => {
    const s = packPhone(icons(6), 3, true)
    expect(s.map((x) => x.w)).toEqual([4, 4, 4, 4, 4, 4])
    expect(s.map((x) => x.row)).toEqual([0, 0, 0, 1, 1, 1])
  })
  it('turns the page when a beat does not fit', () => {
    const s = packPhone([{ id: 'a', kind: 'big' }, { id: 'b', kind: 'big' }, { id: 'c', kind: 'big' }, { id: 'd', kind: 'big' }], 4, false)
    expect(s.map((x) => x.page)).toEqual([0, 0, 0, 1])
  })
})
