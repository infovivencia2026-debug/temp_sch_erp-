import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Phone, PhoneCall } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Select, Input,
  Field, SkeletonTable, ErrorState, EmptyState, FormNotice,
} from '@/components/ui'

/* Absentee follow-up.
 *
 * The register says who is away; this screen is what a class teacher does next
 * — ring the parent and write down why. One row per absent child, with the
 * father's and mother's numbers as tap-to-call buttons, a call-status the
 * teacher sets, and the reason the parent gave.
 *
 * The same screen reviews a past day: changing the date refetches and shows
 * the call_status and parent_response already stored for it.
 *
 * Nothing is gated here. The server scopes the rows by permission — a class
 * teacher sees only their own sections, and a read.all holder sees the whole
 * school — from the one screen. */

type CallStatus = 'not_called' | 'called' | 'no_answer' | 'reached'

interface Absentee {
  student_id: string
  name: string
  admission_no: string
  father_name?: string
  father_phone?: string
  mother_name?: string
  mother_phone?: string
  call_status: CallStatus
  parent_response?: string
}

interface AbsenteeSection {
  section_id: string
  section_name: string
  class_name: string
  students: Absentee[]
}

interface AbsenteesResponse {
  date: string
  sections: AbsenteeSection[]
}

const STATUS_OPTIONS: { value: CallStatus; label: string }[] = [
  { value: 'not_called', label: 'Not called' },
  { value: 'called', label: 'Called' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'reached', label: 'Reached' },
]

/** Today, as YYYY-MM-DD in the browser's own timezone. */
function today(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

export default function AbsenceFollowup() {
  const [onDate, setOnDate] = useState(today)
  const [sectionId, setSectionId] = useState('')

  const params = new URLSearchParams({ on_date: onDate })
  if (sectionId) params.set('section_id', sectionId)

  const { data, isLoading, error } = useQuery({
    queryKey: ['absentees', onDate, sectionId],
    queryFn: () => api.get<AbsenteesResponse>(`/api/v1/attendance/absentees?${params}`),
  })

  /* The section dropdown is built from what the day returns, but a filtered
     fetch returns only the one section — which would collapse the dropdown to
     that single choice and strand the teacher there. So the full list is
     remembered from the last unfiltered load and kept for the picker. */
  const [allSections, setAllSections] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    if (!sectionId && data?.sections) {
      setAllSections(
        data.sections.map((s) => ({
          value: s.section_id,
          label: `${s.class_name} ${s.section_name}`,
        })),
      )
    }
  }, [data, sectionId])

  const sections = data?.sections ?? []
  const total = sections.reduce((n, s) => n + s.students.length, 0)

  return (
    <>
      <PageHead
        eyebrow="Attendance"
        title="Absentee follow-up"
        actions={
          <>
            <Field label="Date">
              <Input type="date" value={onDate} onChange={setOnDate} />
            </Field>
            <Field label="Section">
              <Select
                value={sectionId}
                onChange={setSectionId}
                placeholder="All sections"
                options={allSections}
              />
            </Field>
          </>
        }
      />
      <PageBody>
        {isLoading ? (
          <SkeletonTable columns={5} />
        ) : error ? (
          <ErrorState error={error} />
        ) : total === 0 ? (
          <EmptyState
            title="Nobody is marked absent for this day."
            body="Once attendance is taken and a child is marked away, they appear here for a call home."
          />
        ) : (
          sections
            .filter((s) => s.students.length > 0)
            .map((s) => (
              <Card key={s.section_id}>
                <CardHeader
                  title={`${s.class_name} ${s.section_name}`}
                  description={`${s.students.length} absent`}
                />
                <div className="divide-y">
                  {s.students.map((st) => (
                    <AbsenteeRow
                      key={st.student_id}
                      student={st}
                      onDate={onDate}
                      sectionId={sectionId}
                    />
                  ))}
                </div>
              </Card>
            ))
        )}
      </PageBody>
    </>
  )
}

/* A phone number, as a button that dials it. Shown only when a number exists,
   so an absent parent contact leaves no dead control behind. */
function CallButton({ name, phone }: { name: string; phone?: string }) {
  if (!phone) {
    return (
      <span className="text-[13px] text-muted-foreground">
        {name || '—'} <span className="text-muted-foreground/70">no number</span>
      </span>
    )
  }
  return (
    <a
      href={`tel:${phone}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[13px] font-medium hover:bg-accent"
    >
      <Phone className="h-3.5 w-3.5" />
      <span className="min-w-0">
        <span className="block truncate">{name || 'Call'}</span>
        <span className="block font-mono text-[12px] text-muted-foreground">{phone}</span>
      </span>
    </a>
  )
}

function AbsenteeRow({
  student,
  onDate,
  sectionId,
}: {
  student: Absentee
  onDate: string
  sectionId: string
}) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<CallStatus>(student.call_status ?? 'not_called')
  const [response, setResponse] = useState(student.parent_response ?? '')

  const save = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>('/api/v1/attendance/absentees/followup', {
        student_id: student.student_id,
        on_date: onDate,
        call_status: status,
        parent_response: response,
      }),
    onSuccess: () => {
      // Keep the reviewed-day view in step, without disturbing this row's own
      // in-progress edits — the mutation state carries the tick.
      qc.invalidateQueries({ queryKey: ['absentees', onDate, sectionId] })
    },
  })

  // Editing after a save clears the saved tick, so it never claims the row is
  // stored when the box no longer matches what was sent.
  const dirty = status !== (student.call_status ?? 'not_called') ||
    response !== (student.parent_response ?? '')
  const saved = save.isSuccess && !dirty

  return (
    <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="min-w-0 space-y-2">
        <div>
          <span className="text-[14px] font-medium">{student.name}</span>
          <span className="ml-2 font-mono text-[12px] text-muted-foreground">
            {student.admission_no}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CallButton name={student.father_name ?? 'Father'} phone={student.father_phone} />
          <CallButton name={student.mother_name ?? 'Mother'} phone={student.mother_phone} />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:w-[420px]">
        <div className="grid gap-2 sm:grid-cols-[150px_1fr]">
          <Select
            value={status}
            onChange={(v) => setStatus(v as CallStatus)}
            options={STATUS_OPTIONS}
          />
          <Input
            value={response}
            onChange={setResponse}
            placeholder="Why absent — the parent's reason"
            srLabel="Parent's reason for the absence"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || saved}>
            {saved ? (
              <>
                <Check className="h-3.5 w-3.5" /> Saved
              </>
            ) : (
              <>
                <PhoneCall className="h-3.5 w-3.5" /> {save.isPending ? 'Saving…' : 'Save'}
              </>
            )}
          </Button>
        </div>
        {save.isError && <FormNotice error={save.error} />}
      </div>
    </div>
  )
}
