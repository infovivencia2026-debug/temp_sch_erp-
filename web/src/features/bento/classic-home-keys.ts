import type { ComponentType } from 'react'
import { screen } from '@/lib/screen'
import { inClassic } from './classic-board'

/* ONE HOME PER ROLE, WHICHEVER LAYOUT IS ON.
 *
 * Six roles had two Homes: the board under Focus, and an older classic
 * dashboard under the sidebar layout -- a principal switching layouts
 * landed on a different screen with different figures, and said the two
 * were completely different. The four small workspaces and the welfare
 * roles already avoided this by serving the same board on both layouts
 * (classic-board.tsx: the board inside an element that carries the bento
 * palette). This does the same for the six that did not.
 *
 * Spread LAST into FEATURE_COMPONENTS, so these entries win over the
 * classic dashboards registered under the same keys; those files stay in
 * the tree for whichever other keys still point at them. Focus is not
 * affected -- bento-registry.ts already serves these boards there. */
const board = (load: () => Promise<{ default: ComponentType }>) =>
  screen(() => load().then((m) => ({ default: inClassic(m.default) })))

export const classicHomeKeys = {
  'institution_admin.home.dashboard': board(() => import('./PrincipalDashboard')),
  'admissions.home.dashboard': board(() => import('./AdmissionsDesk')),
  'hr.home.dashboard': board(() => import('./HRMorning')),
  'faculty.home.todays_classes': board(() => import('./FacultyToday')),
  'student.home.my_day': board(() => import('./StudentDay')),
  'parent.home.dashboard': board(() => import('./ParentWeek')),
}
