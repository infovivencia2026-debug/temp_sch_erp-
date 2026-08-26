import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AlarmClock, ChevronRight, EyeOff, MessageSquare, Send, ClipboardList } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import type { CommsSummary, PTMNote, Remark } from './comms'

/* Everything a teacher owes a family, on one screen.

   The other five screens each answer "what have I said". This one answers the
   question that actually brings someone here: is there anything outstanding on
   me. So it counts rather than lists — open actions from a meeting, notices
   still waiting on a reply — and hands off to the screen that does the work.

   The two numbers deliberately kept apart are remarks and anecdotal records.
   Rolling them into one total hides the private half, and the private half is
   the one a head of year asks about. */

/* Through /go, which resolves the workspace when the link is opened.

   These were hand-written paths into a section called teaching_workspace,
   which this role does not have — every one of the five landed somewhere that
   is not the screen it names, and four of them named screens that were built
   and never put in the catalogue at all. A path assembled here is a second
   opinion about where a feature lives; /go asks the catalogue. */
const ROUTES = {
  remarks: '/go/remarks',
  anecdotal: '/go/anecdotal_records',
  cards: '/go/class_teacher_remarks',
  ptm: '/go/ptm_notes_action_items',
  broadcast: '/go/classroom_communication',
}

export default function Communication() {
  const navigate = useNavigate()

  const summary = useQuery({
    queryKey: ['comms-summary'],
    queryFn: () => api.get<CommsSummary>('/api/v1/teaching/communication'),
  })
  const pending = useQuery({
    queryKey: ['ptm-notes', true],
    queryFn: () => api.get<List<PTMNote>>('/api/v1/teaching/ptm-notes?pending=1'),
  })
  const recent = useQuery({
    queryKey: ['remarks', false],
    queryFn: () => api.get<List<Remark>>('/api/v1/teaching/remarks'),
  })

  if (summary.isLoading) return <Loading />
  if (summary.error) return <ErrorState error={summary.error} />

  const s = summary.data
  const open = (pending.data?.items ?? []).slice(0, 8)
  const latest = (recent.data?.items ?? []).slice(0, 6)

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Communication"
        description="Remarks, meeting notes and notices home, for the classes you teach."
        actions={
          <Button onClick={() => navigate(ROUTES.broadcast)}>
            <Send className="h-3.5 w-3.5" />
            Write a notice
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Classes" value={s?.sections ?? 0} hint={`${s?.students ?? 0} children`} />
          <Stat
            label="Actions overdue"
            value={s?.actions_overdue ?? 0}
            icon={AlarmClock}
            delta={{
              value: (s?.actions_overdue ?? 0) === 0 ? 'Nothing owed' : 'Agreed with a parent',
              positive: (s?.actions_overdue ?? 0) === 0,
            }}
          />
          <Stat
            label="Awaiting a reply"
            value={s?.awaiting_acknowledgement ?? 0}
            hint="Notices you sent that asked for one"
          />
          <Stat label="Staff-only notes" value={s?.anecdotal_records ?? 0} icon={EyeOff} />
        </CellGrid>

        <CellGrid cols={3}>
          <Stat label="Remarks written" value={s?.remarks ?? 0} icon={MessageSquare} />
          <Stat label="Meetings recorded" value={s?.ptm_notes ?? 0} icon={ClipboardList} />
          <Stat label="Notices sent" value={s?.broadcasts ?? 0} icon={Send} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Where to go"
            description="Each of these writes to the child's record or to the parent's portal."
          />
          <ul className="divide-y">
            <Jump
              to={ROUTES.remarks}
              title="Remarks"
              body="Academic and class observations, shared with the parent unless you keep them staff-only."
              onGo={navigate}
            />
            <Jump
              to={ROUTES.anecdotal}
              title="Anecdotal records"
              body="Private notes on how a child is growing. Never shown to the parent."
              onGo={navigate}
            />
            <Jump
              to={ROUTES.cards}
              title="Class teacher remarks"
              body={
                (s?.terms ?? 0) === 0
                  ? 'Term-end remarks for the report card. This school has no terms set up yet.'
                  : 'The term-end line printed on the report card, plus the principal’s summary.'
              }
              onGo={navigate}
            />
            <Jump
              to={ROUTES.ptm}
              title="PTM notes & action items"
              body="Who came, what they raised, and what was agreed."
              onGo={navigate}
            />
            <Jump
              to={ROUTES.broadcast}
              title="Classroom communication"
              body="Notices to a whole class or to one child's parent."
              onGo={navigate}
            />
          </ul>
        </Card>

        <Card>
          <CardHeader title="Open actions" description="Agreed at a meeting and not yet done" />
          {open.length === 0 ? (
            <EmptyState title="Nothing outstanding" body="Every action you agreed with a parent has been closed." />
          ) : (
            <ul className="divide-y">
              {open.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">{n.student_name}</p>
                    <p className="text-[13px] text-muted-foreground">{n.agreed_actions ?? n.concerns}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {n.follow_up_on && (
                      <span className={`text-[13px] ${n.overdue ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {formatDate(n.follow_up_on)}
                      </span>
                    )}
                    {n.overdue && <Badge tone="danger">overdue</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recently written" description="The last few remarks about your classes" />
          {latest.length === 0 ? (
            <EmptyState title="Nothing written yet" />
          ) : (
            <ul className="divide-y">
              {latest.map((r) => (
                <li key={r.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium">{r.student_name}</span>
                    <Badge>{r.kind}</Badge>
                    {r.private && (
                      <Badge tone="danger">
                        <EyeOff className="mr-1 h-3 w-3" />
                        staff only
                      </Badge>
                    )}
                    <span className="text-[13px] text-muted-foreground">{formatDate(r.observed_on)}</span>
                  </div>
                  <p className="mt-0.5 text-[14px] text-muted-foreground">{r.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function Jump({
  to,
  title,
  body,
  onGo,
}: {
  to: string
  title: string
  body: string
  onGo: (path: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onGo(to)}
        className="flex w-full items-start justify-between gap-4 px-5 py-3.5 text-left transition-colors hover:bg-accent"
      >
        <span className="min-w-0">
          <span className="block text-[14px] font-medium">{title}</span>
          <span className="mt-0.5 block text-[13px] text-muted-foreground">{body}</span>
        </span>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  )
}
