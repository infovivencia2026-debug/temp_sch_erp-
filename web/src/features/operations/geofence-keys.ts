import { screen } from '@/lib/screen'

/* Geo-fenced bus stop alerts, for the transport office.

   Kept out of registry.ts so this lands without several agents editing one
   object at once. Spread into FEATURE_COMPONENTS there.

   The key was checked against internal/catalog/catalog_gen.go before being
   written; a key the catalogue does not carry renders the placeholder
   silently. */
export const geofenceKeys = {
  'transport_manager.transport.geo_fenced_bus_stop_alerts': screen(() => import('./StopAlerts')),
}
