import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Select, Field, FormGrid, FormNotice, SkeletonTable, ErrorState,
} from '@/components/ui'
import { usePlatform, usePlatformSave, type CampusClassResponse } from './platform-lib'

/**
 * How each campus is classified for state reporting.
 *
 * The school's registration carries one management type. The state's returns
 * are filed per campus, and a trust running a KGBV hostel campus alongside a
 * private unaided day campus files two different ones — so the classification
 * belongs on the campus, and the school's own is shown beside it only so a
 * departure is visible.
 *
 * The UDISE code is here rather than on the school profile for the same
 * reason: it identifies a building, nationally, and two campuses sharing one
 * produces two returns for the same school.
 */
export default function ManagementType() {
  const { data, isLoading, error } = usePlatform<CampusClassResponse>(
    'campus-classification',
    '/campus-classification',
  )
  const [editing, setEditing] = useState<string | null>(null)
  const [management, setManagement] = useState('')
  const [category, setCategory] = useState('')
  const [udise, setUdise] = useState('')

  const save = usePlatformSave('campus-classification', editing ? `/campus-classification/${editing}` : '')

  if (isLoading) return <SkeletonTable columns={6} />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const label = (opts: { value: string; label: string }[], v?: string) =>
    (v && opts.find((o) => o.value === v)?.label) ?? null

  const open = (id: string) => {
    const c = data.items.find((i) => i.id === id)
    setEditing(id)
    setManagement(c?.management_type ?? '')
    setCategory(c?.school_category ?? '')
    setUdise(c?.udise_code ?? '')
  }

  return (
    <>
      <PageHead
        eyebrow="Statutory & Boards"
        title="School management type"
        description="Government, aided, private unaided, model school, gurukul or KGBV — recorded per campus, because the state reports per campus."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Campuses" value={data.items.length} />
          <Stat
            label="Unclassified"
            value={data.unclassified}
            hint={data.unclassified ? 'These cannot be included in a state return' : 'Every campus is classified'}
          />
          <Stat
            label="School registration"
            value={label(data.management_types, data.institution_management_type) ?? 'Not set'}
            hint={label(data.school_categories, data.institution_school_category) ?? undefined}
          />
        </CellGrid>

        <Card>
          <CardHeader title="Campuses" description="A campus with no classification is left out of every state return" />
          <Table
            head={['Campus', 'Students', 'Management type', 'Category', 'UDISE code', '']}
            empty={!data.items.length}
            emptyLabel="This school has no campuses."
          >
            {data.items.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">
                  {c.name}
                  <span className="block text-[12px] text-muted-foreground">
                    {c.code}
                    {c.city ? ` · ${c.city}` : ''}
                  </span>
                </Td>
                <Td>{c.students}</Td>
                <Td>
                  {label(data.management_types, c.management_type) ?? (
                    <Badge tone="warning">Not classified</Badge>
                  )}
                </Td>
                <Td>{label(data.school_categories, c.school_category) ?? '—'}</Td>
                <Td className="font-mono text-[12.5px]">{c.udise_code ?? '—'}</Td>
                <Td>
                  <Button variant="secondary" size="sm" onClick={() => open(c.id)}>
                    {editing === c.id ? 'Editing' : 'Edit'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {editing && (
          <Card>
            <CardHeader
              title={`Classify ${data.items.find((i) => i.id === editing)?.name ?? 'campus'}`}
              description="What the state's return will say about this campus"
              action={
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button
                    disabled={save.isPending}
                    onClick={() =>
                      save.mutate(
                        {
                          management_type: management,
                          school_category: category,
                          udise_code: udise,
                        },
                        { onSuccess: () => setEditing(null) },
                      )
                    }
                  >
                    Save
                  </Button>
                </div>
              }
            />
            <div className="p-5">
              <FormGrid>
                <Field label="Management type">
                  <Select
                    value={management}
                    onChange={setManagement}
                    options={data.management_types}
                    placeholder="Select a type"
                  />
                </Field>
                <Field label="School category">
                  <Select
                    value={category}
                    onChange={setCategory}
                    options={data.school_categories}
                    placeholder="Select a category"
                  />
                </Field>
                <Field
                  label="UDISE code"
                  wide
                  hint="Eleven digits, issued per school building. Leave blank rather than guessing — a wrong code files this campus's return against somebody else's school."
                >
                  <Input value={udise} onChange={setUdise} placeholder="36051200145" />
                </Field>
              </FormGrid>
              <div className="mt-4">
                <FormNotice error={save.error} />
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
