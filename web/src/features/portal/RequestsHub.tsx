import { screen } from '@/lib/screen'
import ScreenTabs from './ScreenTabs'

/* A student's Requests row: certificates asked of the office, and concerns
   raised with it. A student had no way to raise a concern of their own; the
   portal's Concerns screen already works for them (the server files it about
   the student themselves), it only needed a door. */
const TABS = [
  { key: 'requests', label: 'Certificates', screen: screen(() => import('./Requests')) },
  { key: 'concerns', label: 'Concerns', screen: screen(() => import('./Concerns')) },
]

export default function RequestsHub() {
  return <ScreenTabs label="Requests" tabs={TABS} />
}
