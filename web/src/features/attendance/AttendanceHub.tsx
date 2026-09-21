import { useState } from 'react'
import { PageHead, PageBody, EmptyState } from '@/components/ui'
import { useCan } from '@/lib/session'
import Attendance from '../shared/Attendance'
import StudentAbsentees from './StudentAbsentees'
import AbsenceFollowup from './AbsenceFollowup'

/* Attendance — one workspace tile, everything inside.
 *
 * The three student-attendance screens used to be three menu entries that sat
 * next to each other and confused everyone who kept asking which one marked the
 * register. They are one job seen from three angles: Take marks it, Present &
 * absent watches the day, Follow-up rings the families. So they are one tile now
 * with a tab each, and each tab shows only if the caller may do that thing.
 *
 * The tabs are the exact plain-button segmented control the monitor already
 * used — no new dependency, and it renders on the oldest browser we support.
 * Each child keeps its own date / section / search controls; passing `embedded`
 * only suppresses the child's own PageHead so there is one title, not three. */

type TabKey = 'take' | 'monitor' | 'followup'

export default function AttendanceHub() {
  const can = useCan()

  const canTake = can('academics.attendance.write')
  const canRead =
    can('academics.attendance.read') || can('academics.attendance.read.all')

  /* One entry per tab the caller may open, in the order they should appear.
     A teacher lands on Take; a supervisor who cannot mark lands on Present &
     absent. */
  const tabs: { key: TabKey; label: string }[] = []
  if (canTake) tabs.push({ key: 'take', label: 'Take' })
  if (canRead) tabs.push({ key: 'monitor', label: 'Present & absent' })
  if (canRead) tabs.push({ key: 'followup', label: 'Follow-up' })

  const [tab, setTab] = useState<TabKey>(() => tabs[0]?.key ?? 'take')

  // The gate on the route should keep anyone with no access out; this is the
  // honest fallback if one ever slips through.
  if (tabs.length === 0) {
    return (
      <>
        <PageHead eyebrow="Attendance" title="Attendance" />
        <PageBody>
          <EmptyState title="You do not have attendance access." />
        </PageBody>
      </>
    )
  }

  // Guard against a remembered tab the caller may no longer open.
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0].key

  return (
    <>
      <PageHead eyebrow="Attendance" title="Attendance" />
      <PageBody>
        <div
          role="tablist"
          aria-label="Attendance"
          className="mb-3 inline-flex gap-1 rounded-md border bg-muted p-1"
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              onClick={() => setTab(t.key)}
              className={
                active === t.key
                  ? 'rounded-sm bg-card px-3 py-1 text-[13px] font-medium text-foreground shadow-sm'
                  : 'rounded-sm px-3 py-1 text-[13px] text-muted-foreground hover:text-foreground'
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        {active === 'take' && <Attendance embedded />}
        {active === 'monitor' && <StudentAbsentees embedded />}
        {active === 'followup' && <AbsenceFollowup embedded />}
      </PageBody>
    </>
  )
}
