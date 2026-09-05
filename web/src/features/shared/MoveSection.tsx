import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, ApiError, type List, type Section, type Student } from '@/lib/api'
import { Button, Card, Field, FormNotice, Input, Select } from '@/components/ui'

/* One child, one new section. Class first, then the section in it, then
   the roll number if the office has one ready; the server keeps the old
   roll number when none is given. A full section is refused with the count
   and offered "Move anyway", which is the same override admissions has. */
export default function MoveSection({
  student,
  onDone,
  onCancel,
}: {
  student: Student
  onDone: (where: string) => void
  onCancel: () => void
}) {
  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const [classId, setClassId] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [rollNo, setRollNo] = useState('')
  const classes = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of sections.data?.items ?? []) seen.set(s.class_id, s.class_name)
    return [...seen].map(([value, label]) => ({ value, label }))
  }, [sections.data])
  const inClass = (sections.data?.items ?? []).filter((s) => s.class_id === classId)
  const move = useMutation({
    mutationFn: (allowOverflow: boolean) =>
      api.post<{ class: string; section: string }>(`/api/v1/students/${student.id}/section`, {
        section_id: sectionId,
        roll_no: rollNo ? Number(rollNo) : undefined,
        allow_overflow: allowOverflow,
      }),
    onSuccess: (r) => onDone(`${r.class}-${r.section}`),
  })
  const full = move.error instanceof ApiError && move.error.code === 'no_seats'
  return (
    <Card className="p-5">
      <p className="text-[15px] font-medium">Move {student.first_name} to another section</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Now in {[student.class_name, student.section_name].filter(Boolean).join('-') || 'no section'}.
        Attendance and marks already recorded stay where they were taken.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Class">
          <Select
            value={classId}
            onChange={(v) => {
              setClassId(v)
              setSectionId('')
            }}
            options={classes}
            placeholder={sections.isLoading ? 'Loading…' : 'Choose a class'}
          />
        </Field>
        <Field label="Section">
          <Select
            value={sectionId}
            onChange={setSectionId}
            options={inClass.map((s) => ({
              value: s.id,
              label: s.capacity > 0 ? `${s.name} · ${s.enrolled} of ${s.capacity}` : s.name,
            }))}
            placeholder={classId ? 'Choose a section' : 'Class first'}
          />
        </Field>
        <Field label="Roll number" hint="Leave blank to keep the current one.">
          <Input value={rollNo} onChange={setRollNo} placeholder="14" />
        </Field>
      </div>
      {move.error && !full && (
        <div className="mt-3"><FormNotice error={move.error} /></div>
      )}
      {full && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          {move.error instanceof Error ? move.error.message : 'That section is full.'}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {full ? (
          <Button onClick={() => move.mutate(true)} pending={move.isPending}>
            Move anyway
          </Button>
        ) : (
          <Button onClick={() => move.mutate(false)} disabled={!sectionId} pending={move.isPending}>
            Move
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}
