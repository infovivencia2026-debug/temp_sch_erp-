/* A DRAWING PER FEATURE, WHERE ONE EXISTS.
 *
 * The launcher's plate carried the feature's initials, and the catalogue's
 * names collide: Academic Performance and Admissions Pipeline are both AP and
 * sit in Students together; Student photographs and Syllabus Progress are both
 * SP; Fee Dashboard and Fee Default are both FD. Nine of the principal's
 * fifty-four shared a monogram with another feature, which is the plate
 * pointing at the wrong screen for a sixth of the grid.
 *
 * A drawing does not collide. A pulse line and a funnel are never each other,
 * whatever their names begin with.
 *
 * NOT EVERY FEATURE HAS ONE. Three hundred and twenty-one features exist and
 * inventing a distinct mark for "Working Days & Instructional Hours" produces
 * a near-identical document-with-something, which is worse than two letters --
 * that was the reasoning behind the monogram and it still holds. So this is a
 * registry rather than a requirement: a feature with a drawing shows it, and a
 * feature without keeps its initials. Both look deliberate, and the set can
 * grow a role at a time.
 *
 * Keyed on slug, not on the display name: a name can be edited in the
 * catalogue CSV without silently dropping the icon.
 *
 * Drawn to one rule -- a 24x24 box, no fill, hairline strokes, round joins --
 * so the family reads as one set at plate size. Stroke width and colour are
 * inherited from the plate, so the icon takes the workspace tint the monogram
 * took and needs no palette of its own.
 */

const P = (d: string) => d

