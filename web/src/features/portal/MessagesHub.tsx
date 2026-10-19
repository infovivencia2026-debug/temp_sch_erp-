import { screen } from '@/lib/screen'
import { useSession } from '@/lib/session'
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
  /* A school that has switched off "Teachers message parents directly"
     (Settings -> Communication) gives families no Message teacher tab
     either: the line is closed from both ends. */
  const session = useSession()
  const parentDMs = !session.modules?.some((m) => m.module === 'teacher_parent_messages' && !m.enabled)
  return <ScreenTabs label="Messages" tabs={parentDMs ? TABS : TABS.filter((t) => t.key !== 'teacher')} />
}
