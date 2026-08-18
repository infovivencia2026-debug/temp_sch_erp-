import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Input, Select, Textarea, Field, FormGrid, FormNotice,
  Loading, ErrorState,
} from '@/components/ui'
import {
  usePlatformSave, usePlatformDelete, rupees, bp, type FranchiseResponse,
} from '../super_admin/platform-lib'

const BASE = '/api/v1/admin/platform/franchises'

/**
 * A franchise chain: one brand across separately registered schools.
 *
 * The chain spans tenants, which is what makes it a chain and why it is the
 * vendor's screen rather than a school's. A member school sees its own
 * agreement, its royalty and the brand standards it is held to, and nothing
 * about the other twelve schools — a franchisee learning its neighbour's fee
 * from the software would be a breach of the agreement, not a feature.
 *
 * Compliance is shown as "never audited" separately from a low score, because
 * a school nobody has visited is not a school that failed.
 */
export default function Franchises() {
  const [selected, setSelected] = useState('')
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform', 'franchises', selected],
    queryFn: () => api.get<FranchiseResponse>(selected ? `${BASE}?franchise_id=${selected}` : BASE),
  })

  const saveChain = usePlatformSave('franchises', '/franchises', 'post')
  const saveMember = usePlatformSave('franchises', '/franchises/members', 'post')
  const removeMember = usePlatformDelete('franchises')

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [royalty, setRoyalty] = useState('0')
  const [contact, setContact] = useState('')
  const [email, setEmail] = useState('')
  const [standards, setStandards] = useState('')

  const [school, setSchool] = useState('')
  const [agreement, setAgreement] = useState('')
  const [fee, setFee] = useState('')
  const [compliance, setCompliance] = useState('')
  const [audited, setAudited] = useState('')

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const current = data.items.find((f) => f.id === (data.selected ?? ''))

  return (
    <>
      <PageHead
        eyebrow="Campuses & Academic Year"
        title="Franchise management"
        description="Brand chains across schools: membership, royalty, renewal and brand compliance."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Chains" value={data.items.length} />
          <Stat label="Member schools" value={current?.members ?? 0} hint={current?.name} />
          <Stat label="Students under the brand" value={current?.students ?? 0} />
          <Stat
            label="Brand compliance"
            value={current?.compliance_percent != null ? `${current.compliance_percent}%` : 'Not audited'}
            hint={current?.never_audited ? `${current.never_audited} never audited` : undefined}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Chains"
            description="A chain is a brand, not a legal entity — each member school keeps its own registration"
            action={
              <Select
                value={data.selected ?? ''}
                onChange={setSelected}
                options={data.items.map((f) => ({ value: f.id, label: f.name }))}
                placeholder={data.items.length ? 'Select a chain' : 'None yet'}
              />
            }
          />
          <Table
            head={['Code', 'Chain', 'Brand owner', 'Royalty', 'Members', 'Annual fees', 'Status']}
            empty={!data.items.length}
            emptyLabel="No chains recorded. Every school on the installation is independent."
          >
            {data.items.map((f) => (
              <tr key={f.id}>
                <Td className="font-mono text-[12.5px]">{f.code}</Td>
                <Td className="font-medium">{f.name}</Td>
                <Td>{f.brand_owner ?? '—'}</Td>
                <Td>{bp(f.royalty_bp)}</Td>
                <Td>{f.members}</Td>
                <Td>{rupees(f.annual_fee_paise)}</Td>
                <Td>
                  <Badge tone={f.status === 'active' ? 'success' : f.status === 'suspended' ? 'warning' : 'neutral'}>
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
              title={`${current.name} — member schools`}
              description={current.brand_standards ?? 'No brand standards recorded for this chain'}
            />
            <Table
              head={['School', 'District', 'Students', 'Agreement', 'Joined', 'Annual fee', 'Compliance', '']}
              empty={!data.members.length}
              emptyLabel="No schools attached to this chain yet."
            >
              {data.members.map((m) => (
                <tr key={m.institution_id}>
                  <Td className="font-medium">{m.school}</Td>
                  <Td>{m.district ?? '—'}</Td>
                  <Td>{m.students}</Td>
                  <Td>{m.agreement_no ?? '—'}</Td>
                  <Td>{m.joined_on}</Td>
                  <Td>{rupees(m.annual_fee_paise)}</Td>
                  <Td>
                    {m.compliance_percent == null ? (
                      <Badge tone="neutral">Never audited</Badge>
                    ) : m.compliance_percent < 70 ? (
                      <Badge tone="danger">{m.compliance_percent}%</Badge>
                    ) : m.compliance_percent < 85 ? (
                      <Badge tone="warning">{m.compliance_percent}%</Badge>
                    ) : (
                      <Badge tone="success">{m.compliance_percent}%</Badge>
                    )}
                    {m.last_audited_on && (
                      <span className="block text-[12px] text-muted-foreground">{m.last_audited_on}</span>
                    )}
                  </Td>
                  <Td>
                    <ConfirmButton
                      confirmLabel="Detach"
                      question="Remove this school from the chain?"
                      tone="danger"
                      onConfirm={() => removeMember.mutate(`/franchises/members/${m.institution_id}`)}
                    >
                      Detach
                    </ConfirmButton>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Add or amend a chain"
            action={
              <Button
                disabled={saveChain.isPending || !code || !name}
                onClick={() =>
                  saveChain.mutate({
                    code,
                    name,
                    brand_owner: owner,
                    royalty_bp: Number(royalty) || 0,
                    contact_name: contact,
                    contact_email: email,
                    brand_standards: standards,
                  })
                }
              >
                Save chain
              </Button>
            }
          />
          <div className="p-5">
            <FormGrid>
              <Field label="Code" required>
                <Input value={code} onChange={setCode} placeholder="e.g. vidya" />
              </Field>
              <Field label="Chain name" required>
                <Input value={name} onChange={setName} />
              </Field>
              <Field label="Brand owner">
                <Input value={owner} onChange={setOwner} placeholder="The trust or company that owns the brand" />
              </Field>
              <Field
                label="Royalty (basis points)"
                hint="725 is 7.25%. Basis points rather than a percentage so a renewal never turns on a rounding argument."
              >
                <Input value={royalty} onChange={setRoyalty} />
              </Field>
              <Field label="Contact">
                <Input value={contact} onChange={setContact} />
              </Field>
              <Field label="Contact email">
                <Input value={email} onChange={setEmail} />
              </Field>
              <Field label="Brand standards" wide hint="Contract language, read by a person. Member schools see this on their own screen.">
                <Textarea value={standards} onChange={setStandards} rows={3} />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <FormNotice error={saveChain.error} />
            </div>
          </div>
        </Card>

        {current && (
          <Card>
            <CardHeader
              title="Attach a school"
              description={`Added to ${current.name}. A school may belong to one chain at a time.`}
              action={
                <Button
                  disabled={saveMember.isPending || !school}
                  onClick={() =>
                    saveMember.mutate(
                      {
                        franchise_id: current.id,
                        institution_id: school,
                        agreement_no: agreement,
                        annual_fee_paise: Math.round((Number(fee) || 0) * 100),
                        compliance_percent: compliance === '' ? null : Number(compliance),
                        last_audited_on: audited,
                      },
                      {
                        onSuccess: () => {
                          setSchool('')
                          setAgreement('')
                          setFee('')
                          setCompliance('')
                          setAudited('')
                        },
                      },
                    )
                  }
                >
                  Attach
                </Button>
              }
            />
            <div className="p-5">
              <FormGrid>
                <Field label="School" required>
                  <Select
                    value={school}
                    onChange={setSchool}
                    options={data.unattached}
                    placeholder={data.unattached.length ? 'Select a school' : 'Every school already belongs to a chain'}
                  />
                </Field>
                <Field label="Agreement number">
                  <Input value={agreement} onChange={setAgreement} />
                </Field>
                <Field label="Annual fee (₹)">
                  <Input value={fee} onChange={setFee} placeholder="2500000" />
                </Field>
                <Field label="Brand audit score (%)" hint="Leave blank until an audit has actually been done; zero would read as a failure.">
                  <Input value={compliance} onChange={setCompliance} />
                </Field>
                <Field label="Last audited on">
                  <Input type="date" value={audited} onChange={setAudited} />
                </Field>
              </FormGrid>
              <div className="mt-4">
                <FormNotice error={saveMember.error} />
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
