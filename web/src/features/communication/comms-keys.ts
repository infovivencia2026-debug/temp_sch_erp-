import { lazy } from 'react'

/**
 * The four communication screens, keyed by catalogue feature, plus the
 * TanStack query keys they share.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go at the
 * head this was written on (lines 399, 400, 1241, 1251). A key the catalogue
 * does not carry renders the "catalogued, not implemented" placeholder instead
 * of the screen, silently — the screen is built, wired, and never appears.
 *
 * Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
 * agent does not own; the integration lead splices in the import and the
 * `...commsKeys` spread and runs `make catalog` so internal/api/implemented_gen.go
 * agrees with it.
 *
 * Four keys, four screens, no sharing. Note that none of the sibling keys in
 * these groups are claimed here: institution_admin.communication also carries
 * circulars and notice-board keys that registry.ts already binds, and
 * re-declaring one would be a duplicate the spread silently overrides in
 * whichever order the integrator happened to write.
 */
export const commsKeys = {
  /* Staff to staff, for the roles that had no way to write to anybody.
     A librarian, an accountant, the nurse, the warden, HR, transport — every
     one of them can be written to and none of them had a screen to write
     from, so asking a class teacher anything meant leaving the product. The
     endpoint never gated on a permission (any non-family account may message
     any other), so this is a door onto a room that was already there. */
  'activity_coord.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'counsellor.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'discipline_officer.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'exam_controller.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'finance.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'hostel_warden.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'hr.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'it_admin.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'librarian.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'nurse.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'operations.communication.messages': lazy(() => import('../comms/StaffMessages')),
  'transport_manager.communication.messages': lazy(() => import('../comms/StaffMessages')),

  // The principal's desk over every channel — see AllMessages.tsx.
  'institution_admin.communication.all_messages': lazy(() => import('./AllMessages')),
  'institution_admin.communication.grievances': lazy(
    () => import('./GrievanceHub'),
  ),
  'institution_admin.communication.school_achievements_showcase': lazy(
    () => import('./AchievementsShowcase'),
  ),
}

/**
 * Query keys for the four screens.
 *
 * Namespaced under 'comms' so that a screen invalidating its own root cannot
 * reach across into another feature's cache — the grievance detail and the
 * achievements register are refetched by different buttons and must not
 * invalidate each other.
 *
 * Deliberately on the same exported object as the lazy components rather than
 * in a second file: the registry imports one symbol per feature area, and a
 * `commsQueryKeys` sitting beside `commsKeys` is the pair somebody eventually
 * imports the wrong half of.
 */
export const commsQueryKeys = {
  grievanceRoot: () => ['comms', 'grievances'] as const,
  grievances: (status: string, category: string, overdue: boolean) =>
    ['comms', 'grievances', 'list', status, category, overdue] as const,
  grievance: (id: string | null) => ['comms', 'grievances', 'one', id] as const,
  grievanceTimeline: (id: string | null) => ['comms', 'grievances', 'timeline', id] as const,
  grievanceSummary: () => ['comms', 'grievances', 'summary'] as const,
  grievanceSLA: () => ['comms', 'grievances', 'sla'] as const,

  achievementRoot: () => ['comms', 'achievements'] as const,
  achievements: (kind: string, level: string, q: string) =>
    ['comms', 'achievements', 'list', kind, level, q] as const,
  achievement: (id: string | null) => ['comms', 'achievements', 'one', id] as const,

  ptmBookings: () => ['comms', 'ptm', 'bookings'] as const,

  counselorRoot: () => ['comms', 'counselor'] as const,
  counselorThreads: () => ['comms', 'counselor', 'threads'] as const,
  counselorContacts: () => ['comms', 'counselor', 'contacts'] as const,
  counselorMessages: (id: string | null) => ['comms', 'counselor', 'messages', id] as const,
  counselorParticipants: (id: string | null) =>
    ['comms', 'counselor', 'participants', id] as const,
}
