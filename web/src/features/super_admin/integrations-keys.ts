import { screen } from '@/lib/screen'

/**
 * The integrations index, keyed by catalogue feature.
 *
 * Kept beside the screen rather than pasted into registry.ts so this module and
 * the component it names move together. Spread into FEATURE_COMPONENTS there;
 * scripts/gen_implemented.py reads registry.ts, so the server only marks this
 * live once the spread is in place, and `make catalog` must be run after.
 *
 * The key below was checked against internal/catalog/catalog_gen.go (line 186)
 * and web/src/catalog.gen.ts before being written. A key the catalogue does not
 * carry renders the placeholder instead of the screen, silently — the screen is
 * built, wired, and simply never appears.
 *
 * One caveat the integrator should know rather than discover. The catalogue's
 * summary for this feature reads "Configure payment gateway, email/SMS/WhatsApp,
 * biometric devices, Google/Microsoft and other connectors." The screen is an
 * index over the connectors that exist, and it does not configure anything —
 * each row links to the screen that does. The payment gateway keys and the
 * reader fleet have screens of their own in the same section (connectors-keys)
 * and are not rows here: the first is a record with no checkout behind it,
 * the second is read-only and school-owned, and neither has a health to show.
 */
export const integrationsKeys = {
  // Platform Setup — Platform Configuration. Read-only; every row links out to
  // the screen that owns that connector's credentials.
  'super_admin.platform_configuration.integrations': screen(() => import('./Integrations')),
}
