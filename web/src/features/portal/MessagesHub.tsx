import { screen } from '@/lib/screen'
import ScreenTabs from './ScreenTabs'

/* Communication: the two things the family and the school actually use.
   Concerns is a raised issue followed to its reply; "Circulars from school"
   is what the school sent out. Parents here do not message teachers (Yajur,
   2026-11-19), so that line is gone and only these two remain, offered as a
   dropdown of the screen. */
const TABS = [
  { key: 'concerns', label: 'Concerns', screen: screen(() => import('./Concerns')) },
  { key: 'circulars', label: 'Circulars from school', screen: screen(() => import('../comms/Circulars')) },
]

export default function MessagesHub() {
  return <ScreenTabs label="Communication" tabs={TABS} />
}
