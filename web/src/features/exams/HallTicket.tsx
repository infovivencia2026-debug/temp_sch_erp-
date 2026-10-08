import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, LayoutGrid, Printer, Ticket } from 'lucide-react'
import { api, ApiError, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Button, Field, FormGrid, FormNotice, Input, Select,
  Loading, SkeletonTiles, ErrorState, EmptyState, PrintButton, useSort,
} from '@/components/ui'
import { useSession } from '@/lib/session'
import A4Frame from '@/components/A4Frame'
import { printHtml } from '@/features/finance/receipt-print'
import { hallTicketHtml } from './hall-ticket-print'

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
  photo_file_id?: string
  father_name?: string
  guardian_relation?: string
  academic_year?: string
  affiliation_no?: string
  affiliation_board?: string
  place?: string
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
    queryFn: () => api.call('GET /session'),
  })
  const isStaff = session.data?.permissions.includes('academics.exams.write') ?? false

  /* A student or parent asks for the exams they are seated in; the office list is not theirs. */
  const exams = useQuery({
    queryKey: ['exams', isStaff],
    queryFn: () => (isStaff ? api.call('GET /exams/list') : api.get<List<{ id: string; name: string }>>('/api/v1/hpc/my-exams')),
    enabled: !session.isLoading,
  })
  const [examId, setExamId] = useState('')
  const exam = examId || exams.data?.items[0]?.id || ''

  if (session.isLoading || (exams.isLoading && !exams.data)) return <SkeletonTiles count={4} />
  if (exams.error) return <ErrorState error={exams.error} />
  if (!exam) {
    return (
      <>
        <PageHead eyebrow="Examinations" title="Hall tickets" />
        <PageBody>
          <EmptyState
            title={isStaff ? 'No exam scheduled' : 'No hall ticket yet'}
            body={isStaff ? 'Schedule an exam first; seating and tickets follow from it.' : 'The school issues tickets once seating is done. It will appear here.'}
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hall-plan', examId] })
      qc.invalidateQueries({ queryKey: ['hall-ticket', examId] })
      qc.invalidateQueries({ queryKey: ['exams'] })
    },
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
        title="Seating plan"
        description="Allocate candidates to halls, then print the plan. Re-running replaces it."
        actions={
          <>
            {picker}
            <PrintButton label="Print" title="Seating plan" />
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
            description="A grid, not a headcount: a row and a seat."
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
            description={`${seats.length} candidates, neighbours from different sections`}
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
  const session = useSession()
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
  const relation = (t.guardian_relation ?? '').toLowerCase()
  const html = hallTicketHtml({
    school: t.school,
    logoUrl: session.institution?.logo_key ? `${location.origin}/api/v1/files/${session.institution.logo_key}?inline=1` : undefined,
    photoUrl: t.photo_file_id ? `${location.origin}/api/v1/files/${t.photo_file_id}?inline=1` : undefined,
    affiliation: t.affiliation_no ? `${t.affiliation_board ? t.affiliation_board.toUpperCase() + ' ' : ''}Affiliation No: ${t.affiliation_no}` : undefined,
    place: t.place,
    examName: t.exam_name, academicYear: t.academic_year,
    studentName: t.student_name,
    guardianLabel: relation === 'father' || !relation ? "Father's Name" : relation === 'mother' ? "Mother's Name" : "Guardian's Name",
    guardianName: t.father_name,
    ticketNo: t.ticket_no, admissionNo: t.admission_no,
    classSection: [t.class_name, t.section_name && `Section ${t.section_name}`].filter(Boolean).join(' - '),
    hall: t.hall, seat: t.seat, papers: t.papers, instructions: t.instructions, verificationCode: t.verification_code,
  })

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Hall ticket"
        description="Bring this to every paper."
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
            <Button onClick={() => printHtml(html)}><Printer className="h-4 w-4" /> Print ticket</Button>
          </>
        }
      />
      <PageBody>
        {/* The ticket as it prints, at A4, on every screen size. */}
        <A4Frame html={html} title="Hall ticket" />
      </PageBody>
    </>
  )
}