/* eslint-disable react-refresh/only-export-components */
export const FEATURE_ICONS: Record<string, string> = {
  // --- Home
  dashboard: P('<path d="M12 22C6.48 22 2 17.52 2 12S6.48 2 12 2s10 4.48 10 10"/><path d="M12 18a6 6 0 100-12"/><circle cx="12" cy="12" r="2"/>'),
  school_setup: P('<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6"/><circle cx="12" cy="10" r="1.6"/>'),
  approvals: P('<circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/>'),

  // --- Students
  student_360: P('<circle cx="12" cy="9" r="3.4"/><path d="M6 19v-1.2A3.8 3.8 0 019.8 14h4.4a3.8 3.8 0 013.8 3.8V19"/><path d="M3.5 12a8.5 8.5 0 018.5-8.5"/><path d="M20.5 12a8.5 8.5 0 01-8.5 8.5"/>'),
  student_photographs: P('<rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.6"/><path d="M8.5 6l1.4-2h4.2l1.4 2"/>'),
  certificates_transfers: P('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="12" cy="14" r="2.2"/><path d="M10.6 15.8L10 19l2-1.1 2 1.1-.6-3.2"/>'),
  class_promotion: P('<path d="M22 18H2"/><path d="M4 18v-3.5h3.6V18"/><path d="M10.2 18v-7h3.6v7"/><path d="M16.4 18V6.5H20V18"/><polyline points="13 2 13 5 16 5"/>'),
  academic_performance: P('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  groups_lists: P('<circle cx="9" cy="7" r="4"/><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>'),
  admissions_pipeline: P('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),

  // --- Academics
  master_timetable: P('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/><line x1="15" y1="21" x2="15" y2="9"/>'),
  substitutions: P('<path d="M16 3h5v5"/><path d="M21 3l-8 8"/><path d="M8 21H3v-5"/><path d="M3 21l8-8"/><path d="M3 8V3h5"/><path d="M21 16v5h-5"/>'),
  school_calendar: P('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  activities_electives: P('<path d="M5 21V4"/><path d="M5 4h11l-2 3.5L16 11H5"/>'),
  curriculum_roadmap: P('<path d="M4 19c4 0 4-14 10-14s6 4 6 4"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="9" r="2"/>'),
  lesson_plans: P('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="14" x2="15" y2="14"/><line x1="9" y1="18" x2="12" y2="18"/>'),
  syllabus_progress: P('<path d="M12 3a9 9 0 109 9"/><path d="M12 3a9 9 0 019 9"/><polyline points="9 12 11 14 15.5 9.5"/>'),
  attendance_audit: P('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3.5h6V6H9z"/><circle cx="11.5" cy="13" r="3"/><line x1="13.8" y1="15.3" x2="16" y2="17.5"/>'),
  class_setup: P('<rect x="3" y="5" width="18" height="4" rx="1"/><rect x="3" y="12" width="7" height="4" rx="1"/><rect x="14" y="12" width="7" height="4" rx="1"/><line x1="6.5" y1="16" x2="6.5" y2="19"/><line x1="17.5" y1="16" x2="17.5" y2="19"/>'),
  year_rollover: P('<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8.5 16.5a3.5 3.5 0 105.8-2.6"/><polyline points="15 12 14.5 15 11.6 14.2"/>'),
  teacher_assignment: P('<circle cx="8" cy="7" r="3.4"/><path d="M2.5 20v-1.6A4.4 4.4 0 017 14h2"/><rect x="12.5" y="12" width="9" height="7" rx="1"/><line x1="15" y1="15.5" x2="19" y2="15.5"/>'),
  performance_overview: P('<rect x="3" y="4" width="18" height="14" rx="2"/><polyline points="6.5 13.5 10 10 12.5 12.5 17.5 7.5"/><line x1="9" y1="21" x2="15" y2="21"/>'),
  hall_ticket_issue: P('<path d="M3 8a2 2 0 002-2h14a2 2 0 002 2v1.5a2.5 2.5 0 000 5V16a2 2 0 01-2 2H5a2 2 0 01-2-2v-1.5a2.5 2.5 0 000-5z"/><line x1="12" y1="8" x2="12" y2="10"/><line x1="12" y1="14" x2="12" y2="16"/>'),
  exams_results: P('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8.5 16.5h7"/><path d="M10 12.5l1.6 1.6L15 11"/>'),
  exams_papers: P('<path d="M7 5V3.5A1.5 1.5 0 018.5 2h8L20 5.5V16a1.5 1.5 0 01-1.5 1.5H17"/><rect x="4" y="6.5" width="12" height="15" rx="1.5"/><line x1="7" y1="12" x2="13" y2="12"/><line x1="7" y1="16" x2="11" y2="16"/>'),
  question_paper_approval: P('<path d="M6 3h9l4 4v9"/><path d="M6 3v18h8"/><polyline points="15 3 15 7 19 7"/><circle cx="17.5" cy="18.5" r="3.5"/><polyline points="16 18.5 17.2 19.7 19 17.8"/>'),
  mark_moderation: P('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="17" r="2"/>'),

  // --- Finance
  fee_dashboard: P('<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5h5"/><path d="M9.5 11h5"/><path d="M13.5 8.5c1.6 0 1.6 2.5 0 2.5H10l4 4.5"/>'),
  period_close: P('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/><line x1="12" y1="14" x2="12" y2="17"/>'),
  fee_default: P('<circle cx="10" cy="10" r="6.4"/><path d="M8 8h4"/><path d="M8 10.2h4"/><path d="M11 8c1.3 0 1.3 2.2 0 2.2H8.6L11.8 14"/><path d="M17.6 14.4l3.6 6.2h-7.2z"/><line x1="17.6" y1="17" x2="17.6" y2="18.4"/>'),
  fee_collection: P('<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v5c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V6"/><path d="M5 11v5c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-5"/>'),

  // --- Communication
  grievances: P('<path d="M21 12a8 8 0 01-8 8H7l-4 3v-6.5A8 8 0 0113 4a8 8 0 018 8z"/><line x1="13" y1="8.5" x2="13" y2="12.5"/><line x1="13" y1="15" x2="13" y2="15.01"/>'),
  school_achievements_showcase: P('<path d="M8 4h8v5a4 4 0 01-8 0z"/><path d="M8 5.5H5.5A2.5 2.5 0 008 10"/><path d="M16 5.5h2.5A2.5 2.5 0 0116 10"/><line x1="12" y1="13" x2="12" y2="17"/><path d="M8.5 20h7l-1-3h-5z"/>'),
  circulars: P('<path d="M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1z"/><path d="M16 8.5a5 5 0 010 7"/><path d="M18.5 6a8.5 8.5 0 010 12"/>'),
  messages: P('<path d="M20 4H8a2 2 0 00-2 2v7a2 2 0 002 2h8l4 3V6a2 2 0 00-2-2z"/><path d="M6 17H4a2 2 0 01-2-2V9"/>'),
  message_channels: P('<circle cx="12" cy="12" r="2.4"/><path d="M7.8 7.8a6 6 0 000 8.4"/><path d="M16.2 16.2a6 6 0 000-8.4"/><path d="M4.9 4.9a10 10 0 000 14.2"/><path d="M19.1 19.1a10 10 0 000-14.2"/>'),

  // --- Reports
  reports: P('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8.5" y1="18" x2="8.5" y2="13"/><line x1="12" y1="18" x2="12" y2="11"/><line x1="15.5" y1="18" x2="15.5" y2="15"/>'),
  attendance_overview: P('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><polyline points="7.5 13.5 9 15 11.5 12.5"/><polyline points="14 13.5 15.5 15 18 12.5"/><polyline points="7.5 18 9 19.5 11.5 17"/>'),

  // --- Staff
  leaves_subs: P('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><path d="M9.5 15.5h5"/><path d="M12.5 13l2.5 2.5-2.5 2.5"/>'),
  roles_permissions: P('<path d="M12 2.5l7.5 3v5.6c0 4.4-3 8.3-7.5 9.9-4.5-1.6-7.5-5.5-7.5-9.9V5.5z"/><circle cx="12" cy="10.5" r="2"/><path d="M12 12.5v3"/><line x1="11" y1="14.5" x2="13" y2="14.5"/>'),
  logins_access: P('<circle cx="8.5" cy="12" r="4"/><path d="M12.5 12H21"/><path d="M18 12v3"/><path d="M21 12v2.2"/>'),
  staff_groups_lists: P('<line x1="10" y1="7" x2="21" y2="7"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="17" x2="21" y2="17"/><circle cx="5" cy="7" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="5" cy="17" r="1.6"/>'),
  biometric_readers: P('<path d="M12 3.5c-3.6 0-6.5 2.9-6.5 6.5v2.5"/><path d="M12 3.5c3.6 0 6.5 2.9 6.5 6.5v5.5"/><path d="M9 10a3 3 0 016 0v7.5"/><path d="M12 10v9"/><path d="M5.8 17.5a10 10 0 00.9 3"/>'),
  staff_attendance_register: P('<path d="M5 3.5h13a1 1 0 011 1V21a1 1 0 01-1 1H5a2 2 0 01-2-2V5.5a2 2 0 012-2z"/><path d="M3 18.5h16"/><polyline points="7.5 8.5 9 10 12 7"/><line x1="14" y1="9" x2="16.5" y2="9"/><polyline points="7.5 14 9 15.5 12 12.5"/>'),
  staff_working_hours: P('<circle cx="12" cy="12" r="9"/><polyline points="12 6.5 12 12 16 14"/>'),
  staff_hours_this_month: P('<rect x="3" y="4.5" width="14" height="14" rx="2"/><line x1="3" y1="9" x2="17" y2="9"/><circle cx="17.5" cy="16.5" r="5"/><polyline points="17.5 14 17.5 16.5 19.5 17.6"/>'),
  leave_rules_lop: P('<path d="M12 4v16"/><path d="M6 8h12"/><path d="M6 8l-3 6h6z"/><path d="M18 8l-3 6h6z"/><path d="M9 20h6"/>'),
  staff_attendance_reports: P('<path d="M21 20H3V4"/><polyline points="6.5 15.5 10 11.5 13 14 18.5 7.5"/><circle cx="18.5" cy="7.5" r="1.4"/>'),

  // --- My Profile
  my_pay: P('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><line x1="6" y1="12" x2="6.01" y2="12"/><line x1="18" y1="12" x2="18.01" y2="12"/>'),

  // --- Hostel
  hostel_rooms: P('<path d="M3 18v-6a2 2 0 012-2h9a3 3 0 013 3v5"/><path d="M3 18h18"/><circle cx="7.5" cy="8.5" r="2"/><path d="M21 18v-3.5"/><path d="M3 14h14"/>'),
  outpasses_mess: P('<path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h8"/><path d="M11 12h10"/><polyline points="18 9 21 12 18 15"/>'),
  night_study_attendance: P('<path d="M20 14.5A7.5 7.5 0 0110.2 4.6 8 8 0 1020 14.5z"/><path d="M4.5 19.5h7"/><path d="M5.5 19.5v-2.2h5v2.2"/>'),
  room_inventory_checklists: P('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3.5h6V6H9z"/><polyline points="8.5 11 10 12.5 12.5 10"/><line x1="14" y1="11.5" x2="16.5" y2="11.5"/><polyline points="8.5 16 10 17.5 12.5 15"/><line x1="14" y1="16.5" x2="16.5" y2="16.5"/>'),
  hostel_visitor_log: P('<path d="M4 21V5a2 2 0 012-2h6a2 2 0 012 2v16"/><path d="M2.5 21h13"/><circle cx="11.5" cy="12" r="0.7"/><circle cx="19" cy="8" r="2.6"/><path d="M15.5 21v-2.4A3.6 3.6 0 0119 15h.2"/>'),
  boarder_laundry: P('<rect x="4" y="2.5" width="16" height="19" rx="2"/><line x1="4" y1="7" x2="20" y2="7"/><circle cx="7" cy="4.8" r="0.6"/><circle cx="10" cy="4.8" r="0.6"/><circle cx="12" cy="14.5" r="4.5"/><path d="M9 14.5c1.5-1.4 1.5 1.4 3 0s1.5 1.4 3 0"/>'),
}

/** The drawing for a feature slug, or undefined where none has been drawn. */
export function featureIcon(slug: string): string | undefined {
  return FEATURE_ICONS[slug]
}
