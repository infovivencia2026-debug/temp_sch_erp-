import { describe, expect, it } from 'vitest'
import { dedupePlaced } from './widgets'

describe('dedupePlaced', () => {
  it('keeps one entry per id, the first', () => {
    const out = dedupePlaced([
      { id: 'pulse', w: 2, h: 2 },
      { id: 'metric:attendance.students', w: 1, h: 1 },
      { id: 'pulse', w: 1, h: 1 },
    ])
    expect(out).toEqual([
      { id: 'pulse', w: 2, h: 2 },
      { id: 'metric:attendance.students', w: 1, h: 1 },
    ])
  })
})
