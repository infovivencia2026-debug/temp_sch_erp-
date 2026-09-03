import { screen } from '@/lib/screen'

/**
 * The readers and the rule they feed, on HR's own menu.
 *
 * The device register is the principal's screen served to HR unchanged — the
 * routes behind it are gated on hr.employees.*, which is what HR holds. The
 * grace window is its own screen: the same four columns the leave rules keep,
 * with the punches the setting would mark late.
 *
 * Spread into FEATURE_COMPONENTS in registry.ts; keys checked against
 * internal/catalog/catalog_gen.go.
 */
export const attendanceDevicesKeys = {
  'hr.attendance.biometric_machine_attendance_sync': screen(() => import('../communication/BiometricReaders')),
  'hr.attendance.biometric_punch_in_out_grace_period': screen(() => import('./PunchGrace')),
}
