import { screen } from '@/lib/screen'
import { lazy } from 'react'

/**
 * The two platform connectors, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the components it names move together. Spread into FEATURE_COMPONENTS
 * there; scripts/gen_implemented.py reads registry.ts, so the server only marks
 * these live once the spread is in place.
 *
 * Both keys below were checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired, and simply
 * never appears.
 *
 * What the two have in common is what shaped them: neither far end exists on
 * this deployment. There is no CRM API key and no meeting provider credential,
 * so each screen says so in a card fed by the server rather than by a constant
 * here, and each offers the route that does work — a CSV the school carries to
 * the CRM's own bulk import, and the join link a teacher pastes.
 */
export const connectorsKeys = {
  // Platform Setup — Payments & Devices. The admissions CRM bridge.
  'super_admin.payments_devices.meritto_leadsquared_sync': screen(() => import('./CrmSync')),

  // Platform Setup — Payments & Devices. The platform half of a live-class
  // model that already exists (virtual_class_sessions, and the faculty
  // launcher over it).
  'super_admin.payments_devices.virtual_classroom_integration': lazy(
    () => import('./VirtualClassroom'),
  ),

  // Platform Setup — Payments & Devices. Merchant keys per school, sealed;
  // a record for the day a checkout is wired, said so by the server.
  'super_admin.payments_devices.payment_gateway_connectors': screen(() => import('./PaymentGateways')),

  // Platform Setup — Payments & Devices. Every school's ADMS readers on one
  // page, read-only; a reader is registered inside its school.
  'super_admin.payments_devices.biometric_device_integration': screen(() => import('./BiometricFleet')),
}
