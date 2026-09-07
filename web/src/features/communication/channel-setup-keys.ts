import { screen } from '@/lib/screen'

/* The school's own channel setup, and its attendance readers.

   Every integration feature in the catalogue was keyed super_admin.*, so a
   principal holding institution.integrations.write — the permission the save
   endpoint actually checks — had the right to configure their school's mail
   server and nowhere to do it.

   Channel Setup is ONE key, not four. Sender Identity, Quiet Hours & Sending
   Limits and Who We May Message were catalogued as separate menu entries and
   all four opened this same screen -- two of them not even on their own tab,
   so three of the four names in the menu were a promise the screen did not
   keep. The tabs inside the screen are the real navigation, and the comparison
   a school is making -- cost against reach against whether the parent reads it
   -- only works on one page anyway. */
export const channelSetupKeys = {
  'institution_admin.channel_setup.message_channels': screen(() => import('./ChannelSetup')),
  'institution_admin.attendance_devices.biometric_readers': screen(() => import('./BiometricReaders')),

  /* WHERE THE PUNCHES ARE READ, BESIDE WHERE THEY ARRIVE.

     The readers had a screen and the register they feed did not -- not for the
     principal. staff_register is catalogued under the `hr` workspace only, and
     a head who does not also hold that role had no route to it: the fingerprint
     machine recorded every arrival and the person responsible for the school
     could not see a single one.

     Same components, second key. The screens are institution-scoped already and
     the endpoints behind them check their own rights, so this widens the menu
     rather than the person -- exactly as the Channel Setup keys above do for
     the mail server. */
  'institution_admin.attendance_devices.staff_attendance_register':
    screen(() => import('../hr/StaffAttendance')),
  'institution_admin.attendance_devices.staff_attendance_reports':
    screen(() => import('../analytics/HRReports')),
}
