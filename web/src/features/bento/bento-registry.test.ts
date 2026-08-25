import { describe, it, expect } from 'vitest'
import { BENTO_COMPONENTS } from './bento-registry'
import { FEATURE_BY_KEY } from '@/catalog.gen'

/* A Bento key that is not a catalogue key is a screen nobody will ever see.

   `bentoComponentFor` is an exact lookup with no aliasing, so a map entry keyed
   on something the catalogue does not contain matches no route and falls
   through to the classic screen — silently, and looking exactly like a screen
   that was never converted.

   That is not hypothetical. `parent.home.child_switcher` sat in this map for
   months with a comment above it asserting it was the parent's landing
   feature. It is not a key in catalog_gen.go or catalog.gen.ts, and ParentWeek
   — 839 lines of it — had never once rendered. The comment is what let it
   survive review: a wrong fact stated confidently beside the line it justified.

   Nothing but a test catches this. The type system cannot: both sides are
   strings. */
describe('the Bento registry', () => {
  it('keys every entry on a feature the catalogue actually has', () => {
    const known = FEATURE_BY_KEY
    const strays = Object.keys(BENTO_COMPONENTS).filter((k) => !known.has(k))
    expect(strays, 'these keys match no catalogue feature and can never render').toEqual([])
  })

  it('has entries to check at all', () => {
    // Guards the guard: an empty map would pass the test above vacuously.
    expect(Object.keys(BENTO_COMPONENTS).length).toBeGreaterThan(5)
  })
})
