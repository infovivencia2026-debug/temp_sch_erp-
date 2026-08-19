import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Blocks, Eye, Sparkles } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import {
  MONTESSORI_AREAS, MONTESSORI_STAGES, labelOf, todayISO,
  useClassroomSections,
  type MontessoriChild, type MontessoriMaterial, type MontessoriPosition,
} from './classroom'

/* Early years, recorded by observation rather than by marks.

   A three-year-old is not assessed with a paper. A guide presents a material,
   watches the child choose it again over the following weeks, and one morning
   sees them do it unaided and show another child. Presented, practising,
   mastered — with the date and a sentence, and the sequence over months is the
   record. There is no score anywhere on this screen because at this age there
   is nothing to put one on.

   Revisited is its own stage on purpose. A child who had it in July and has
   lost it in October is exactly the thing a guide needs to see, and folding
   that back into "presented" would hide it. */

const STAGE_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning'> = {
  not_presented: 'neutral',
  presented: 'info',
  practising: 'info',
  mastered: 'success',
  revisit: 'warning',
}

export default function MontessoriTracking() {
  const toast = useToast()
  const qc = useQueryClient()
  const sections = useClassroomSections()
  const [sectionID, setSectionID] = useState('')
  const [studentID, setStudentID] = useState('')
  const [area, setArea] = useState('')
  const [materialID, setMaterialID] = useState('')
  const [stage, setStage] = useState('presented')
  const [observedOn, setObservedOn] = useState(todayISO())
  const [note, setNote] = useState('')

  const materials = useQuery({
    queryKey: ['classroom-montessori-materials'],
    queryFn: () =>
      api.get<List<MontessoriMaterial>>('/api/v1/classroom/montessori/materials'),
  })

  const room = useQuery({
    enabled: !!sectionID,
    queryKey: ['classroom-montessori-section', sectionID],
    queryFn: () =>
      api.get<List<MontessoriChild>>(
        `/api/v1/classroom/montessori/section?section_id=${sectionID}`,
      ),
  })

  const child = useQuery({
    enabled: !!studentID,
    queryKey: ['classroom-montessori-child', studentID],
    queryFn: () =>
      api.get<List<MontessoriPosition>>(`/api/v1/classroom/montessori/child/${studentID}`),
  })

  const record = useMutation({
    mutationFn: () =>
      api.post('/api/v1/classroom/montessori/progress', {
        student_id: studentID,
        material_id: materialID,
        stage,
        observed_on: observedOn,
        note: note || null,
      }),
    onSuccess: () => {
      toast.ok('Observation recorded')
      setNote('')
      qc.invalidateQueries({ queryKey: ['classroom-montessori-child', studentID] })
      qc.invalidateQueries({ queryKey: ['classroom-montessori-section', sectionID] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not record'),
  })

  if (sections.isLoading) return <Loading />
  if (sections.error) return <ErrorState error={sections.error} />

  const positions = (child.data?.items ?? []).filter((p) => !area || p.area === area)
  const mastered = positions.filter((p) => p.current_stage === 'mastered').length
  const working = positions.filter(
    (p) => p.current_stage === 'presented' || p.current_stage === 'practising',
  ).length

  return (
    <>
      <PageHead
        eyebrow="My classes"
        title="Montessori & early years tracking"
        description="Where each child stands in the sequence — presented, practising, mastered."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Materials on the shelf" value={materials.data?.items.length ?? 0} icon={Blocks} />
          <Stat label="Children in the room" value={room.data?.items.length ?? 0} />
          <Stat label="Working on" value={working} icon={Eye} />
          <Stat label="Mastered" value={mastered} icon={Sparkles} />
        </CellGrid>

        <Card>
          <CardHeader title="The room" />
          <div className="p-5">
            <FormGrid>
              <Field label="Section">
                <Select
                  value={sectionID}
                  onChange={setSectionID}
                  placeholder="Choose a section…"
                  options={(sections.data?.items ?? []).map((s) => ({
                    value: s.section_id,
                    label: `${s.class_name} · ${s.section_name}`,
                  }))}
                />
              </Field>
              <Field label="Area" hint="Filters the child's sequence below.">
                <Select
                  value={area}
                  onChange={setArea}
                  placeholder="Every area"
                  options={MONTESSORI_AREAS.map((a) => ({ ...a }))}
                />
              </Field>
            </FormGrid>
          </div>
          <Table
            head={['Adm no', 'Child', 'Presented', 'Practising', 'Mastered', 'Last seen', '']}
            empty={(room.data?.items.length ?? 0) === 0}
            emptyLabel="Choose a section to see the room."
          >
            {(room.data?.items ?? []).map((c) => {
              const sum = (k: 'presented' | 'practising' | 'mastered') =>
                c.areas.reduce((n, a) => n + a[k], 0)
              return (
                <tr key={c.student_id}>
                  <Td>{c.admission_no}</Td>
                  <Td>{c.student_name}</Td>
                  <Td>{sum('presented')}</Td>
                  <Td>{sum('practising')}</Td>
                  <Td>{sum('mastered')}</Td>
                  <Td>
                    {c.last_observed_on ?? (
                      <Badge tone="warning">Never observed</Badge>
                    )}
                  </Td>
                  <Td>
                    <Button variant="ghost" onClick={() => setStudentID(c.student_id)}>
                      Open
                    </Button>
                  </Td>
                </tr>
              )
            })}
          </Table>
        </Card>

        {studentID && (
          <Card>
            <CardHeader
              title="Record an observation"
              description="One material, one stage, one date, and the sentence that makes it worth reading."
            />
            <div className="p-5 space-y-5">
              <FormGrid>
                <Field label="Material">
                  <Select
                    value={materialID}
                    onChange={setMaterialID}
                    placeholder="Choose a material…"
                    options={(materials.data?.items ?? [])
                      .filter((m) => !area || m.area === area)
                      .map((m) => ({
                        value: m.id,
                        label: `${labelOf(MONTESSORI_AREAS, m.area)} · ${m.name}`,
                      }))}
                  />
                </Field>
                <Field label="Stage">
                  <Select
                    value={stage}
                    onChange={setStage}
                    options={MONTESSORI_STAGES.map((s) => ({ ...s }))}
                  />
                </Field>
                <Field label="Observed on">
                  <Input value={observedOn} onChange={setObservedOn} type="date" />
                </Field>
                <Field label="Note" hint="What the child actually did." wide>
                  <Textarea value={note} onChange={setNote} rows={2} />
                </Field>
              </FormGrid>
              <FormNotice error={record.error} />
              <Button
                onClick={() => record.mutate()}
                disabled={!materialID || record.isPending}
              >
                Record
              </Button>
            </div>
          </Card>
        )}

        {studentID && (
          <Card>
            <CardHeader
              title="Where this child is"
              description="The current stage is the most recent observation, not the highest ever reached."
            />
            <Table
              head={['Area', 'Material', 'Stage', 'Last seen', 'Observations']}
              empty={positions.length === 0}
              emptyLabel="No materials on the shelf yet."
            >
              {positions.map((p) => (
                <tr key={p.material_id}>
                  <Td>{labelOf(MONTESSORI_AREAS, p.area)}</Td>
                  <Td>
                    {p.name}
                    {p.history.length > 0 && p.history[0].note && (
                      <span className="block text-[12px] text-muted-foreground">
                        {p.history[0].note}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={STAGE_TONE[p.current_stage] ?? 'neutral'}>
                      {p.current_stage === 'not_presented'
                        ? 'Not presented'
                        : labelOf(MONTESSORI_STAGES, p.current_stage)}
                    </Badge>
                  </Td>
                  <Td>{p.last_seen_on ?? '—'}</Td>
                  <Td>{p.history.length}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {!sectionID && (
          <EmptyState
            title="Choose a section"
            body="Early years tracking is per room, then per child."
          />
        )}
      </PageBody>
    </>
  )
}
