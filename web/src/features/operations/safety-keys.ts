import { lazy } from 'react'

/* The transport office's alert queue.

   Kept out of registry.ts so this lands without several agents editing one
   object at once. Spread into FEATURE_COMPONENTS there.

   The key was checked against internal/catalog/catalog_gen.go before being
   written; a key the catalogue does not carry renders the placeholder
   silently. */
export const safetyKeys = {
  'institution_admin.transport.bus_speeding_rash_driving_alerts': lazy(
    () => import('./SafetyAlerts'),
  ),
}
