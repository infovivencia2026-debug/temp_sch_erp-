import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  ConfirmButton, Select, Input, Loading, ErrorState, FormNotice,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* Demand generation — the step that turns a fee structure into money owed.
 *
 * Nothing downstream exists without it: no dues, no defaulter list, no
 * reminder, no receipt. The endpoint has been there since the fee module
 * landed and had no screen, which meant a school could define a fee structure
 * and then had no way to raise a single invoice against it.
 *
 * It applies each student's concessions as it goes, and skips anyone who
 * already has that instalment — so re-running after adding a late admission
 * bills the new child and leaves the rest alone rather than double-charging a
 * whole class.
 */

interface FeeStructure {
  id: string
  name: string
  class_name?: string
  academic_year?: string
  total_paise: number
  /* The server calls this "lines" — the number of fee heads in the structure.
     Reading it as "items" gave undefined, so the card sat blank next to a
     total that was clearly built from something. */
  lines: number
}

interface GenerateResult {
  created: number
  skipped: number
}

export default function DemandGeneration() {
  const qc = useQueryClient()
  const [structure, setStructure] = useState('')
  const [instalment, setInstalment] = useState('1')
  const [dueOn, setDueOn] = useState('')
  const [result, setResult] = useState('')

  const structures = useQuery({
    queryKey: ['fee-structures'],
    queryFn: () => api.get<List<FeeStructure>>('/api/v1/setup/fee-structures'),
  })

  const generate = useMutation({
    mutationFn: () =>
      api.post<GenerateResult>('/api/v1/fees/invoices/generate', {
        fee_structure_id: structure,
        instalment_no: Number(instalment) || 1,
        // Omitted rather than sent empty: the server defaults to two weeks out,
        // and an empty string would be a parse error.
        ...(dueOn ? { due_on: dueOn } : {}),
      }),
    onSuccess: (r) => {
      setResult(
        r.skipped
          ? `${r.created} invoices raised. ${r.skipped} skipped — already billed for this instalment.`
          : `${r.created} invoices raised.`,
      )
      qc.invalidateQueries({ queryKey: ['finance'] })
      qc.invalidateQueries({ queryKey: ['attention'] })
    },
  })

  const items = structures.data?.items ?? []
  const chosen = items.find((s) => s.id === structure)

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Demand / invoice generation"
        description="Raise one invoice per enrolled student from a fee structure, applying each student's concessions."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Raise a demand"
            description="Re-running is safe: anyone already billed for this instalment is skipped."
          />
          <div className="grid gap-4 p-5 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Fee structure</span>
              <Select
                value={structure}
                onChange={setStructure}
                options={items.map((s) => ({
                  value: s.id,
                  label: s.class_name ? `${s.name} — ${s.class_name}` : s.name,
                }))}
                placeholder="Select…"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Instalment no.</span>
              <Input value={instalment} onChange={setInstalment} placeholder="1" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted-foreground">Due on</span>
              <Input value={dueOn} onChange={setDueOn} type="date" />
              <span className="text-[11.5px] text-muted-foreground">
                Leave blank for two weeks from today.
              </span>
            </label>
          </div>

          {chosen && (
            <div className="border-t px-5 py-4">
              <CellGrid cols={3}>
                <Stat label="Structure total" value={formatPaise(chosen.total_paise)} />
                <Stat label="Fee heads" value={chosen.lines} />
                <Stat label="Applies to" value={chosen.class_name ?? 'All classes'} />
              </CellGrid>
            </div>
          )}

          <div className="flex items-center gap-3 border-t px-5 py-4">
            {/* This raises real invoices against real families, in bulk, and
                nothing unraises them in bulk. "Generate demand" does not tell
                anybody what they are about to bill, so the question does. */}
            <ConfirmButton
              disabled={!structure || generate.isPending}
              confirmLabel="Raise invoices"
              question="Raise invoices for everyone in this selection? Invoices cannot be withdrawn in bulk."
              onConfirm={() => generate.mutate()}
            >
              {generate.isPending ? 'Raising invoices…' : 'Generate demand'}
            </ConfirmButton>
            <span className="text-[12.5px] text-muted-foreground">
              A term run for one class is a few hundred invoices and completes here. A
              whole-school run belongs on the background queue.
            </span>
          </div>
          <FormNotice error={generate.error} ok={result} />
        </Card>

        <Card>
          <CardHeader title="Fee structures" description="Defined in Fee structure setup" />
          {structures.isLoading ? (
            <Loading />
          ) : structures.error ? (
            <ErrorState error={structures.error} />
          ) : (
            <Table
              head={['Structure', 'Class', 'Year', 'Heads', 'Total']}
              empty={!items.length}
              emptyLabel="No fee structure defined yet — set one up before raising a demand."
            >
              {items.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.name}</Td>
                  <Td>{s.class_name ?? 'All'}</Td>
                  <Td className="text-muted-foreground">{s.academic_year ?? '—'}</Td>
                  <Td className="tabular-nums">{s.lines}</Td>
                  <Td className="tabular-nums">{formatPaise(s.total_paise)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
