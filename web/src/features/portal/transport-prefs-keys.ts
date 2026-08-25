import { lazy } from 'react'

/* The parent's transport snapshot and the two settings that go with it.

   All three keys were checked against internal/catalog/catalog_gen.go before
   they were written; a key the catalogue does not carry renders the honest
   "catalogued, not implemented" placeholder, and the screen behind it is
   unreachable with nothing saying why.

   Three keys, three components, on purpose. The two preferences are one row
   and one endpoint server-side, but they are two catalogue entries in the
   parent's menu, and a menu with two entries that open the same screen is how
   a family concludes the app is broken. They share transport-prefs.ts, which
   is where the rule that both values travel on every save lives.

   Merged into web/src/features/registry.ts by the integrator, who does not
   let this agent edit that file; `make catalog` afterwards keeps
   internal/api/implemented_gen.go agreeing with it. */
export const transportPrefsKeys = {
  'parent.alerts_preferences.parent_app_live_bus_tracking_refresh_rate_customizer': lazy(
    () => import('./BusRefreshRate'),
  ),
  'parent.alerts_preferences.parent_bus_proximity_radius_customizer': lazy(
    () => import('./BusProximityAlert'),
  ),
}
