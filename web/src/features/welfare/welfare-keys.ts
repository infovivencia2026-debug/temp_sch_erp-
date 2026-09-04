import { screen } from '@/lib/screen'

/**
 * The five welfare and pastoral workspaces: nurse, counsellor, discipline
 * officer, hostel warden and activity coordinator.
 *
 * Each role held its capability grants and no catalogue rows, so a person
 * holding only one of them landed on "no workspace". The screens they use
 * already existed on the principal's menu; these keys point the role's own
 * catalogue entries at the same components, the way library-year-keys.ts
 * reuses LibraryDesk. Only the Home boards are new.
 *
 * Spread into FEATURE_COMPONENTS in registry.ts; scripts/gen_implemented.py
 * reads the spread, so the server marks these live only once it is in place.
 * Keys checked against internal/catalog/catalog_gen.go.
 */
export const welfareKeys = {
  // Nurse: reads and writes the clinic (health.read + health.write).
  'nurse.home.dashboard': screen(() => import('./NurseDay')),
  'nurse.clinic.visits_medication': screen(() => import('../operations/InfirmaryClinic')),
  'nurse.clinic.checkups_camps': screen(() => import('../operations/InfirmaryScreening')),
  'nurse.clinic.health_records': screen(() => import('../operations/Infirmary')),
  'nurse.my_profile.my_pay': screen(() => import('../me/MyPay')),

  // Counsellor: counselling threads, the conduct file read-only (the note
  // form hides itself without welfare.discipline.write), and the health master
  // file read-only (health.read).
  'counsellor.home.dashboard': screen(() => import('./CounsellorDay')),
  'counsellor.counselling.family_conversations': screen(() => import('../communication/CounselorChannel')),
  'counsellor.counselling.conduct_notes': screen(() => import('../faculty/Behaviour')),
  'counsellor.counselling.health_records': screen(() => import('../operations/Infirmary')),
  'counsellor.my_profile.my_pay': screen(() => import('../me/MyPay')),

  // Discipline officer: writes conduct notes (welfare.discipline.write); the
  // incident log is read, its escalation form needs students.write.
  'discipline_officer.home.dashboard': screen(() => import('./DisciplineDay')),
  'discipline_officer.discipline.conduct_notes': screen(() => import('../faculty/Behaviour')),
  'discipline_officer.discipline.incident_log': screen(() => import('../students/DisciplineLog')),
  'discipline_officer.my_profile.my_pay': screen(() => import('../me/MyPay')),

  // Hostel warden: every register is hostel.read / hostel.write.
  'hostel_warden.home.dashboard': screen(() => import('./WardenDay')),
  'hostel_warden.hostel.hostel_rooms': screen(() => import('../operations/Hostel')),
  'hostel_warden.hostel.outpasses_mess': screen(() => import('../operations/HostelLife')),
  'hostel_warden.hostel.night_study': screen(() => import('../operations/HostelNightStudy')),
  'hostel_warden.hostel.visitor_log': screen(() => import('../operations/HostelVisitors')),
  'hostel_warden.hostel.boarder_laundry': screen(() => import('../operations/HostelLaundry')),
  'hostel_warden.my_profile.my_pay': screen(() => import('../me/MyPay')),

  // Activity coordinator: activities read (academics.read; the setup form
  // hides itself without academics.write), the showcase read and publish
  // (announcements.write), circulars published to the classes concerned.
  'activity_coord.home.dashboard': screen(() => import('./ActivityDay')),
  'activity_coord.activities.clubs_activities': screen(() => import('../academics/ActivitiesSetup')),
  'activity_coord.activities.achievements_showcase': screen(() => import('../communication/AchievementsShowcase')),
  'activity_coord.activities.circulars': screen(() => import('../comms/Circulars')),
  'activity_coord.my_profile.my_pay': screen(() => import('../me/MyPay')),
}
