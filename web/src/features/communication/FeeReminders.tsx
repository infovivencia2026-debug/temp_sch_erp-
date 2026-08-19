import ReminderPlans from './ReminderPlans'

/**
 * finance.student_dues.automated_fee_reminders
 *
 * A thin binding rather than a screen of its own. The fee chase and the
 * absence alert differ in their nouns and in three form fields; everything
 * that matters — the dry run, the reason a plan is not sending, the stop
 * conditions printed beside it — is one implementation in ReminderPlans, so
 * neither screen can grow a bug the other does not have.
 */
export default function FeeReminders() {
  return <ReminderPlans kind="fee_reminder" />
}
