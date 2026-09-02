import { screen } from '@/lib/screen'

/**
 * Tracker pairing and tracking policy, keyed by catalogue feature.
 *
 * Kept beside the screen rather than pasted into registry.ts so this module and
 * the component it names move together. Spread into FEATURE_COMPONENTS there.
 *
 * The key is the catalogue's own, and its wording deserves a note. It reads
 * "Configure bus GPS tracker hardware protocols, IMEI mapping, and refresh
 * intervals" — written when tracking meant buying fifty fleet units. There is
 * no hardware here and no IMEI to map: the tracker is the driver's own phone,
 * paired by a code, and the only part of that description this screen actually
 * delivers is the refresh interval. It is bound anyway so the feature is
 * reachable, and the screen says plainly what it is instead of pretending to a
 * device protocol it does not speak.
 */
export const trackerKeys = {
  'super_admin.payments_devices.gps_hardware_integration': screen(() => import('./TrackerPairing')),
  /* The same screen for the person who actually runs the buses.

     Pairing a driver's handset was reachable only from the vendor console, so
     the transport manager — who knows which driver is on which bus, and is
     standing next to the phone — had to ask somebody else to issue a code. */
  'transport_manager.transport.driver_phone_tracker': screen(() => import('./TrackerPairing')),
}
