import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Input, Select, Checkbox, Field, FormGrid, FormNotice,
  Loading, ErrorState,
} from '@/components/ui'
import {
  usePlatformSave, usePlatformDelete, bp, type SQAAResponse, type SQAAStandard,
} from './platform-lib'

const BASE = '/api/v1/admin/platform/sqaa'

/**
 * The School Quality Assessment and Assurance framework.
 *
 * Published by a board or a state authority and maintained here by the
 * platform, not by each school: a framework a school can edit is not a
 * standard, it is a self-portrait. Schools assess themselves against it
 * through the separate compliance tracking screen.
 *
 * The weights are shown as a running total against 100%, because a framework
 * whose domains add to 85% cannot score anything and the only moment anyone
 * notices is when the first assessment comes out wrong.
 */
export default function SQAAFramework() {
  const [selected, setSelected] = useState('')
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform', 'sqaa', selected],
    queryFn: () => api.get<SQAAResponse>(selected ? `${BASE}?framework=${selected}` : BASE),
  })

  const saveFramework = usePlatformSave('sqaa', '/sqaa/frameworks', 'post')
  const saveStandard = usePlatformSave('sqaa', '/sqaa/standards', 'post')
  const removeStandard = usePlatformDelete('sqaa')

  const [fCode, setFCode] = useState('')
  const [fName, setFName] = useState('')
  const [fAuthority, setFAuthority] = useState('')
  const [fVersion, setFVersion] = useState('1')
  const [fFrom, setFFrom] = useState('')
  const [fStatus, setFStatus] = useState('draft')

  const [sParent, setSParent] = useState('')
  const [sCode, setSCode] = useState('')
  const [sName, setSName] = useState('')
  const [sWeight, setSWeight] = useState('0')
  const [sEvidence, setSEvidence] = useState(false)

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const current = data.selected ?? ''
  const framework = data.frameworks.find((f) => f.code === current)
  const domains = data.standards.filter((s) => !s.parent_id)
  const childrenOf = (id: string) => data.standards.filter((s) => s.parent_id === id)

  const row = (s: SQAAStandard, depth: number) => (
    <tr key={s.id}>
      <Td className="font-mono text-[12.5px]">
        <span style={{ paddingLeft: depth * 16 }}>{s.code}</span>
      </Td>
      <Td className="font-medium">
        {s.name}
        {s.description && (
          <span className="block text-[12px] text-muted-foreground">{s.description}</span>
        )}
      </Td>
      <Td>{depth === 0 ? bp(s.weight_bp) : <span className="text-muted-foreground">—</span>}</Td>
      <Td>{s.evidence_required ? <Badge tone="info">Evidence required</Badge> : '—'}</Td>
      <Td>
        <ConfirmButton
          confirmLabel="Remove"
          question="Remove this standard and everything beneath it?"
          tone="danger"
          onConfirm={() => removeStandard.mutate(`/sqaa/standards/${s.id}`)}
        >
          Remove
        </ConfirmButton>
      </Td>
    </tr>
  )

  return (
    <>
      <PageHead
        eyebrow="Statutory & Boards"
        title="SQAA framework management"
        description="The quality standards and self-assessment checklists schools are measured against."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Frameworks" value={data.frameworks.length} />
          <Stat label="Standards in this framework" value={framework?.standards ?? 0} />
          <Stat
            label="Domain weights"
            value={framework ? bp(framework.weight_bp) : '—'}
            hint={
              framework && framework.weight_bp !== 10000
                ? 'Domains must add to 100% before this framework can score anything'
                : 'Adds to 100%'
            }
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Frameworks"
            description="A published framework is the one schools assess against; a draft is not offered to them"
            action={
              <Select
                value={current}
                onChange={setSelected}
                options={data.frameworks.map((f) => ({
                  value: f.code,
                  label: `${f.name} (${f.version})`,
                }))}
                placeholder={data.frameworks.length ? 'Select a framework' : 'None yet'}
              />
            }
          />
          <Table
            head={['Code', 'Name', 'Authority', 'Version', 'Effective from', 'Standards', 'Status']}
            empty={!data.frameworks.length}
            emptyLabel="No framework has been published. Add one below before any school can self-assess."
          >
            {data.frameworks.map((f) => (
              <tr key={f.code}>
                <Td className="font-mono text-[12.5px]">{f.code}</Td>
                <Td className="font-medium">{f.name}</Td>
                <Td>{f.authority}</Td>
                <Td>{f.version}</Td>
                <Td>{f.effective_from ?? '—'}</Td>
                <Td>{f.standards}</Td>
                <Td>
                  <Badge
                    tone={f.status === 'published' ? 'success' : f.status === 'draft' ? 'warning' : 'neutral'}
                  >
                    {f.status}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {current && (
          <Card>
            <CardHeader
              title="Domains and standards"
              description="Domains carry the weight; the standards beneath them are what a school actually answers"
            />
            <Table
              head={['Code', 'Standard', 'Weight', 'Evidence', '']}
              empty={!data.standards.length}
              emptyLabel="This framework has no standards yet, so a school assessing against it would be shown an empty checklist."
            >
              {domains.flatMap((d) => [row(d, 0), ...childrenOf(d.id).map((c) => row(c, 1))])}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Add a framework"
            description="Saving an existing code amends it rather than creating a second version"
            action={
              <Button
                disabled={saveFramework.isPending || !fCode || !fName}
                onClick={() =>
                  saveFramework.mutate({
                    code: fCode,
                    name: fName,
                    authority: fAuthority,
                    version: fVersion,
                    effective_from: fFrom,
                    status: fStatus,
                  })
                }
              >
                Save framework
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Code" required hint="Stable and short; the standards below hang off it.">
                <Input value={fCode} onChange={setFCode} placeholder="e.g. cbse_sqaa_2023" />
              </Field>
              <Field label="Name" required>
                <Input value={fName} onChange={setFName} />
              </Field>
              <Field label="Authority">
                <Input value={fAuthority} onChange={setFAuthority} placeholder="CBSE, state authority, or the trust" />
              </Field>
              <Field label="Version">
                <Input value={fVersion} onChange={setFVersion} />
              </Field>
              <Field label="Effective from">
                <Input type="date" value={fFrom} onChange={setFFrom} />
              </Field>
              <Field label="Status">
                <Select
                  value={fStatus}
                  onChange={setFStatus}
                  options={[
                    { value: 'draft', label: 'Draft — not offered to schools' },
                    { value: 'published', label: 'Published' },
                    { value: 'retired', label: 'Retired' },
                  ]}
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={saveFramework.error} />
            </div>
          </div>
        </Card>

        {current && (
          <Card>
            <CardHeader
              title="Add a standard"
              description={`Added to ${framework?.name ?? current}`}
              action={
                <Button
                  disabled={saveStandard.isPending || !sCode || !sName}
                  onClick={() =>
                    saveStandard.mutate(
                      {
                        framework_code: current,
                        parent_id: sParent,
                        code: sCode,
                        name: sName,
                        weight_bp: Number(sWeight) || 0,
                        evidence_required: sEvidence,
                        sequence: data.standards.length + 1,
                      },
                      {
                        onSuccess: () => {
                          setSCode('')
                          setSName('')
                          setSWeight('0')
                          setSEvidence(false)
                        },
                      },
                    )
                  }
                >
                  Add standard
                </Button>
              }
            />
            <div className="p-5">
              <FormGrid>
                <Field label="Sits under" hint="Leave blank to create a domain at the top of the framework.">
                  <Select
                    value={sParent}
                    onChange={setSParent}
                    options={domains.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))}
                    placeholder="A domain of its own"
                  />
                </Field>
                <Field label="Code" required>
                  <Input value={sCode} onChange={setSCode} placeholder="e.g. D1.2" />
                </Field>
                <Field label="Name" required wide>
                  <Input value={sName} onChange={setSName} />
                </Field>
                <Field
                  label="Weight (basis points)"
                  hint="Domains only. 3000 is 30%; the domains must add to 10000."
                >
                  <Input value={sWeight} onChange={setSWeight} />
                </Field>
                <Field label="Evidence">
                  <Checkbox
                    checked={sEvidence}
                    onChange={setSEvidence}
                    label="A school answering this must attach a document"
                  />
                </Field>
              </FormGrid>
              <div className="mt-4">
                <FormNotice error={saveStandard.error} />
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
