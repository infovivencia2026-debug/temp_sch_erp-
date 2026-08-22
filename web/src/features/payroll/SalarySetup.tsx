import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Input, Field, FormGrid, FormNotice, Loading, ErrorState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* What each person is paid — the thing payroll could not run without.
 *
 * "Salary structure builder" was a menu entry that opened the payroll run
 * screen and built nothing. Behind it, no endpoint in the product wrote a
 * salary: salary_components was empty in every school on the installation, and
 * a payroll run only pays staff who have a structure. So Run payroll found
 * nobody, month after month, and the register underneath stayed empty — which
 * reads as a broken button rather than as a step nobody could take.
 *
 * A raise is a new structure, not an edit. Editing would rewrite what somebody
 * was paid last March; the old row is closed the day before the new one starts,
 * so the record reads as a career rather than as a current figure. That is also
 * what a gratuity calculation and an audit ask to see.
 */

interface Component {
  id: string
  code: string
  name: string
  kind: 'earning' | 'deduction' | 'employer_contribution'
  is_percent: boolean
  percent_of?: string
  is_statutory: boolean
}

interface Item {
  component_id: string
  code: string
  name: string
  kind: string
  amount_paise: number
  percent?: number
}

interface Row {
  employee_id: string
  employee_code: string
  full_name: string
  structure_id?: string
  effective_from?: string
  ctc_paise: number
  items: Item[]
}

const today = () => new Date().toISOString().slice(0, 10)

