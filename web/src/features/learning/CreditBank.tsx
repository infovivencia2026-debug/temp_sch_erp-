import { useQuery } from '@tanstack/react-query'
import { Landmark, BadgeCheck, Fingerprint } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface CreditEntry {
  id: string
  course_title: string
  subject?: string
  academic_year?: string
  session?: string
  credits: number
  level?: string
  grade?: string
  status: string
  deposited_on?: string
  apaar_id?: string
}
interface AbcResponse {
  student_id: string
  student_name: string
  apaar_id?: string
  has_apaar: boolean
  total_credits: number
  credits_banked: number
  entries: CreditEntry[]
}

const TONE: Record<string, 'info' | 'success' | 'neutral' | 'warning'> = {
  earned: 'info',
  deposited: 'success',
  redeemed: 'neutral',
  withdrawn: 'warning',
}

/* The APAAR, and what has been banked against it.

   The identifier is the school's to maintain, so it is read from the child's
   record rather than kept a second time here — a copy would be the one still
   showing the digits somebody mistyped last year.

   Withdrawn deposits are shown rather than filtered away. A statement that
   silently drops a reversal is not a statement, and the child whose total went
   down is exactly the person entitled to see why. */
export default function CreditBank() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const abc = useQuery({
    queryKey: ['abc', studentId],
    queryFn: () => api.get<AbcResponse>(`/api/v1/portal/abc${studentQuery(studentId)}`),
    enabled: ready,
  })

  if (abc.isLoading && ready) return <SkeletonTable columns={9} label="Opening your credit statement…" />
  if (abc.error) return <ErrorState error={abc.error} />

  const a = abc.data
  const entries = a?.entries ?? []

  return (
    <>
      <PageHead
        eyebrow="Exams and results"
        title="APAAR and credit bank"
        description="Your permanent academic identifier, and the credits banked against it."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="An APAAR belongs to one child." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat
                label="APAAR ID"
                value={a?.has_apaar ? a.apaar_id : 'Not issued'}
                icon={Fingerprint}
                hint={
                  a?.has_apaar
                    ? 'Maintained by the school office'
                    : 'Ask the office to register you'
                }
              />
              <Stat label="Credits held" value={a?.total_credits ?? 0} icon={Landmark}
                hint="Earned and deposited, less anything withdrawn" />
              <Stat label="Deposited to the bank" value={a?.credits_banked ?? 0} icon={BadgeCheck}
                hint="Confirmed against the national register" />
            </CellGrid>

            {!a?.has_apaar && (
              <Card>
                {/* The sentence is the whole card, so it goes in the body.

                    Card descriptions are no longer drawn, so a card whose only
                    content was one rendered as a heading over an empty box —
                    which reads as a screen that failed to load rather than as
                    an explanation. */}
                <EmptyState
                  title="No APAAR yet"
                  body="Credits can still be earned and recorded here. They are deposited to the national bank once the office registers an APAAR against your name."
            />
              </Card>
            )}

            <Card>
              <CardHeader
                title="Credit statement"
                description="Most recently deposited first. The identifier on each line is the one that was on your record the day it was banked."
              />
              <Table
                head={[
                  'Course', 'Subject', 'Year', 'Session',
                  { label: 'Credits', align: 'right' },
                  'Grade', 'Status', 'Deposited',
                ]}
                empty={entries.length === 0}
                emptyLabel="No credits recorded yet."
              >
                {entries.map((e) => (
                  <tr key={e.id}>
                    <Td>
                      <span className="font-medium">{e.course_title}</span>
                      {e.level && <Badge>{e.level.replace('_', ' ')}</Badge>}
                    </Td>
                    <Td>{e.subject ?? <span className="text-muted-foreground">—</span>}</Td>
                    <Td>{e.academic_year ?? '—'}</Td>
                    <Td>{e.session ?? '—'}</Td>
                    <Td className="text-right tabular-nums">{e.credits}</Td>
                    <Td>{e.grade ?? '—'}</Td>
                    <Td>
                      <Badge tone={TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
                    </Td>
                    <Td>
                      {e.deposited_on ? (
                        formatDate(e.deposited_on)
                      ) : (
                        <span className="text-muted-foreground">Not yet</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
