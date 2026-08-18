import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, LayoutGrid, ShieldCheck, Ticket } from 'lucide-react'
import { api, ApiError, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice, Input, Select,
  Loading, ErrorState, EmptyState, PrintButton, useSort,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* Exam day, from both sides.

   The office seats an exam and prints the invigilator's plan; a candidate and
   their parents read one ticket. Both live here because they are the same
   allocation viewed at different scales, and a school that reseats a hall must
   see the tickets change with it.

   Which half you get is decided by whether you can write exams, not by a
   separate screen — the family never sees the seating controls, and the office
   never has to hunt for a child's ticket in a different part of the product. */

interface Hall {
  id: string
  name: string
  rows: number
  cols: number
  capacity: number
  seats_allocated: number
}
interface Exam {
  id: string
  name: string
  starts_on?: string
}
interface Seat {
  ticket_no: string
  student_name: string
  admission_no: string
  class_name: string
  hall: string
  row: number
  col: number
}
interface Paper {
  subject: string
  date?: string
  starts_at?: string
  duration_minutes?: number
  max_marks?: number
}
interface TicketView {
  ticket_no: string
  student_name: string
  admission_no: string
  class_name: string
  section_name: string
  exam_name: string
  board?: string
  hall: string
  seat: string
  school: string
  papers: Paper[]
  verification_code: string
  instructions: string[]
}
interface Child {
  student_id: string
  full_name: string
  class_name?: string
  section_name?: string
}

export default function HallTicket() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  const isStaff = session.data?.permissions.includes('academics.exams.write') ?? false

  const exams = useQuery({
    queryKey: ['exams'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })
  const [examId, setExamId] = useState('')
  const exam = examId || exams.data?.items[0]?.id || ''

  if (exams.isLoading) return <Loading />
  if (exams.error) return <ErrorState error={exams.error} />
  if (!exam) {
    return (
      <>
        <PageHead eyebrow="Examinations" title="Hall tickets" />
        <PageBody>
          <EmptyState
            title="No exam scheduled"
            body="Schedule an exam first; seating and tickets follow from it."
          />
        </PageBody>
      </>
    )
  }

  const picker = (
    <Select
      value={exam}
      onChange={setExamId}
      options={(exams.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }))}
    />
  )

  return isStaff ? (
    <Seating examId={exam} picker={picker} />
  ) : (
    <MyTicket examId={exam} picker={picker} />
  )
}

