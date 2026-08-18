import { lazy } from 'react'

/**
 * The messaging tier, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the components it names move together. Spread into FEATURE_COMPONENTS
 * there; scripts/gen_implemented.py reads registry.ts, so the server only
 * marks these live once the spread is in place.
 *
 * Both keys below were checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired, and simply
 * never appears.
 *
 * Two sibling keys are deliberately absent. sms_gateway_integration and
 * whatsapp_api_integration are catalogued and both channels already exist as
 * providers behind this foundation, but neither can be configured until a
 * vendor account exists — so pointing a screen at them would promise a form
 * that cannot yet be filled in. They appear on the Email Server screen as
 * unconfigured channels with the reason stated, which is the honest position
 * until procurement finishes.
 */
export const messagingKeys = {
  'super_admin.messaging.email_server_smtp_integration': lazy(() => import('./EmailServer')),
  'super_admin.messaging.automated_trigger_rules': lazy(() => import('./TriggerRules')),
}
