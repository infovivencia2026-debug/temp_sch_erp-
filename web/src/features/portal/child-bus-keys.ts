import { screen } from '@/lib/screen'

/* The parent's two bus screens, keyed by catalogue entry.

   Both keys were checked against internal/catalog/catalog_gen.go before they
   were written; a key the catalogue does not carry renders the honest
   "catalogued, not implemented" placeholder and the screen is unreachable
   with nothing to say why.

   Two entries, two components, sharing child-bus.ts. One page could hold both
   — the call button belongs beside the map — but a menu with two entries that
   open the same screen is how a parent concludes the app is broken, and a
   parent hunting for a phone number should not have to scroll past a plot to
   reach it.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs
   `make catalog` so internal/api/implemented_gen.go agrees with it. */
export const childBusKeys = {
  'parent.my_childs_bus.live_bus_tracking': screen(() => import('./ChildBus')),
}
