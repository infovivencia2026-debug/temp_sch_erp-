import { screen } from '@/lib/screen'

/**
 * The Tally bridge, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the two components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Both keys below were checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired and simply
 * never appears.
 *
 * Two keys, two components, two scopes — and one feature. The connector is the
 * mapping: this ERP's chart of accounts against the ledger names that already
 * exist in the school's Tally company. The export is the accountant's screen
 * that produces the file. They are listed under different workspaces because
 * different people open them, but they share a backend (internal/api/tally.go)
 * and a renderer (internal/tally), and neither is any use without the other:
 * an export with nothing mapped produces a file Tally refuses, and a mapping
 * nobody exports is a form somebody filled in for nothing.
 */
export const tallyKeys = {
  // Platform Setup — Payments & Devices. The vendor sets this up with the
  // school, once, against the Tally company the auditor already reads.
  'super_admin.payments_devices.tally_erp_prime_connector': screen(() => import('./TallyConnector')),

  // Accounting — Export. The accountant's quarterly half hour.
  'finance.export.tally_prime_xml_export': screen(() => import('./TallyExport')),
}
