import { screen } from '@/lib/screen'

/**
 * The librarian's yearly and monthly questions, keyed by catalogue feature.
 *
 * Spread into FEATURE_COMPONENTS in registry.ts; scripts/gen_implemented.py
 * reads the spread, so the server marks these live only once it is in place.
 * Keys checked against internal/catalog/catalog_gen.go.
 *
 * The stock audit and the textbook indent are tabs of the desk the principal
 * already opens; the desk reads the feature slug and opens on the right tab.
 * Fines and digital usage are their own screens: the first is two totals and
 * a list to work through, the second is a count nothing kept until now.
 */
export const libraryYearKeys = {
  'librarian.library.fine_penalty_summary': screen(() => import('./LibraryFines')),
  'librarian.library.digital_library_usage': screen(() => import('./DigitalUsage')),
  'librarian.library.annual_book_stock_verification': screen(() => import('./LibraryDesk')),
  'librarian.library.new_session_textbook_orders': screen(() => import('./LibraryDesk')),
}
