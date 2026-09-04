import { screen } from '@/lib/screen'

/**
 * The operations clerk's workspace, keyed by catalogue feature.
 *
 * The role reads and writes stores, transport, library and hostel and had no
 * catalogue of its own, so it landed nowhere useful. These keys reach the
 * screens the principal, librarian and transport manager already open; each
 * calls only /ops/* routes gated on keys operations holds.
 *
 * Spread into FEATURE_COMPONENTS in registry.ts; scripts/gen_implemented.py
 * reads the keys here. Keys checked against internal/catalog/catalog_gen.go.
 */
export const operationsKeys = {
  'operations.home.operations_desk': screen(() =>
    import('../bento/OpsDesk').then((m) => ({ default: m.Classic })),
  ),
  'operations.stores.stock_movements': screen(() => import('./Stores')),
  'operations.transport.vehicles_routes': screen(() => import('./Transport')),
  'operations.transport.transport_office': screen(() => import('./TransportOffice')),
  'operations.library.issue_return': screen(() => import('./Library')),
  'operations.hostel.hostel_rooms': screen(() => import('./Hostel')),
  'operations.my_profile.profile': screen(() => import('../shared/Profile')),
  'operations.my_profile.my_pay': screen(() => import('../me/MyPay')),
}
