import { describe, expect, it } from 'vitest'
import { growHeight } from './auto-grow'

const m = { lineHeight: 20, padding: 16, border: 2, boxSizing: 'border-box' as const }

describe('growHeight', () => {
  it('holds the minimum rows for an empty box', () => {
    // scrollHeight of an empty box is one line plus the padding
    expect(growHeight({ ...m, scrollHeight: 36 }, { minRows: 3, maxRows: 10 })).toEqual({ height: 3 * 20 + 18, overflow: false })
  })
  it('follows the content line by line between the bounds', () => {
    expect(growHeight({ ...m, scrollHeight: 5 * 20 + 16 }, { minRows: 2, maxRows: 10 })).toEqual({ height: 5 * 20 + 18, overflow: false })
  })
  it('stops at the maximum rows and scrolls inside', () => {
    expect(growHeight({ ...m, scrollHeight: 30 * 20 + 16 }, { minRows: 2, maxRows: 10 })).toEqual({ height: 10 * 20 + 18, overflow: true })
  })
  it('content-box sets the content height alone', () => {
    expect(growHeight({ ...m, boxSizing: 'content-box', scrollHeight: 4 * 20 + 16 }, { minRows: 2, maxRows: 10 })).toEqual({ height: 80, overflow: false })
  })
  it('a minimum above the maximum collapses to the maximum, never below one row', () => {
    expect(growHeight({ ...m, scrollHeight: 36 }, { minRows: 12, maxRows: 4 }).height).toBe(4 * 20 + 18)
    expect(growHeight({ ...m, scrollHeight: 36 }, { minRows: 0, maxRows: 0 }).height).toBe(1 * 20 + 18)
  })
  it('defaults to two rows up to ten', () => {
    expect(growHeight({ ...m, scrollHeight: 0 }).height).toBe(2 * 20 + 18)
    expect(growHeight({ ...m, scrollHeight: 10_000 })).toEqual({ height: 10 * 20 + 18, overflow: true })
  })
})
