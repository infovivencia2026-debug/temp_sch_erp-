import ReminderPlans from './ReminderPlans'

/**
 * faculty.attendance.absence_alert_to_guardian
 *
 * The other binding of ReminderPlans. See FeeReminders.tsx for why there is
 * one implementation and two entry points.
 */
export default function AbsenceAlerts() {
  return <ReminderPlans kind="absence_alert" />
}
