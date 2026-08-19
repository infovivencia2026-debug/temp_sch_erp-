import { lazy } from 'react'

/**
 * The digital half of the library, keyed by catalogue feature.
 *
 * Kept beside the screen rather than pasted into registry.ts so the two move
 * together. Spread into FEATURE_COMPONENTS there; scripts/gen_implemented.py
 * reads registry.ts, so the server only marks this live once the spread is in
 * place.
 *
 * The key below was checked against internal/catalog/catalog_gen.go before
 * being written.
 *
 * The catalogue entry promises single sign-on to EBSCO and JSTOR. This
 * deployment holds neither subscription, so the screen does not pretend to:
 * the providers tab records what a school has and shows it as unconnected, and
 * opening a title behind one answers with a sentence rather than a broken
 * link. What the screen does deliver is everything that works without a
 * subscription — the school's own digital holdings, who may see each one, and
 * lending for the e-books licensed a single reader at a time.
 *
 * Reads /api/v1/ops/digital-library/*, which mountDigitalLibrary registers
 * beside the physical desk. Lending is the physical desk's: a single-copy
 * e-book carries a shadow row in the book catalogue and the existing hold
 * queue owns it, so this screen places a hold and never invents a due date.
 */
export const digitalLibraryKeys = {
  'institution_admin.library.digital_e_book_journal_integration': lazy(
    () => import('./DigitalLibrary'),
  ),
}
