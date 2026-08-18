import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Languages, UserX } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useTeachingSubjects } from './teaching'
import {
  LANGUAGE_SLOTS, labelOf,
  type LanguageAllocation as Allocation, type LanguageElection, type LanguageOption,
} from './classroom'

/* Who sits in which language group.

   An Indian school offers a choice of second and third language, and the
   choice decides which class-subject a child sits in and which paper they
   write. So an option here is not a new kind of subject: it is one of the
   class-subjects the school already teaches, named as an alternative in one
   slot. Everything downstream — the timetable, the mark sheet, the exam entry
   — keys off the same class_subject_id it always did.

   Three questions in the order a school asks them: who is in which group, who
   has still not chosen, and whose two languages are timetabled against each
   other. The last is only answerable because an election points at a real
   class-subject; a standalone language table could not have found it. */

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export default function LanguageAllocation() {
  const toast = useToast()
  const qc = useQueryClient()
  const subjects = useTeachingSubjects()
  const [classID, setClassID] = useState('')
  const [slot, setSlot] = useState('second')
  const [classSubjectID, setClassSubjectID] = useState('')
  const [capacity, setCapacity] = useState('')
  const [electStudent, setElectStudent] = useState('')
  const [electOption, setElectOption] = useState('')

  const classes = [
    ...new Map(
      (subjects.data?.items ?? []).map((s) => [s.class_id, s.class_name]),
    ).entries(),
  ].map(([value, label]) => ({ value, label }))

  const options = useQuery({
    queryKey: ['classroom-language-options', classID],
    queryFn: () =>
      api.get<List<LanguageOption>>(
        `/api/v1/classroom/languages/options${classID ? `?class_id=${classID}` : ''}`,
      ),
  })

  const allocation = useQuery({
    enabled: !!classID,
    queryKey: ['classroom-language-allocation', classID],
    queryFn: () =>
      api.get<Allocation>(`/api/v1/classroom/languages/allocation?class_id=${classID}`),
  })

  const elections = useQuery({
    queryKey: ['classroom-language-elections'],
    queryFn: () => api.get<List<LanguageElection>>('/api/v1/classroom/languages/elections'),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['classroom-language-options'] })
    qc.invalidateQueries({ queryKey: ['classroom-language-allocation'] })
    qc.invalidateQueries({ queryKey: ['classroom-language-elections'] })
  }

  const addOption = useMutation({
    mutationFn: () =>
      api.post('/api/v1/classroom/languages/options', {
        class_subject_id: classSubjectID,
        slot,
        capacity: capacity ? Number(capacity) : null,
      }),
    onSuccess: () => {
      toast.ok('Option saved')
      setClassSubjectID('')
      setCapacity('')
      invalidate()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  const elect = useMutation({
    mutationFn: () =>
      api.post('/api/v1/classroom/languages/elections', {
        student_id: electStudent,
        option_id: electOption,
      }),
    onSuccess: () => {
      toast.ok('Election recorded')
      setElectStudent('')
      invalidate()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not record'),
  })

  if (subjects.isLoading) return <Loading />
  if (subjects.error) return <ErrorState error={subjects.error} />

  const alloc = allocation.data
  const optionRows = options.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="My classes"
        title="Language subject allocation"
        description="First, second and third language per child, and the groups they produce."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Options offered" value={optionRows.length} icon={Languages} />
          <Stat label="Children placed" value={elections.data?.items.length ?? 0} />
          <Stat label="Not yet chosen" value={alloc?.unchosen.length ?? 0} icon={UserX} />
          <Stat
            label="Timetable clashes"
            value={alloc?.clashes.length ?? 0}
            icon={AlertTriangle}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="What this class offers"
            description="Each option is an existing class subject, named as a choice in one slot."
          />
          <div className="p-5 space-y-5">
            <FormGrid>
              <Field label="Class">
                <Select
                  value={classID}
                  onChange={setClassID}
                  options={classes}
                  placeholder="Choose a class…"
                />
              </Field>
              <Field label="Slot">
                <Select
                  value={slot}
                  onChange={setSlot}
                  options={LANGUAGE_SLOTS.map((o) => ({ ...o }))}
                />
              </Field>
              <Field label="Subject">
                <Select
                  value={classSubjectID}
                  onChange={setClassSubjectID}
                  placeholder="Choose a subject…"
                  options={(subjects.data?.items ?? [])
                    .filter((s) => !classID || s.class_id === classID)
                    .map((s) => ({
                      value: s.class_subject_id,
                      label: `${s.class_name} · ${s.subject}`,
                    }))}
                />
              </Field>
              <Field label="Group size" hint="Blank means no cap.">
                <Input value={capacity} onChange={setCapacity} />
              </Field>
            </FormGrid>
            <FormNotice error={addOption.error} />
            <Button
              onClick={() => addOption.mutate()}
              disabled={!classSubjectID || addOption.isPending}
            >
              Add option
            </Button>
          </div>
          <Table
            head={['Class', 'Slot', 'Subject', 'Elected', 'Group size']}
            empty={optionRows.length === 0}
            emptyLabel="No language options defined yet."
          >
            {optionRows.map((o) => (
              <tr key={o.id}>
                <Td>{o.class_name}</Td>
                <Td>{labelOf(LANGUAGE_SLOTS, o.slot)}</Td>
                <Td>{o.display_name || o.subject_name}</Td>
                <Td>{o.elected_count}</Td>
                <Td>{o.capacity ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        {!classID && (
          <EmptyState
            title="Choose a class"
            body="The allocation, the children who have not chosen and the clashes are all per class."
          />
        )}

        {alloc && (
          <>
            <Card>
              <CardHeader title="The groups" description="What the allocation produces." />
              <Table
                head={['Slot', 'Group', 'Confirmed', 'Proposed', 'Sections', 'Over capacity']}
                empty={alloc.groups.length === 0}
                emptyLabel="Nothing allocated yet."
              >
                {alloc.groups.map((g) => (
                  <tr key={g.option_id}>
                    <Td>{labelOf(LANGUAGE_SLOTS, g.slot)}</Td>
                    <Td>{g.subject_name}</Td>
                    <Td>{g.elected}</Td>
                    <Td>{g.proposed}</Td>
                    <Td>{g.sections.join(', ') || '—'}</Td>
                    <Td>
                      {g.over_capacity_by > 0 ? (
                        <Badge tone="warning">{g.over_capacity_by} over</Badge>
                      ) : (
                        '—'
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card>
              <CardHeader
                title="Not yet chosen"
                description="A slot with no option defined for this class is never counted as missing."
              />
              <Table
                head={['Adm no', 'Child', 'Section', 'Missing']}
                empty={alloc.unchosen.length === 0}
                emptyLabel="Every child has chosen."
              >
                {alloc.unchosen.map((u) => (
                  <tr key={u.student_id}>
                    <Td>{u.admission_no}</Td>
                    <Td>{u.student_name}</Td>
                    <Td>{u.section}</Td>
                    <Td>{u.missing_slots.map((s) => labelOf(LANGUAGE_SLOTS, s)).join(', ')}</Td>
                  </tr>
                ))}
              </Table>
              {alloc.unchosen.length > 0 && (
                <div className="p-5 space-y-5">
                  <FormGrid>
                    <Field label="Child">
                      <Select
                        value={electStudent}
                        onChange={setElectStudent}
                        placeholder="Choose a child…"
                        options={alloc.unchosen.map((u) => ({
                          value: u.student_id,
                          label: `${u.admission_no} · ${u.student_name}`,
                        }))}
                      />
                    </Field>
                    <Field label="Language">
                      <Select
                        value={electOption}
                        onChange={setElectOption}
                        placeholder="Choose a group…"
                        options={optionRows
                          .filter((o) => o.is_active)
                          .map((o) => ({
                            value: o.id,
                            label: `${labelOf(LANGUAGE_SLOTS, o.slot)} · ${o.subject_name}`,
                          }))}
                      />
                    </Field>
                  </FormGrid>
                  <FormNotice error={elect.error} />
                  <Button
                    onClick={() => elect.mutate()}
                    disabled={!electStudent || !electOption || elect.isPending}
                  >
                    Record election
                  </Button>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Timetable clashes"
                description="Two elected languages timetabled into the same period."
              />
              <Table
                head={['Child', 'Day', 'Period', 'Collides']}
                empty={alloc.clashes.length === 0}
                emptyLabel="No clashes — every child can attend both."
              >
                {alloc.clashes.map((c, i) => (
                  <tr key={`${c.student_id}-${i}`}>
                    <Td>{c.student_name}</Td>
                    <Td>{WEEKDAYS[c.weekday] ?? c.weekday}</Td>
                    <Td>{c.period_name}</Td>
                    <Td>
                      <Badge tone="warning">
                        {c.subject_a} / {c.subject_b}
                      </Badge>
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
