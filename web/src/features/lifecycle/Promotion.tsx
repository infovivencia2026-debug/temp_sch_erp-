import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { api, type List, type Section, type AcademicYear } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Button,
  Select, SkeletonTable, ErrorState, FormNotice, EmptyState, Checkbox,
} from '@/components/ui'

/* Class and section promotion — the one job a school does once a year and
 * cannot get wrong.
 *
 * The endpoint closes the old enrolment rather than deleting it and records
 * promoted_from_id on the new one, so a child's history survives. That matters
 * years later: a transfer certificate has to reconstruct which class they sat
 * in and when, and a promotion that overwrote the previous row would make that
 * unanswerable.
 *
 * Retentions are the reason for the per-student checkboxes. A whole section
 * moving up is the common case, but the two children repeating the year are
 * exactly the case a bulk-only button gets wrong.
 */

interface Student {
  id: string
  admission_no: string
  full_name: string
  roll_no?: number
}

export default function Promotion() {
  const qc = useQueryClient()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [year, setYear] = useState('')
  const [held, setHeld] = useState<Set<string>>(new Set())
  const [result, setResult] = useState('')

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const years = useQuery({
    queryKey: ['years'],
    queryFn: () => api.get<List<AcademicYear>>('/api/v1/academics/years'),
  })
  const roster = useQuery({
    queryKey: ['section-roster', from],
    queryFn: () => api.get<List<Student>>(`/api/v1/students?section_id=${from}&limit=200`),
    enabled: !!from,
  })

  const promote = useMutation({
    mutationFn: () => {
      const all = (roster.data?.items ?? []).map((s) => s.id)
      const moving = all.filter((id) => !held.has(id))
      return api.post<{ promoted: number }>('/api/v1/lifecycle/promote', {
        from_section_id: from,
        to_section_id: to,
        academic_year_id: year,
        // Omitted entirely when nobody is held back, so the server takes its
        // "whole section" path rather than a list that happens to be complete.
        ...(held.size ? { student_ids: moving } : {}),
      })
    },
    onSuccess: (r) => {
      setResult(
        `${r.promoted} promoted${held.size ? `, ${held.size} held back` : ''}.`,
      )
      setHeld(new Set())
      qc.invalidateQueries({ queryKey: ['section-roster'] })
      qc.invalidateQueries({ queryKey: ['sections'] })
    },
  })

  const sectionOpts = (sections.data?.items ?? []).map((s) => ({
    value: s.id,
    label: `${s.class_name}-${s.name} (${s.enrolled})`,
  }))
  const students = roster.data?.items ?? []
  const moving = students.length - held.size
  const ready = from && to && year && from !== to && students.length > 0

  function toggle(id: string) {
    setHeld((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <>
      <PageHead
        eyebrow="Students"
        title="Class & section promotion"
        description="Roll a section into next year's section. The previous enrolment is closed, not deleted, so each child's academic history stays intact."
      />
      <PageBody>
        <Card>
          <CardHeader title="Choose the move" />
          <div className="grid gap-4 p-5 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">From section</span>
              <Select value={from} onChange={setFrom} options={sectionOpts} placeholder="Select…" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">To section</span>
              <Select value={to} onChange={setTo} options={sectionOpts} placeholder="Select…" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Into academic year</span>
              <Select
                value={year}
                onChange={setYear}
                options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
                placeholder="Select…"
              />
            </label>
          </div>
          {from && to && from === to && (
            <p className="px-5 pb-4 text-[13px] text-destructive">
              The source and destination are the same section.
            </p>
          )}
          <FormNotice error={promote.error} ok={result} />
        </Card>

        {!from ? (
          <Card>
            <div className="p-6">
              <EmptyState
                title="Pick a section to start"
                body="Its roster appears here so you can hold individual children back before promoting the rest."
              />
            </div>
          </Card>
        ) : roster.isLoading ? (
          <SkeletonTable columns={4} />
        ) : roster.error ? (
          <ErrorState error={roster.error} />
        ) : (
          <Card>
            <CardHeader
              title={`Roster — ${students.length} enrolled`}
              description={
                held.size
                  ? `${moving} will move up, ${held.size} held back`
                  : 'Tick a child to hold them back'
              }
              action={
                <Button
                  disabled={!ready || promote.isPending}
                  onClick={() => promote.mutate()}
                >
                  {promote.isPending
                    ? 'Promoting…'
                    : `Promote ${moving} student${moving === 1 ? '' : 's'}`}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              }
            />
            <Table
              head={['Hold back', 'Roll', 'Admission no.', 'Name']}
              empty={!students.length}
              emptyLabel="Nobody is actively enrolled in this section."
            >
              {students.map((s) => (
                <tr key={s.id} className={held.has(s.id) ? 'opacity-60' : undefined}>
                  <Td>
                    <Checkbox
                      checked={held.has(s.id)}
                      onChange={() => toggle(s.id)}
                      label=""
                      srLabel={`Hold ${s.full_name} back in this class`}
                    />
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{s.roll_no ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                  <Td className="font-medium">{s.full_name}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}
