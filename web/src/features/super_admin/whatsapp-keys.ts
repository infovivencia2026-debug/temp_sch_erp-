import { lazy } from 'react'

/**
 * WhatsApp API Integration, keyed by catalogue feature.
 *
 * Kept beside the screen rather than pasted into registry.ts so this module and
 * the component it names move together. Spread into FEATURE_COMPONENTS there;
 * scripts/gen_implemented.py reads registry.ts, so the server only marks this
 * live once the spread is in place.
 *
 * The key below was checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently.
 *
 * messaging-keys.ts leaves this key deliberately absent, on the grounds that
 * WhatsApp could not be configured until a vendor account existed. It now can:
 * the school has a real WhatsApp Business account, and the screen this key
 * points at is where its phone number id, its System User token and its
 * approved template mapping are entered. That file's comment about this key
 * is now out of date and is the integrator's to trim.
 */
export const whatsappKeys = {
  'super_admin.messaging.whatsapp_api_integration': lazy(() => import('./WhatsAppApi')),
}
