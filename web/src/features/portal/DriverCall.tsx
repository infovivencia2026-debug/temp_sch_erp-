import { useQuery } from '@tanstack/react-query'
import { Phone, PhoneOff } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import {
  ageText, stateSentence, usePoll, useSecondsSince, useTabVisible, withDrift,
  STATE_LABEL, STATE_TONE, type ChildBusFeed, type ChildBusRow,
} from './child-bus'

/* Ringing the driver.

   The number is published by the server only while a run is open, and that is
   the feature rather than a limitation to work around: a driver's personal
   mobile handed to four hundred families all day is a driver's mobile ringing
   at eleven at night. So this screen does not cache the number, does not
   store it, and does not show a greyed-out button when it is absent — a dead
   button is read as an app fault and pressed repeatedly. It says in a
   sentence why there is nothing to press, and points at the office, which is
   the number that is answered outside a run.

   Separate from the map screen because the catalogue carries it as its own
   entry and a parent looking for a phone number at ten past seven should not
   have to scroll past a plot to find it. */

export default function DriverCall() {
  const visible = useTabVisible()
  const feed = useQuery({
    queryKey: ['me-child-bus'],
    queryFn: () => api.get<ChildBusFeed>('/api/v1/me/child-bus'),
  })

  const staleAfter = feed.data?.stale_after_seconds ?? 60
  /* Age the cached rows by however long the answer has been sitting here, so
     a paused poll cannot leave a bus looking live. */
  const drift = useSecondsSince(feed.dataUpdatedAt)
  const rows = (feed.data?.items ?? []).map((r) => withDrift(r, drift, staleAfter))
  usePoll(rows, visible, () => void feed.refetch())

  if (feed.isLoading) return <Loading label="Checking whether a run is open…" />
  if (feed.error) return <ErrorState error={feed.error} />

  return (
    <>
      <PageHead
        eyebrow="My child's bus"
        title="Call the bus driver"
        description="The driver's number is published to parents only while a run is open. Outside those hours it is not shown here at all, by design — the transport office takes the call instead."
      />
      <PageBody>
        {rows.length === 0 ? (
          <EmptyState
            title="No child of yours is on a school bus"
            body="This page lists children with a current transport allocation. If your child travels by bus and is not listed, the transport office holds that record."
          />
        ) : (
          rows.map((row) => <CallCard key={row.student_id} row={row} staleAfter={staleAfter} />)
        )}
      </PageBody>
    </>
  )
}

function CallCard({ row, staleAfter }: { row: ChildBusRow; staleAfter: number }) {
  const phone = row.driver_phone?.trim()
  return (
    <Card>
      <CardHeader
        title={row.student_name}
        description={`${row.route}${row.registration_no ? ` · ${row.registration_no}` : ''}${
          row.driver ? ` · ${row.driver}` : ''
        }`}
        action={<Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        {phone ? (
          <div className="flex flex-wrap items-center gap-4">
            {/* A tel: link, not a button that calls an API. The handset's own
                dialler is the thing that can actually place a call, and on a
                desktop the browser will offer whatever the family already
                uses. */}
            <a
              href={`tel:${phone.replace(/[^\d+]/g, '')}`}
              className="inline-flex items-center gap-2 rounded-[8px] bg-primary px-4 py-2.5 text-[14px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Phone className="h-4 w-4" />
              Call {row.driver ?? 'the driver'}
            </a>
            <span className="font-mono text-[14px]">{phone}</span>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <PhoneOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
              There is no number to call at the moment.{' '}
              {row.state === 'not_published'
                ? 'Your school has not switched on parent bus tracking, and the driver contact comes with it.'
                : 'The driver contact is published only while a run is open, so that a school driver is not being rung on their own phone all evening.'}{' '}
              For anything urgent, the transport office is the number to use.
            </p>
          </div>
        )}

        <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          {stateSentence(row, staleAfter)}
        </p>

        <p className="text-[12.5px] text-muted-foreground">
          {row.stop ? `Stop: ${row.stop}. ` : ''}
          Last position {ageText(row.age_seconds)}.
        </p>

        {phone && (
          <p className="max-w-2xl text-[12.5px] text-muted-foreground">
            Please do not call while the bus is moving unless it matters — the person answering is
            driving your child.
          </p>
        )}
      </div>
    </Card>
  )
}