export default function SalarySetup() {
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const [from, setFrom] = useState(today())
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [done, setDone] = useState('')

  const comps = useQuery({
    queryKey: ['salary-components'],
    queryFn: () =>
      api.get<{ items: Component[]; suggested: Component[] }>('/api/v1/payroll/components'),
  })
  const structures = useQuery({
    queryKey: ['salary-structures'],
    queryFn: () => api.get<{ items: Row[] }>('/api/v1/payroll/structures'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['salary-components'] })
    qc.invalidateQueries({ queryKey: ['salary-structures'] })
  }

  const addStarters = useMutation({
    mutationFn: () => api.post<{ created: number }>('/api/v1/payroll/components', { starters: true }),
    onSuccess: (r) => {
      setDone(`${r.created} pay components created. You can rename or add to them.`)
      refresh()
    },
  })

  const save = useMutation({
    mutationFn: (v: { employee_id: string }) =>
      api.post('/api/v1/payroll/structures', {
        employee_id: v.employee_id,
        effective_from: from,
        items: Object.entries(amounts)
          .filter(([, val]) => Number(val) > 0)
          .map(([component_id, val]) => ({
            component_id,
            // Rupees on screen, paise in the database — the whole schema is
            // integer paise so no salary is ever a float.
            amount_paise: Math.round(Number(val) * 100),
          })),
      }),
    onSuccess: () => {
      setDone('Saved. It applies from the date you set, and the previous salary is kept as history.')
      setOpen(null)
      setAmounts({})
      refresh()
    },
  })

  if (comps.isLoading || structures.isLoading) return <Loading />
  if (comps.error) return <ErrorState error={comps.error} />
  if (structures.error) return <ErrorState error={structures.error} />

  const components = comps.data?.items ?? []
  const rows = structures.data?.items ?? []
  const unpaid = rows.filter((r) => !r.structure_id)

  const monthly = (r: Row) =>
    r.items.filter((i) => i.kind === 'earning').reduce((a, i) => a + i.amount_paise, 0)

  return (
    <>
      <PageHead
        eyebrow="Payroll"
        title="Salary setup"
        description="What each member of staff is paid, and the components a payslip is built from. Payroll can only pay somebody who has a salary set here."
      />
      <PageBody>
        {done && <FormNotice ok={done} />}
        {(save.error || addStarters.error) && (
          <FormNotice error={save.error ?? addStarters.error} />
        )}

        <CellGrid cols={3}>
          <Stat label="Staff with a salary set" value={rows.length - unpaid.length} />
          <Stat
            label="Nobody has set a salary for"
            value={unpaid.length}
            hint={unpaid.length ? 'They are left out of every payroll run' : 'Everyone is covered'}
          />
          <Stat label="Pay components" value={components.length} />
        </CellGrid>

        {components.length === 0 ? (
          <Card>
            <CardHeader
              title="Start with the usual components"
              description="Basic, dearness allowance, HRA, conveyance, special allowance, provident fund, professional tax and TDS — the vocabulary an Indian school payslip is written in. Rename or add to them afterwards; nothing is created until you ask."
              action={
                <Button onClick={() => addStarters.mutate()} disabled={addStarters.isPending}>
                  Set these up for me
                </Button>
              }
            />
            <Table head={['Code', 'Name', 'Type']}>
              {(comps.data?.suggested ?? []).map((c) => (
                <tr key={c.code}>
                  <Td className="font-mono text-[12px]">{c.code}</Td>
                  <Td>{c.name}</Td>
                  <Td>
                    <Badge tone={c.kind === 'earning' ? 'success' : 'neutral'}>
                      {c.kind === 'earning' ? 'added to pay' : 'taken off'}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        ) : (
          <Card>
            <CardHeader
              title="Pay components"
              description="The lines every payslip is built from."
            />
            <div className="flex flex-wrap gap-2">
              {components.map((c) => (
                <Badge key={c.id} tone={c.kind === 'earning' ? 'success' : 'neutral'}>
                  {c.name}
                  {c.is_percent && c.percent_of ? ` (% of ${c.percent_of})` : ''}
                </Badge>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Who is paid what"
            description={
              unpaid.length
                ? `${unpaid.length} of ${rows.length} have no salary set, so payroll skips them.`
                : 'Everybody on the staff roll has a salary set.'
            }
          />
          <Table
            head={['Code', 'Name', 'Monthly pay', 'From', '']}
            empty={rows.length === 0}
            emptyLabel="Nobody on the staff roll yet."
          >
            {rows.map((r) => (
              <tr key={r.employee_id}>
                <Td className="font-mono text-[12px]">{r.employee_code}</Td>
                <Td className="font-medium">{r.full_name}</Td>
                <Td>
                  {r.structure_id ? (
                    formatPaise(monthly(r))
                  ) : (
                    /* Said as a consequence, not as a blank. "—" in this column
                       is exactly the state that kept somebody out of payroll
                       without anybody noticing. */
                    <Badge tone="warning">not set — will not be paid</Badge>
                  )}
                </Td>
                <Td className="text-muted-foreground">{r.effective_from ?? '—'}</Td>
                <Td>
                  <Button
                    size="sm"
                    variant={r.structure_id ? 'ghost' : 'primary'}
                    onClick={() => {
                      setOpen(open === r.employee_id ? null : r.employee_id)
                      setFrom(today())
                      const seed: Record<string, string> = {}
                      for (const i of r.items) seed[i.component_id] = String(i.amount_paise / 100)
                      setAmounts(seed)
                    }}
                    disabled={components.length === 0}
                  >
                    {r.structure_id ? 'Revise' : 'Set salary'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {open && (
          <Card>
            <CardHeader
              title={`Salary for ${rows.find((r) => r.employee_id === open)?.full_name ?? ''}`}
              description="In rupees a month. A revision keeps the old salary as history rather than overwriting it, so a payslip already issued still explains itself."
            />
            <FormGrid>
              <Field label="Applies from" hint="Pay before this date is untouched.">
                <Input type="date" value={from} onChange={setFrom} />
              </Field>
            </FormGrid>
            <Table head={['Component', 'Type', 'Rupees per month']}>
              {components.map((c) => (
                <tr key={c.id}>
                  <Td>{c.name}</Td>
                  <Td>
                    <Badge tone={c.kind === 'earning' ? 'success' : 'neutral'}>
                      {c.kind === 'earning' ? 'added' : 'taken off'}
                    </Badge>
                  </Td>
                  <Td>
                    <Input
                      type="number"
                      value={amounts[c.id] ?? ''}
                      onChange={(v) => setAmounts((a) => ({ ...a, [c.id]: v }))}
                      placeholder="0"
                    />
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="flex flex-wrap items-center gap-3 pt-3">
              <Button
                onClick={() => save.mutate({ employee_id: open })}
                disabled={save.isPending || !Object.values(amounts).some((v) => Number(v) > 0)}
              >
                Save this salary
              </Button>
              <span className="text-[13px] text-muted-foreground">
                Adds up to{' '}
                {formatPaise(
                  Object.entries(amounts).reduce((a, [id, v]) => {
                    const c = components.find((x) => x.id === id)
                    return c?.kind === 'earning' ? a + Math.round(Number(v || 0) * 100) : a
                  }, 0),
                )}{' '}
                a month before deductions.
              </span>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
