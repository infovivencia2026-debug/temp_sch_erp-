import { screen } from '@/lib/screen'
import ScreenTabs from './ScreenTabs'

/* Report absence / apply leave: the same fact with two lengths. "Not coming
   tomorrow, fever" is one tap; a week off with a doctor's certificate is a
   leave application the class teacher approves. Both used to be separate menu
   rows and a parent picked the wrong one often enough to matter. */
const TABS = [
  { key: 'absence', label: 'Report absence', screen: screen(() => import('./ReportAbsence')) },
  { key: 'leave', label: 'Apply leave', screen: screen(() => import('./LeaveRequests')) },
]

export default function AbsenceHub() {
  return <ScreenTabs label="Absence and leave" tabs={TABS} />
}
