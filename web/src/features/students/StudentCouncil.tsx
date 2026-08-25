import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, ClipboardCheck, UserPlus, Users } from 'lucide-react'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Checkbox, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The student council: the posts, who holds them, and what they actually did.

   "She was head girl" is worth nothing in a testimonial and "she ran the
   assembly rota for three terms" is worth something, which is why duties are a
   log rather than a checkbox.

   Seats are counted. Four house captains are one post with four seats, and a
   fifth arrives by accident far more often than on purpose — so the server
   refuses it rather than quietly seating them. */

interface Position {
  id: string
  academic_year_id: string
  academic_year: string
  title: string
  portfolio?: string
  seats: number
  is_elected: boolean
  sequence: number
  description?: string
  filled: number
  vacancies: number
}

interface Member {
  id: string
  position_id: string
  position: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  section?: string
  elected_on?: string
  term_from: string
  term_to?: string
  votes?: number
  status: 'serving' | 'completed' | 'resigned' | 'removed'
  remarks?: string
  duties: number
  duties_done: number
}

const STATUS: Record<string, 'success' | 'neutral' | 'warning' | 'danger'> = {
  serving: 'success',
  completed: 'neutral',
  resigned: 'warning',
  removed: 'danger',
}

export default function StudentCouncil() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['council'] })

  const council = useQuery({
    queryKey: ['council'],
    queryFn: () =>
      api.get<{
        positions: Position[]
        members: Member[]
        summary: {
          positions: number
          seats: number
          vacancies: number
          serving: number
          duties: number
          duties_done: number
        }
      }>('/api/v1/academics/admin/council'),
  })

  if (council.isLoading) return <Loading label="Reading this year’s council…" />
  if (council.error) return <ErrorState error={council.error} />

  const positions = council.data?.positions ?? []
  const members = council.data?.members ?? []
  const s = council.data?.summary

  return (
    <>
      <PageHead
        eyebrow="Students"
        title="Student council"
        description="The posts this year, the children elected to them, and the duties they were actually given."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Posts" value={s?.positions ?? 0} icon={Award} />
          <Stat label="Serving" value={s?.serving ?? 0} icon={Users} />
          <Stat
            label="Vacancies"
            value={s?.vacancies ?? 0}
            icon={UserPlus}
            hint={`${s?.seats ?? 0} seats in total`}
          />
          <Stat
            label="Duties done"
            value={`${s?.duties_done ?? 0} / ${s?.duties ?? 0}`}
            icon={ClipboardCheck}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Posts"
            description={
              positions[0]
                ? `Council for ${positions[0].academic_year}.`
                : 'A council belongs to an academic year.'
            }
          />
          {positions.length === 0 ? (
            <EmptyState
              title="No posts defined yet"
              body="Define the first post below; elected members hang off it."
            />
          ) : (
            <Table head={['Post', 'Portfolio', 'Seats', 'Filled', 'Vacancies', 'Elected?']}>
              {positions.map((p) => (
                <tr key={p.id}>
                  <Td className="font-medium">
                    {p.title}
                    {p.description && (
                      <span className="block text-[12px] text-muted-foreground">
                        {p.description}
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{p.portfolio ?? '—'}</Td>
                  <Td className="tabular-nums">{p.seats}</Td>
                  <Td className="tabular-nums">{p.filled}</Td>
                  <Td>
                    {p.vacancies > 0 ? (
                      <Badge tone="warning">{p.vacancies}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {p.is_elected ? 'Elected' : 'Appointed'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Council members"
            description="A duty logged against a member is what a testimonial is written from three years later."
          />
          {members.length === 0 ? (
            <EmptyState title="Nobody seated yet" body="Seat a child against a post below." />
          ) : (
            <Table
              head={['Student', 'Post', 'Class', 'Elected', 'Votes', 'Status', 'Duties', '']}
            >
              {members.map((m) => (
                <tr key={m.id}>
                  <Td className="font-medium">{m.student_name}</Td>
                  <Td>{m.position}</Td>
                  <Td className="text-muted-foreground">
                    {m.class_name ? `${m.class_name}-${m.section}` : m.admission_no}
                  </Td>
                  <Td>{m.elected_on ? formatDate(m.elected_on) : formatDate(m.term_from)}</Td>
                  <Td className="tabular-nums">{m.votes ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS[m.status]}>{m.status}</Badge>
                  </Td>
                  <Td className="tabular-nums">
                    {m.duties_done}/{m.duties}
                  </Td>
                  <Td>
                    <LogDuty memberID={m.id} onSaved={refresh} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="grid gap-7 lg:grid-cols-2">
          <NewPosition onSaved={refresh} />
          <SeatMember positions={positions} onSaved={refresh} />
        </div>
      </PageBody>
    </>
  )
}

function LogDuty({ memberID, onSaved }: { memberID: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [duty, setDuty] = useState('')
  const [performed, setPerformed] = useState(true)

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/council/duties', {
        member_id: memberID,
        duty,
        performed,
      }),
    onSuccess: () => {
      setDuty('')
      setOpen(false)
      onSaved()
    },
  })

  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Log duty
      </Button>
    )

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={duty}
        onChange={setDuty}
        placeholder="Ran the assembly rota"
        className="w-52"
      />
      <Checkbox checked={performed} onChange={setPerformed} label="Done" />
      <Button size="sm" disabled={save.isPending || !duty.trim()} onClick={() => save.mutate()}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <FormNotice error={save.error} />
    </div>
  )
}

function NewPosition({ onSaved }: { onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [portfolio, setPortfolio] = useState('')
  const [seats, setSeats] = useState('1')
  const [elected, setElected] = useState(true)
  const [description, setDescription] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/council/positions', {
        title,
        portfolio,
        seats: Number(seats) || 1,
        is_elected: elected,
        description,
      }),
    onSuccess: () => {
      setTitle('')
      setPortfolio('')
      setDescription('')
      onSaved()
    },
  })

  return (
    <Card>
      <CardHeader
        title="Define a post"
        description="Four house captains are one post with four seats, not four posts."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Title" required>
            <Input value={title} onChange={setTitle} placeholder="Head Girl" />
          </Field>
          <Field label="Seats">
            <Input type="number" value={seats} onChange={setSeats} />
          </Field>
          <Field label="Portfolio">
            <Input
              value={portfolio}
              onChange={setPortfolio}
              placeholder="Assembly and discipline"
            />
          </Field>
          <Field label="How filled">
            <Select
              value={elected ? 'elected' : 'appointed'}
              onChange={(v) => setElected(v === 'elected')}
              options={[
                { value: 'elected', label: 'Elected' },
                { value: 'appointed', label: 'Appointed' },
              ]}
            />
          </Field>
          <Field label="Description" wide>
            <Textarea value={description} onChange={setDescription} rows={2} />
          </Field>
        </FormGrid>
        <div className="mt-5 flex items-center gap-3">
          <Button disabled={save.isPending || !title.trim()} onClick={() => save.mutate()}>
            Save post
          </Button>
          <FormNotice error={save.error} />
        </div>
      </div>
    </Card>
  )
}

function SeatMember({
  positions,
  onSaved,
}: {
  positions: Position[]
  onSaved: () => void
}) {
  const [positionID, setPositionID] = useState('')
  const [q, setQ] = useState('')
  const [studentID, setStudentID] = useState('')
  const [electedOn, setElectedOn] = useState('')
  const [votes, setVotes] = useState('')

  const students = useQuery({
    queryKey: ['council-student-search', q],
    queryFn: () =>
      api.get<Page<Student>>(
        '/api/v1/students/?limit=25' + (q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''),
      ),
    placeholderData: keepPreviousData,
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/academics/admin/council/members', {
        position_id: positionID,
        student_id: studentID,
        elected_on: electedOn,
        votes: votes ? Number(votes) : undefined,
      }),
    onSuccess: () => {
      setStudentID('')
      setVotes('')
      onSaved()
    },
  })

  return (
    <Card>
      <CardHeader
        title="Seat a member"
        description="A post with every seat taken refuses another, rather than quietly overfilling."
      />
      <div className="px-5 pb-5">
        <FormGrid>
          <Field label="Post" required>
            <Select
              value={positionID}
              onChange={setPositionID}
              options={positions.map((p) => ({
                value: p.id,
                label: `${p.title} — ${p.vacancies} of ${p.seats} free`,
              }))}
              placeholder="Pick a post"
            />
          </Field>
          <Field label="Find the child">
            <Input value={q} onChange={setQ} placeholder="Name or admission number" />
          </Field>
          <Field label="Student" required wide>
            <Select
              value={studentID}
              onChange={setStudentID}
              options={(students.data?.items ?? []).map((st) => ({
                value: st.id,
                label: `${st.full_name} · ${st.admission_no}`,
              }))}
              placeholder="Pick a child"
            />
          </Field>
          <Field label="Elected on">
            <Input type="date" value={electedOn} onChange={setElectedOn} />
          </Field>
          <Field label="Votes">
            <Input type="number" value={votes} onChange={setVotes} />
          </Field>
        </FormGrid>
        <div className="mt-5 flex items-center gap-3">
          <Button
            disabled={save.isPending || !positionID || !studentID}
            onClick={() => save.mutate()}
          >
            Seat member
          </Button>
          <FormNotice error={save.error} />
        </div>
      </div>
    </Card>
  )
}
