import { screen } from '@/lib/screen'
import ScreenTabs from './ScreenTabs'

/* Messages: everything the school and the family say to each other, on one
   menu row. Circulars are what the school sent; Message teacher is the
   family's line to the class teacher; Concerns is a raised issue followed to
   its reply. Three catalogue rows became one so a parent is not left guessing
   which of three menu entries holds the thing they are looking for. */
const TABS = [
  { key: 'circulars', label: 'Circulars', screen: screen(() => import('../comms/Circulars')) },
  { key: 'teacher', label: 'Message teacher', screen: screen(() => import('./TeacherMessages')) },
  { key: 'concerns', label: 'Concerns', screen: screen(() => import('./Concerns')) },
]

export default function MessagesHub() {
  return <ScreenTabs label="Messages" tabs={TABS} />
}
