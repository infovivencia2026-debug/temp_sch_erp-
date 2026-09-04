import { screen } from '@/lib/screen'

/**
 * The driver's web workspace, keyed by catalogue feature.
 *
 * Small on purpose. The driver's real screen is the Android bus app — the
 * phone is the tracker, the pre-trip check and the roll happen there. On the
 * web a driver gets their run, their bus and route, and their own profile,
 * all read through /ops/transport/my-bus, which resolves the bus from the
 * caller's employee row and holds nothing about anybody else's.
 *
 * Spread into FEATURE_COMPONENTS in registry.ts; scripts/gen_implemented.py
 * reads the keys here. Keys checked against internal/catalog/catalog_gen.go.
 */
export const driverKeys = {
  'driver.home.my_run': screen(() =>
    import('../bento/DriverDay').then((m) => ({ default: m.Classic })),
  ),
  'driver.transport.my_bus_route': screen(() => import('./DriverRun')),
  'driver.my_profile.profile': screen(() => import('../shared/Profile')),
  'driver.my_profile.my_pay': screen(() => import('../me/MyPay')),
}
