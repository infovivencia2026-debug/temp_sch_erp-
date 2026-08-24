import { screen } from '@/lib/screen'
import { lazy } from 'react'

/* The transport office's live map.

   Kept out of registry.ts so this lands without several agents editing one
   object at once. Spread into FEATURE_COMPONENTS there.

   Both keys were checked against internal/catalog/catalog_gen.go before being
   written; a key the catalogue does not carry renders the placeholder
   silently.

   Two keys, one screen, deliberately. The catalogue lists "Live vehicle
   tracking" and "Real-time Vehicle Tracking (VTS)" separately because they
   came from two different requirement lists, but they are one question asked
   twice — where is the bus now — and splitting them would give the transport
   office two menu items that must never disagree. */
export const liveTrackingKeys = {
  'institution_admin.transport.live_vehicle_tracking': screen(() => import('./LiveVehicleMap')),
  'transport_manager.transport.real_time_vehicle_tracking_vts': lazy(
    () => import('./LiveVehicleMap'),
  ),
}
