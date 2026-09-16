import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCircle2, Phone } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Select, Input,
  Field, SkeletonTable, ErrorState, EmptyState, FormNotice,
} from '@/components/ui'

/* Absentee follow-up.
 *
 * The register says who is away; this screen is what the office does next —
 * ring the parent and write down why. The day's absentees come grouped by
 * section; each row shows the child, admission number, and the father's and
 * mother's numbers as tap-to-call buttons, with a Pending/Called dropdown and
 * the reason the parent gave.
 *
 * The office works one section at a time: fill in the rows, then press Done
 * at the bottom of the section. Done saves every row in that section in one
 * go and stamps the section as finished, by whom and when.
 *
 * The same screen reviews a past day: changing the date refetches and shows
 * the responses already stored, and which sections were finished.
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
  done: boolean
  done_by?: string
  done_at?: string
}

interface AbsenteesResponse {
  date: string
  sections: AbsenteeSection[]
}

/* Two choices on the dropdown: has this family been rung or not. Older rows
   may carry 'no_answer'/'reached' from before the dropdown was simplified;
   those still display, under their own label, until the row is re-saved. */
const STATUS_OPTIONS: { value: CallStatus; label: string }[] = [
  { value: 'not_called', label: 'Pending' },
  { value: 'called', label: 'Called' },
]
const LEGACY_LABEL: Partial<Record<CallStatus, string>> = {
  no_answer: 'No answer',
  reached: 'Reached',
}

function statusOptions(current: CallStatus) {
  const legacy = LEGACY_LABEL[current]
  return legacy ? [...STATUS_OPTIONS, { value: current, label: legacy }] : STATUS_OPTIONS
}

/** Today, as YYYY-MM-DD in the browser's own timezone. */
function today(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

function fmtStamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })
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
  const pending = sections.reduce(
    (n, s) => n + s.students.filter((st) => st.call_status === 'not_called').length,
    0,
  )

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
          <>
            <p className="text-[13px] text-muted-foreground">
              {total} absent · {pending} pending ·{' '}
              {sections.filter((s) => s.done).length}/{sections.length} sections done
            </p>
            {sections
            .filter((s) => s.students.length > 0)
            .map((s) => (
              <SectionCard
                key={`${s.section_id}:${onDate}`}
                section={s}
                onDate={onDate}
                filterSectionId={sectionId}
              />
            ))}
          </>
        )}
      </PageBody>
    </>
  )
}

/* One section's absentees, edited together and saved with one Done. The edits
   live here (keyed by student) so Done can send every row in one request. */
function SectionCard({
  section,
  onDate,
  filterSectionId,
}: {
  section: AbsenteeSection
  onDate: string
  filterSectionId: string
}) {
  const qc = useQueryClient()

  type Edit = { call_status: CallStatus; parent_response: string }
  const initial = (): Record<string, Edit> =>
    Object.fromEntries(
      section.students.map((st) => [
        st.student_id,
        { call_status: st.call_status ?? 'not_called', parent_response: st.parent_response ?? '' },
      ]),
    )
  const [edits, setEdits] = useState<Record<string, Edit>>(initial)

  // A refetch (after Done, or another person's save) brings new stored values;
  // adopt them only where this section has no unsaved change of its own.
  useEffect(() => {
    setEdits((prev) => {
      const next = { ...prev }
      for (const st of section.students) {
        if (!next[st.student_id]) {
          next[st.student_id] = {
            call_status: st.call_status ?? 'not_called',
            parent_response: st.parent_response ?? '',
          }
        }
      }
      return next
    })
  }, [section.students])

  const dirty = section.students.some((st) => {
    const e = edits[st.student_id]
    return e && (e.call_status !== (st.call_status ?? 'not_called') ||
      e.parent_response !== (st.parent_response ?? ''))
  })

  const finish = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>('/api/v1/attendance/absentees/section-done', {
        section_id: section.section_id,
        on_date: onDate,
        entries: section.students.map((st) => ({
          student_id: st.student_id,
          ...edits[st.student_id],
        })),
      }),
    onSuccess: () => {
      // Drop local edits so the refetched, stored values become the baseline.
      setEdits({})
      qc.invalidateQueries({ queryKey: ['absentees', onDate, filterSectionId] })
    },
  })

  const called = section.students.filter(
    (st) => edits[st.student_id]?.call_status !== 'not_called',
  ).length

  return (
    <Card>
      <CardHeader
        title={`${section.class_name} ${section.section_name}`}
        description={`${section.students.length} absent · ${called} called`}
        action={
          section.done && section.done_at ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Done{section.done_by ? ` by ${section.done_by}` : ''} · {fmtStamp(section.done_at)}
            </span>
          ) : undefined
        }
      />
      <div className="divide-y">
        {section.students.map((st) => {
          const e = edits[st.student_id] ?? {
            call_status: st.call_status ?? 'not_called',
            parent_response: st.parent_response ?? '',
          }
          return (
            <AbsenteeRow
              key={st.student_id}
              student={st}
              edit={e}
              onChange={(patch) =>
                setEdits((prev) => ({ ...prev, [st.student_id]: { ...e, ...patch } }))
              }
            />
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3">
        {finish.isError && <FormNotice error={finish.error} />}
        {section.done && !dirty && !finish.isPending && (
          <span className="text-[13px] text-muted-foreground">
            All responses for this section are saved.
          </span>
        )}
        <Button onClick={() => finish.mutate()} disabled={finish.isPending}>
          <Check className="h-4 w-4" />
          {finish.isPending
            ? 'Saving…'
            : section.done
              ? dirty ? 'Save changes' : 'Done'
              : 'Done'}
        </Button>
      </div>
    </Card>
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
  edit,
  onChange,
}: {
  student: Absentee
  edit: { call_status: CallStatus; parent_response: string }
  onChange: (patch: Partial<{ call_status: CallStatus; parent_response: string }>) => void
}) {
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

      <div className="grid gap-2 sm:w-[420px] sm:grid-cols-[130px_1fr]">
        <Select
          value={edit.call_status}
          onChange={(v) => onChange({ call_status: v as CallStatus })}
          options={statusOptions(edit.call_status)}
        />
        <Input
          value={edit.parent_response}
          onChange={(v) => onChange({ parent_response: v })}
          placeholder="Why absent — the parent's reason"
          srLabel="Parent's reason for the absence"
        />
      </div>
    </div>
  )
}
