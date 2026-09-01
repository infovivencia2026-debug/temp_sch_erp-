import { screen } from '@/lib/screen'

/* The school's own channel setup, and its attendance readers.

   Every integration feature in the catalogue was keyed super_admin.*, so a
   principal holding institution.integrations.write — the permission the save
   endpoint actually checks — had the right to configure their school's mail
   server and nowhere to do it.

   Four of these five keys open the same screen on different tabs. That is
   deliberate: a school choosing how to reach a family weighs cost against
   reach against whether the parent reads it, and that comparison is impossible
   across three separate menu entries. */
export const channelSetupKeys = {
  'institution_admin.channel_setup.message_channels': screen(() => import('./ChannelSetup')),
  'institution_admin.channel_setup.sender_identity': screen(() => import('./ChannelSetup')),
  'institution_admin.channel_setup.quiet_hours_sending_limits': screen(() => import('./ChannelSetup')),
  'institution_admin.channel_setup.who_we_may_message': screen(() => import('./ChannelSetup')),
  'institution_admin.attendance_devices.biometric_readers': screen(() => import('./BiometricReaders')),
}
