import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHead, PageBody, TAB_BAR, tabClass } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useCan } from '@/lib/session'
import { ImportButton, ExportButton } from '@/components/DataPortActions'
import Collections from './Collections'
import FeeSetupHub from './FeeSetupHub'
import { FindStudent, StudentFees, AllRequests, NoStudent } from './FeeHub'

/* The fee counter (owner's "Fees all in one place", 2026-11-21): Take
   payment for one child, Collections for the day's money, the approvals
   waiting, and the fee setup with next year's steps. The child's screens
   are in FeeHub.tsx. */

type Tab = 'take' | 'collections' | 'approvals' | 'setup'

export default function FeeCounter() {
  const can = useCan()
  /* Opened from Student 360's Take fee (owner, 2026-11-20): ?student=<id>&invoices=<a,b>
     picks the child and ticks those bills' lines with their balance. */
  const [params] = useSearchParams()
  const first = params.get('tab')
  const [tab, setTab] = useState<Tab>(first === 'collections' || first === 'approvals' || first === 'setup' ? first : 'take')
  const [studentId, setStudentId] = useState<string | null>(params.get('student'))
  const [preset, setPreset] = useState<string[] | null>(() => params.get('invoices')?.split(',').filter(Boolean) ?? null)
  const tabs: [Tab, string][] = [['take', 'Take payment'], ['collections', 'Collections'], ['approvals', 'Approvals'], ['setup', 'Fee setup & next year']]

  return (
    <>
      <PageHead
        eyebrow="Fee Workspace"
        title="Fee counter"
        description="Find a student, take payment, issue a receipt."
        actions={
          <>
            {can('finance.payments.write') && (
              <ImportButton
                entity="fee_payments"
                title="Import fee payments"
                hint="Import past payments. Each is checked against a due invoice first."
              />
            )}
            <ExportButton name="collections" />
          </>
        }
      />
      <PageBody>
        <div className={cn(TAB_BAR, 'mb-5')} role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tabClass(tab === k)} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        {tab === 'collections' && <Collections />}
        {tab === 'approvals' && <AllRequests />}
        {tab === 'setup' && <FeeSetupHub />}
        {tab === 'take' && (
          <div className="space-y-6">
            <FindStudent studentId={studentId} onPick={(id) => { setStudentId(id); setPreset(null) }} />
            {studentId ? <StudentFees key={studentId} studentId={studentId} preset={preset} /> : <NoStudent />}
          </div>
        )}
      </PageBody>
    </>
  )
}