/** The office: halls, allocation, and the invigilator's sheet. */
function Seating({ examId, picker }: { examId: string; picker: React.ReactNode }) {
  const qc = useQueryClient()
  const [hall, setHall] = useState('')
  const [adding, setAdding] = useState(false)

  const halls = useQuery({
    queryKey: ['exam-halls'],
    queryFn: () => api.get<List<Hall>>('/api/v1/exams/halls'),
  })
  const plan = useQuery({
    queryKey: ['hall-plan', examId, hall],
    queryFn: () =>
      api.get<List<Seat>>(
        `/api/v1/exams/hall-plan?exam_id=${examId}${hall ? `&hall_id=${hall}` : ''}`,
      ),
  })

  const allocate = useMutation({
    mutationFn: () => api.post('/api/v1/exams/seats/allocate', { exam_id: examId }),
    onSuccess: () => qc.invalidateQueries(),
  })

  const seats = plan.data?.items ?? []
  const sort = useSort<Seat>(
    seats,
    (s, k) => (s as unknown as Record<string, string | number>)[k],
    { key: 'ticket_no' },
  )

  const capacity = (halls.data?.items ?? []).reduce((n, h) => n + h.capacity, 0)

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Seating and hall tickets"
        description="Allocate candidates to halls, then print the invigilator's plan. Re-running replaces the whole allocation."
        actions={
          <>
            {picker}
            <PrintButton label="Print plan" />
          </>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Seated" value={seats.length} icon={Ticket} />
          <Stat label="Halls" value={halls.data?.items.length ?? 0} icon={Building2} />
          <Stat label="Capacity" value={capacity} icon={LayoutGrid} />
          <Stat
            label="Spare seats"
            value={Math.max(0, capacity - seats.length)}
            delta={
              capacity && seats.length > capacity
                ? { value: 'Over capacity', positive: false }
                : undefined
            }
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Halls"
            description="A grid, not a headcount — an invigilator calls a row and a seat."
            action={
              <>
                <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
                  {adding ? 'Cancel' : 'Add hall'}
                </Button>
                <Button disabled={allocate.isPending} onClick={() => allocate.mutate()}>
                  {allocate.isPending ? 'Allocating…' : 'Allocate seats'}
                </Button>
              </>
            }
          />
          {adding && <AddHall onDone={() => setAdding(false)} />}
          {(halls.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No halls yet"
              body="Add the rooms this exam will be written in, then allocate."
            />
          ) : (
            <Table head={['Hall', 'Grid', 'Capacity', 'Seated']}>
              {(halls.data?.items ?? []).map((h) => (
                <tr key={h.id}>
                  <Td className="font-medium">{h.name}</Td>
                  <Td className="text-muted-foreground">
                    {h.rows} × {h.cols}
                  </Td>
                  <Td className="tabular-nums">{h.capacity}</Td>
                  <Td className="tabular-nums">{h.seats_allocated}</Td>
                </tr>
              ))}
            </Table>
          )}
          <FormNotice error={allocate.error} />
        </Card>

        <Card>
          <CardHeader
            title="Seating plan"
            description={`${seats.length} candidates — neighbours are drawn from different sections`}
            action={
              <Select
                value={hall}
                onChange={setHall}
                placeholder="Every hall"
                options={(halls.data?.items ?? []).map((h) => ({ value: h.id, label: h.name }))}
              />
            }
          />
          {seats.length === 0 ? (
            <EmptyState
              title="Not allocated yet"
              body="Allocate seats and every candidate gets a desk and a ticket number."
            />
          ) : (
            <Table
              head={[
                { label: 'Ticket', key: 'ticket_no' },
                { label: 'Candidate', key: 'student_name' },
                { label: 'Admission no.', key: 'admission_no' },
                { label: 'Class', key: 'class_name' },
                { label: 'Hall', key: 'hall' },
                { label: 'Seat', key: 'row' },
              ]}
              sort={sort}
            >
              {sort.sorted.map((s) => (
                <tr key={s.ticket_no}>
                  <Td className="font-mono font-medium">{s.ticket_no}</Td>
                  <Td className="font-medium">{s.student_name}</Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">{s.admission_no}</Td>
                  <Td>{s.class_name}</Td>
                  <Td>{s.hall}</Td>
                  <Td className="tabular-nums">
                    Row {s.row}, Seat {s.col}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function AddHall({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ name: '', rows: '6', cols: '6' })
  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/exams/halls', {
        name: f.name,
        rows: Number(f.rows) || 6,
        cols: Number(f.cols) || 6,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exam-halls'] })
      setF({ name: '', rows: '6', cols: '6' })
      onDone()
    },
  })
  return (
    <form
      className="border-b px-5 py-5"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <FormGrid>
        <Field label="Hall name" required>
          <Input value={f.name} onChange={(x) => setF({ ...f, name: x })} placeholder="Hall A" />
        </Field>
        <Field label="Rows" hint="Desks front to back.">
          <Input value={f.rows} onChange={(x) => setF({ ...f, rows: x })} />
        </Field>
        <Field label="Seats per row">
          <Input value={f.cols} onChange={(x) => setF({ ...f, cols: x })} />
        </Field>
      </FormGrid>
      <FormNotice error={create.error} />
      <div className="mt-4 flex gap-2">
        <Button type="submit" disabled={create.isPending || !f.name.trim()}>
          {create.isPending ? 'Adding…' : 'Add hall'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * The candidate's ticket.
 *
 * Laid out to be printed and carried, because that is what it is for — a
 * candidate is turned away without it. Everything an invigilator checks at the
 * door sits together at the top: name, ticket number, hall, seat and the
 * verification code.
 */
function MyTicket({ examId, picker }: { examId: string; picker: React.ReactNode }) {
  const children = useQuery({
    queryKey: ['portal-children'],
    queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
  })
  const kids = children.data?.items ?? []
  const [picked, setPicked] = useState('')
  const student = picked || kids[0]?.student_id || ''

  const { data, isLoading, error } = useQuery({
    queryKey: ['hall-ticket', examId, student],
    queryFn: () =>
      api.get<TicketView>(`/api/v1/hpc/hall-ticket?exam_id=${examId}&student_id=${student}`),
    enabled: !!student,
    retry: false,
  })

  /* Four answers, not one spinner.

     `isLoading || !student` held "Loading…" forever whenever the children
     request failed or came back empty, because the ticket query is disabled
     without a student and a disabled query is pending for ever. And every
     failure — 403, 500, a dropped connection — used to be reported as "no
     ticket yet", which tells a candidate to wait for something that is not
     coming. Only the server's 404 (`not_seated`) means the ticket is not
     issued yet; the rest are faults and say so. */
  if (children.isLoading) return <Loading />
  if (children.error) return <ErrorState error={children.error} />
  if (!kids.length)
    return (
      <>
        <PageHead eyebrow="Examinations" title="Hall ticket" actions={picker} />
        <PageBody>
          <EmptyState
            title="No student record linked"
            body="Your account is not linked to a student yet. Ask the school office to connect it."
          />
        </PageBody>
      </>
    )
  if (isLoading) return <Loading />
  if (error) {
    const notSeated = error instanceof ApiError && error.status === 404
    return (
      <>
        <PageHead eyebrow="Examinations" title="Hall ticket" actions={picker} />
        <PageBody>
          {notSeated ? (
            <EmptyState
              title="No ticket yet"
              body="The school issues tickets once seating is done. It will appear here."
            />
          ) : (
            <ErrorState error={error} />
          )}
        </PageBody>
      </>
    )
  }
  if (!data)
    return (
      <>
        <PageHead eyebrow="Examinations" title="Hall ticket" actions={picker} />
        <PageBody>
          <EmptyState
            title="No ticket yet"
            body="The school issues tickets once seating is done. It will appear here."
          />
        </PageBody>
      </>
    )
  const t = data

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Hall ticket"
        description="Bring this to every paper. You will not be admitted without it."
        actions={
          <>
            {kids.length > 1 && (
              <Select
                value={student}
                onChange={setPicked}
                options={kids.map((k) => ({
                  value: k.student_id,
                  label: `${k.full_name} · ${k.class_name ?? ''}-${k.section_name ?? ''}`,
                }))}
              />
            )}
            {picker}
            <PrintButton label="Print ticket" />
          </>
        }
      />
      <PageBody width="form">
        <Card>
          <div className="border-b px-6 py-5">
            <p className="text-[13px] text-muted-foreground">{t.school}</p>
            <h2 className="mt-1 text-[20px] font-semibold tracking-[-0.015em]">
              {t.exam_name}
              {t.board && <span className="text-muted-foreground"> · {t.board}</span>}
            </h2>
          </div>

          {/* What the invigilator checks, in the order they check it. */}
          <dl className="grid gap-x-8 gap-y-4 px-6 py-5 sm:grid-cols-2">
            <Detail label="Candidate" value={t.student_name} strong />
            <Detail label="Ticket number" value={t.ticket_no} mono strong />
            <Detail label="Admission number" value={t.admission_no} mono />
            <Detail label="Class" value={`${t.class_name}-${t.section_name}`} />
            <Detail label="Hall" value={t.hall} strong />
            <Detail label="Seat" value={t.seat} strong />
          </dl>

          <div className="flex items-center gap-3 border-t px-6 py-4">
            <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
            <div>
              <p className="text-[12px] text-muted-foreground">Verification code</p>
              <p className="font-mono text-[16px] tracking-wider">{t.verification_code}</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Papers" description={`${t.papers.length} in this examination`} />
          <Table head={['Subject', 'Date', 'Time', 'Duration', 'Marks']}>
            {t.papers.map((p, i) => (
              <tr key={i}>
                <Td className="font-medium">{p.subject}</Td>
                <Td>{p.date ? formatDate(p.date) : 'To be announced'}</Td>
                <Td>{p.starts_at ?? '—'}</Td>
                <Td>{p.duration_minutes ? `${p.duration_minutes} min` : '—'}</Td>
                <Td className="tabular-nums">{p.max_marks ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title="Instructions" />
          <ul className="space-y-2 px-6 py-5">
            {t.instructions.map((line, i) => (
              <li key={i} className="flex gap-2 text-[14px]">
                <Badge tone="neutral">{i + 1}</Badge>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Card>
      </PageBody>
    </>
  )
}

function Detail({
  label,
  value,
  mono,
  strong,
}: {
  label: string
  value: string
  mono?: boolean
  strong?: boolean
}) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd
        className={[
          'mt-0.5',
          mono ? 'font-mono' : '',
          strong ? 'text-[16px] font-semibold' : 'text-[15px]',
        ].join(' ')}
      >
        {value}
      </dd>
    </div>
  )
}
