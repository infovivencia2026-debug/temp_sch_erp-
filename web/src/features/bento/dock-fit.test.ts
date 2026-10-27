import { describe, expect, it } from 'vitest'
import { dockRoom, marksShown } from './BentoDock'

/* Fixed parts of the desktop dock (home, search pill, All features, bell,
   rules, padding) measured at about 520px in the browser. */
const FIXED = 520
const MARK = 42

describe('dock marks fit the width', () => {
  for (const w of [1280, 1366, 1920]) {
    it(`shows all 8 marks at ${w}`, () => {
      expect(marksShown(8, dockRoom(w, FIXED))).toBe(8)
    })
  }
  it('folds some at 768 and the rest (with +N) fits the room', () => {
    const room = dockRoom(768, FIXED)
    const shown = marksShown(8, room)
    expect(shown).toBeLessThan(8)
    expect(shown * MARK + 40).toBeLessThanOrEqual(room)
  })
  it('shows everything before it is measured', () => {
    expect(marksShown(8, null)).toBe(8)
  })
})
