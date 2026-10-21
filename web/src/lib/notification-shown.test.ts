import { describe, expect, it } from 'vitest'
import { noteShown, pendingFirst, statusPostIdOf } from './notification-shown'

const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
describe('notification-shown', () => {
  it('reads the post id from a status link', () => {
    expect(statusPostIdOf({ kind: 'status', link: `/?status=${id.toUpperCase()}` })).toBe(id)
    expect(statusPostIdOf({ kind: 'homework', link: `/?status=${id}` })).toBeNull()
  })
  it('hides a status whose post is no longer in the feed', () => {
    const n = { kind: 'status', link: `/?status=${id}` }
    expect(noteShown(n, null)).toBe(true)
    expect(noteShown(n, new Set([id]))).toBe(true)
    expect(noteShown(n, new Set())).toBe(false)
    expect(noteShown({ kind: 'fee_due' }, new Set())).toBe(true)
  })
  it('puts pending work first, keeping order otherwise', () => {
    const r = pendingFirst([{ kind: 'a' }, { kind: 'b', pending: true }, { kind: 'c' }])
    expect(r.map((x) => x.kind)).toEqual(['b', 'a', 'c'])
  })
})
