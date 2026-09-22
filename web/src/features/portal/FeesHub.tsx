import { screen } from '@/lib/screen'
import ScreenTabs from './ScreenTabs'

/* Fees: what is due and what has been paid, on one menu row. The receipts
   were a separate entry a parent had to know to look for; they are the
   natural second tab of the fees page. */
const TABS = [
  { key: 'fees', label: 'Fees & payments', screen: screen(() => import('./Fees')) },
  { key: 'receipts', label: 'Receipts', screen: screen(() => import('./Receipts')) },
]

export default function FeesHub() {
  return <ScreenTabs label="Fees" tabs={TABS} />
}
