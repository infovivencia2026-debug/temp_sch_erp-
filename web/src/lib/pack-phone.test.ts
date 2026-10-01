import { describe, expect, it } from 'vitest'
import {
  packPhone, pageCount, phoneKindOf, PHONE_GRID_COLS, PHONE_GRID_ROWS, PHONE_KIND_DIMS,
  type PhoneKind, type Spot,
} from './widgets'
import { PHONE_TIERS, dimsForTier } from './size-tiers'
import { migratePhoneIcons } from './appearance'

/* THE PHONE PAGE: four columns by five rows, and nothing on it that is not
   one of the owner's sizes (rows x cols): cards 2x2, 2x4, 4x4 (and the
   4x2 Tall the picker still offers), app icons 1x1 or 1x2. */

type Item = { id: string; kind: PhoneKind }
const icons = (n: number, from = 0): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${from + i}`, kind: 'icon' as const }))
const card = (id: string, kind: PhoneKind): Item => ({ id, kind })
const byId = (s: Spot[]) => Object.fromEntries(s.map((x) => [x.id, x]))

/** rows x cols, as the owner writes a size. */
const shape = (x: Spot) => `${x.h}x${x.w}`
const ALLOWED_CARDS = new Set(['2x2', '2x4', '4x4', '4x2'])

/** Every cell at most once, and every item inside its page. */
function check(spots: Spot[]) {
  const seen = new Set<string>()
  for (const s of spots) {
    expect(s.col, `${s.id} col`).toBeGreaterThanOrEqual(0)
    expect(s.row, `${s.id} row`).toBeGreaterThanOrEqual(0)
    expect(s.col + s.w, `${s.id} overflows the columns`).toBeLessThanOrEqual(PHONE_GRID_COLS)
    expect(s.row + s.h, `${s.id} overflows the rows`).toBeLessThanOrEqual(PHONE_GRID_ROWS)
    for (let y = s.row; y < s.row + s.h; y++) {
      for (let x = s.col; x < s.col + s.w; x++) {
        const k = `${s.page}:${y}:${x}`
        expect(seen.has(k), `${s.id} overlaps at ${k}`).toBe(false)
        seen.add(k)
      }
    }
  }
  return seen
}

describe('the phone grid', () => {
  it('is four columns by five rows', () => {
    expect([PHONE_GRID_COLS, PHONE_GRID_ROWS]).toEqual([4, 5])
  })

  it('draws only the allowed sizes: cards 2x2, 2x4, 4x4, icons 1x1 or 1x2', () => {
    const d = (k: PhoneKind) => `${PHONE_KIND_DIMS[k].h}x${PHONE_KIND_DIMS[k].w}`
    expect(d('small')).toBe('2x2')
    expect(d('big')).toBe('2x4')
    expect(d('large')).toBe('4x4')
    expect(d('icon')).toBe('1x1')
    expect(d('icon2')).toBe('1x2')
    const all: Item[] = [
      card('s', 'small'), card('b', 'big'), card('l', 'large'), ...icons(5),
    ]
    for (const rhythm of [true, false]) {
      for (const span of [1, 2]) {
        for (const s of packPhone(all, span, rhythm)) {
          if (s.id.startsWith('i')) expect(shape(s)).toBe(span === 2 ? '1x2' : '1x1')
          else expect(ALLOWED_CARDS.has(shape(s)), `${s.id} is ${shape(s)}`).toBe(true)
        }
      }
    }
  })

  it('every tier the phone picker offers is stored as a shape that draws at an allowed size', () => {
    const drawn = PHONE_TIERS.map((tier) => {
      const k = phoneKindOf(dimsForTier(tier, true))
      return `${tier}:${PHONE_KIND_DIMS[k].h}x${PHONE_KIND_DIMS[k].w}`
    })
    expect(drawn).toEqual(['small:2x2', 'medium:2x4', 'large:4x4'])
  })
})

describe('tier mapping: every stored (desk) shape reads as a phone size', () => {
  const kind = (w: number, h: number) => phoneKindOf({ w, h })
  it('a figure (1x1) is the small card, 2x2', () => {
    expect(kind(1, 1)).toBe('small')
  })
  it('graphs and wide strips (2x1, 3x1, 5x1) are the wide card, 2x4', () => {
    expect([kind(2, 1), kind(3, 1), kind(5, 1)]).toEqual(['big', 'big', 'big'])
  })
  it('big cards and tables (2x2, 3x2, 4x2) are the large card, 4x4', () => {
    expect([kind(2, 2), kind(3, 2), kind(4, 2), kind(2, 3)]).toEqual(['large', 'large', 'large', 'large'])
  })
  it('the desk Tall (1x2) is the large card on a phone: there is no phone Tall', () => {
    expect(kind(1, 2)).toBe('large')
  })
  it('a shape that is not a number is a figure rather than a crash', () => {
    expect(kind(NaN, NaN)).toBe('small')
  })
  it('an app icon is an icon whatever shape is stored, at the size chosen', () => {
    expect(phoneKindOf({ w: 2, h: 2 }, true)).toBe('icon')
    expect(phoneKindOf({ w: 1, h: 1 }, true, 2)).toBe('icon2')
  })
})

describe('packPhone', () => {
  it('lays the default rhythm on the grid: two small, a row of icons, a wide card', () => {
    const s = packPhone(
      [card('s1', 'small'), card('s2', 'small'), card('b1', 'big'), ...icons(8)],
      1,
      true,
    )
    check(s)
    const at = byId(s)
    expect([at.s1.page, at.s1.row, at.s1.col, at.s2.row, at.s2.col]).toEqual([0, 0, 0, 0, 2])
    expect(['i0', 'i1', 'i2', 'i3'].map((k) => [at[k].page, at[k].row, at[k].col])).toEqual(
      [[0, 2, 0], [0, 2, 1], [0, 2, 2], [0, 2, 3]],
    )
    expect([at.b1.page, at.b1.row, at.b1.col, shape(at.b1)]).toEqual([0, 3, 0, '2x4'])
    // The page is full (2 + 1 + 2 rows): the second icon row opens page two.
    expect(['i4', 'i5', 'i6', 'i7'].map((k) => [at[k].page, at[k].row])).toEqual([[1, 0], [1, 0], [1, 0], [1, 0]])
    expect(pageCount(s)).toBe(2)
  })

  it('never overlaps and never overflows, for any mix, order and icon size', () => {
    const kinds: PhoneKind[] = ['small', 'big', 'large', 'icon']
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(rnd() * 24)
      const items: Item[] = Array.from({ length: n }, (_, i) => ({
        id: `${run}-${i}`, kind: kinds[Math.floor(rnd() * kinds.length)],
      }))
      for (const rhythm of [true, false]) {
        for (const span of [1, 2]) {
          const s = packPhone(items, span, rhythm)
          expect(s.length).toBe(items.length)
          expect(new Set(s.map((x) => x.id)).size).toBe(items.length)
          check(s)
        }
      }
    }
  })

  it('an item that does not fit the page moves to the next', () => {
    // 2 + 4 rows is more than five: the large card opens page two.
    const s = packPhone([card('s', 'small'), card('l', 'large')], 1, false)
    const at = byId(s)
    expect([at.s.page, at.l.page, at.l.row]).toEqual([0, 1, 0])
    // Three wide cards are six rows: the third is on page two.
    expect(packPhone([card('a', 'big'), card('b', 'big'), card('c', 'big')], 1, false).map((x) => x.page))
      .toEqual([0, 0, 1])
    // Two large cards never share a page.
    expect(packPhone([card('a', 'large'), card('b', 'large')], 1, true).map((x) => x.page)).toEqual([0, 1])
  })

  it('later 1x1 icons back-fill the holes an earlier page was left with', () => {
    // A small card, then a large one (page two), then six icons: the icons
    // go back beside and under the small card instead of trailing on page two.
    const s = packPhone([card('s', 'small'), card('l', 'large'), ...icons(6)], 1, false)
    check(s)
    const at = byId(s)
    expect(at.l.page).toBe(1)
    expect(['i0', 'i1', 'i2', 'i3', 'i4', 'i5'].map((k) => [at[k].page, at[k].row, at[k].col])).toEqual([
      [0, 0, 2], [0, 0, 3], [0, 1, 2], [0, 1, 3], [0, 2, 0], [0, 2, 1],
    ])
  })

  it('with enough icons a page has no gap at all', () => {
    const s = packPhone([card('s', 'small'), card('b', 'big'), card('l', 'large'), ...icons(12)], 1, false)
    const cells = check(s)
    const onPageOne = [...cells].filter((k) => k.startsWith('0:')).length
    expect(onPageOne).toBe(PHONE_GRID_COLS * PHONE_GRID_ROWS)
    // Page two: the large card and the row under it.
    expect([...cells].filter((k) => k.startsWith('1:')).length).toBe(PHONE_GRID_COLS * PHONE_GRID_ROWS)
  })

  it('a card keeps its place in a person\'s order: it never goes back past the card before it', () => {
    // small, large (page two), small: the last small follows the large one
    // rather than jumping back to page one in front of it.
    const s = packPhone([card('a', 'small'), card('l', 'large'), card('b', 'small')], 1, false)
    const at = byId(s)
    expect([at.a.page, at.l.page]).toEqual([0, 1])
    expect(at.b.page).toBeGreaterThanOrEqual(at.l.page)
    check(s)
  })

  it('on a board nobody arranged, a card may take the first page with room', () => {
    const s = packPhone([card('a', 'small'), card('l', 'large'), card('b', 'small')], 1, true)
    const at = byId(s)
    expect([at.a.page, at.b.page, at.l.page]).toEqual([0, 0, 1])
  })

  it('Large icons are 1x2: two to a row, each its own unit', () => {
    const s = packPhone(icons(6), 2, true)
    check(s)
    expect(s.map(shape)).toEqual(['1x2', '1x2', '1x2', '1x2', '1x2', '1x2'])
    expect(s.map((x) => [x.row, x.col])).toEqual([[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]])
  })

  it('Normal icons are 1x1: four to a row', () => {
    const s = packPhone(icons(6), 1, true)
    expect(s.map(shape)).toEqual(['1x1', '1x1', '1x1', '1x1', '1x1', '1x1'])
    expect(s.map((x) => [x.row, x.col])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1]])
  })

  it('nothing is stretched: a lone small card stays 2x2', () => {
    const s = packPhone([card('s', 'small')], 1, true)
    expect([shape(s[0]), s[0].row, s[0].col]).toEqual(['2x2', 0, 0])
  })

  it('no widgets is no pages', () => {
    expect(pageCount(packPhone([], 1, true))).toBe(0)
  })
})

describe('"icons per row" becomes "icon size"', () => {
  it('four a row was the small icon: Normal', () => {
    expect(migratePhoneIcons('4')).toBe('normal')
  })
  it('three a row was the bigger icon: Large', () => {
    expect(migratePhoneIcons('3')).toBe('large')
  })
  it('reads the JSON spelling too', () => {
    expect(migratePhoneIcons('"3"')).toBe('large')
  })
  it('nothing stored, or anything else, is left to the default', () => {
    expect(migratePhoneIcons(null)).toBeNull()
    expect(migratePhoneIcons(undefined)).toBeNull()
    expect(migratePhoneIcons('5')).toBeNull()
  })
})

describe('the stored setting is migrated on read', () => {
  const load = async (seed: Record<string, string>) => {
    localStorage.clear()
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
    const { vi } = await import('vitest')
    vi.resetModules()
    return (await import('./appearance')).getAppearance().phoneIconSize
  }
  it('defaults to Normal', async () => {
    expect(await load({})).toBe('normal')
  })
  it('an old "3" comes back as Large, an old "4" as Normal', async () => {
    expect(await load({ 'erp.phoneIcons': '3' })).toBe('large')
    expect(await load({ 'erp.phoneIcons': '4' })).toBe('normal')
  })
  it('a choice made since outranks the old key', async () => {
    expect(await load({ 'erp.phoneIcons': '3', 'erp.phoneIconSize': 'normal' })).toBe('normal')
  })
})
