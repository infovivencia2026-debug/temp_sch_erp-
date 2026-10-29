import { describe, expect, it } from 'vitest'
import { dropFromFeed, noteShown, pendingFirst, statusPostIdOf } from './notification-shown'

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

describe('dropFromFeed (opened is gone at once)', () => {
  const feed = {
    unread: 2,
    items: [
      { id: 'a', kind: 'staff_message' },
      { id: 'b', kind: 'leave_request', pending: true },
      { id: 'c', kind: 'homework', read_at: '2026-10-24T08:00:00Z' },
    ],
  }
  it('removes an ordinary row and its unread count', () => {
    const r = dropFromFeed(feed, 'a')!
    expect(r.items!.map((n) => n.id)).toEqual(['b', 'c'])
    expect(r.unread).toBe(1)
  })
  it('keeps pending work, read, until it is done', () => {
    const r = dropFromFeed(feed, 'b', 'now')!
    expect(r.items!.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(r.items![1].read_at).toBe('now')
    expect(r.unread).toBe(1)
  })
  it('leaves the count alone for a row already read, and ignores an unknown id', () => {
    expect(dropFromFeed(feed, 'c')!.unread).toBe(2)
    expect(dropFromFeed(feed, 'zz')).toBe(feed)
  })
})
