import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { PageHead, PageBody, TAB_BAR, tabClass } from '@/components/ui'
import Impersonation from './Impersonation'
import { SellerAuditLog } from './SellerAuditLog'

/**
 * Seller → Support → Audit. Two registers: every write the vendor's people
 * made (seller screens, billing, feature switches, restores, off-boarding,
 * anything done while acting inside a school), append-only; and the
 * act-as-a-school sessions that were already here.
 */
export default function SellerAudit() {
  const [tab, setTab] = useState<'actions' | 'acting'>('actions')
  const schools = useQuery({
    queryKey: ['seller', 'tenants', 'names'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/seller/tenants'),
    retry: false,
  })
  return (
    <>
      <div className="px-5 pt-5 sm:px-7">
        <div className={TAB_BAR} role="tablist">
          <button role="tab" aria-selected={tab === 'actions'} className={tabClass(tab === 'actions')} onClick={() => setTab('actions')}>Seller actions</button>
          <button role="tab" aria-selected={tab === 'acting'} className={tabClass(tab === 'acting')} onClick={() => setTab('acting')}>Acting as a school</button>
        </div>
      </div>
      {tab === 'acting' ? <Impersonation /> : (
        <>
          <PageHead eyebrow="Support" title="Audit of seller actions" description="Every change made by a seller, support or platform account, who made it, when, in which school, and what it was before and after. Nothing here can be edited or deleted." />
          <PageBody>
            <SellerAuditLog
              base="/api/v1/seller/audit"
              showSchool
              title="Seller actions"
              schools={(schools.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }))}
            />
          </PageBody>
        </>
      )}
    </>
  )
}
