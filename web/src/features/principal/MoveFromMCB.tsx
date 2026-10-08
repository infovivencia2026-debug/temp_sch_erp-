import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, Table, Td, Input, Button, Loading, ErrorState, Badge } from '@/components/ui'
import { cn } from '@/lib/utils'

/* MOVE FROM MYCLASSBOARD IN AN AFTERNOON.

   A school does not switch if it loses what it has. MCB exports each of
   its registers as a spreadsheet; this product imports each of them. The
   only work in between is naming which MCB column is which of ours, and
   that mapping is kept here per register with MCB's own column names
   filled in as the starting point. The office downloads from MCB, picks
   the file, dry-runs it (every row it cannot take is named), and imports.
   Nothing is written until the dry run is clean enough to accept. */

interface Step {
  entity: string
  title: string
  mcb: string
  note: string
  /** Our column -> the MCB column it usually comes from. The office can change any of them. */
  map: Record<string, string>
}

const STEPS: Step[] = [
  { entity: 'classes', title: 'Classes and sections', mcb: 'SIS > Time Table > Timetable Structure, or Organisation > Branch Settings > Classes', note: 'Do this first: every other file names a class.',
    map: { name: 'Class', sections: 'Sections', capacity: 'Capacity', strength: 'Strength' } },
  { entity: 'students', title: 'Students, with their parents', mcb: 'SIS > Reports > Student Contact Details (export to Excel), saved as CSV', note: 'One row per child. Father, mother and guardian come across on the same row and get their logins from here.',
    map: { full_name: 'Student Name', admission_no: 'Admission No', date_of_birth: 'Date Of Birth', gender: 'Gender', class: 'Class', section: 'Section', roll_no: 'Roll No', blood_group: 'Blood Group', medium: 'Medium',
      address: 'Address', city: 'City', state: 'State', pincode: 'Pincode', admission_date: 'Date Of Admission', prior_school: 'Previous School',
      father_name: 'Father Name', father_phone: 'Father Mobile', father_email: 'Father Email', mother_name: 'Mother Name', mother_phone: 'Mother Mobile', mother_email: 'Mother Email' } },
  { entity: 'staff', title: 'Staff', mcb: 'HR > Reports > Staff Details Report', note: 'Teachers, office and support staff alike. Designation and department are created when they are new.',
    map: { employee_code: 'Employee Id', first_name: 'First Name', last_name: 'Last Name', email: 'Email', phone: 'Mobile', designation: 'Designation', department: 'Department', employment_type: 'Employment Type', joined_on: 'Date Of Joining', qualification: 'Qualification' } },
  { entity: 'fee_structures', title: 'Fee structures', mcb: 'Finance > Fee Management > Assign Fee to Students (the fee plan list), or Audit Reports > Fee Plan details report', note: 'What each class pays under each head for the year, and in how many instalments.',
    map: { structure: 'Fee Plan', class: 'Class', fee_head: 'Fee Head', annual_amount: 'Amount', instalments: 'Installments' } },
  { entity: 'fee_payments', title: 'Fee receipts already taken this year', mcb: 'Finance > Collection Reports > Fee Collection Reports (export for the year)', note: 'So the dues are right from the first day. Receipt numbers are kept as MCB printed them.',
    map: { admission_no: 'Admission No', receipt_no: 'Receipt No', paid_on: 'Receipt Date', amount: 'Amount', mode: 'Payment Mode', remarks: 'Remarks' } },
]

/** Students have an importer of their own; everything else goes through the generic one. */
const importUrl = (entity: string) => (entity === 'students' ? '/api/v1/students/import' : `/api/v1/setup/import/${entity}`)
const templateUrl = (entity: string) => (entity === 'students' ? '/api/v1/students/import/template' : `/api/v1/setup/import/${entity}/template`)

interface Result { total: number; valid: number; rejected: number; imported: number; dry_run: boolean; problems: { row: number; problem: string }[] }

export default function MoveFromMCB() {
  const [open, setOpen] = useState<string>(STEPS[0].entity)
  const [maps, setMaps] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(STEPS.map((s) => [s.entity, { ...s.map }])))
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [results, setResults] = useState<Record<string, Result | null>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<Record<string, string>>({})

  const step = STEPS.find((s) => s.entity === open)!
  const fields = useQuery({
    queryKey: ['import-fields', open],
    queryFn: () => api.get<{ fields: { name: string; required: boolean; example?: string }[] }>(`/api/v1/setup/import/${open}/fields`),
  })

  async function run(entity: string, commit: boolean) {
    const file = files[entity]
    if (!file) return
    setBusy(entity + (commit ? ':commit' : ':dry'))
    setError({ ...error, [entity]: '' })
    try {
      const map = Object.fromEntries(Object.entries(maps[entity]).filter(([, v]) => v.trim() !== ''))
      const res = await fetch(`${importUrl(entity)}?commit=${commit ? 'true' : 'false'}`, {
        method: 'POST', body: await file.text(), credentials: 'same-origin',
        headers: { 'content-type': 'text/csv', 'x-column-map': JSON.stringify(map) },
      })
      const body = await res.json() as Result & { error?: { message?: string } | string }
      if (!res.ok) {
        const msg = typeof body.error === 'string' ? body.error : body.error?.message ?? 'The file could not be read.'
        setError({ ...error, [entity]: msg })
      } else setResults({ ...results, [entity]: body })
    } catch (e) {
      setError({ ...error, [entity]: e instanceof Error ? e.message : 'The file could not be read.' })
    } finally { setBusy('') }
  }

  const result = results[open]
  return (
    <>
      <PageHead eyebrow="Getting started" title="Move from MyClassBoard" />
      <PageBody>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Five files, in this order" description="Download each from MyClassBoard as Excel, save it as CSV, and bring it here. A dry run writes nothing." />
            <Table head={['Step', 'What', 'Where in MyClassBoard', 'Status']}>
              {STEPS.map((s, i) => {
                const r = results[s.entity]
                return (
                  <tr key={s.entity} className={cn('cursor-pointer', open === s.entity && 'bg-surface-hover')} onClick={() => setOpen(s.entity)}>
                    <Td className="tabular-nums text-muted-foreground">{i + 1}</Td>
                    <Td className="font-medium">{s.title}</Td>
                    <Td className="text-muted-foreground"><span className="block max-w-[40ch] whitespace-normal">{s.mcb}</span></Td>
                    <Td>{r ? (r.dry_run ? <Badge tone="info">Dry run: {r.valid} of {r.total} ok</Badge> : <Badge tone="success">{r.imported} imported</Badge>) : <span className="text-muted-foreground">Not started</span>}</Td>
                  </tr>
                )
              })}
            </Table>
          </Card>

          <Card>
            <CardHeader title={step.title} description={step.note} action={
              <a className="text-[13px] underline-offset-2 hover:underline" href={templateUrl(step.entity)}>Our template</a>
            } />
            <div className="space-y-4 px-5 pb-5">
              {fields.isLoading ? <Loading shape="inline" /> : fields.error ? <ErrorState error={fields.error} /> : (
                <Table head={['Our column', 'MyClassBoard column', 'Example']}>
                  {(fields.data?.fields ?? []).map((f) => (
                    <tr key={f.name}>
                      <Td className="font-mono text-[12.5px]">{f.name}{f.required && <span className="text-destructive"> *</span>}</Td>
                      <Td>
                        <Input className="w-56" value={maps[step.entity][f.name] ?? ''} placeholder="Leave blank if MCB has no such column"
                          onChange={(v) => setMaps({ ...maps, [step.entity]: { ...maps[step.entity], [f.name]: v } })} />
                      </Td>
                      <Td className="text-muted-foreground">{f.example ?? ''}</Td>
                    </tr>
                  ))}
                </Table>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <input type="file" accept=".csv,text/csv" className="text-[13px]" onChange={(e) => { setFiles({ ...files, [step.entity]: e.target.files?.[0] ?? null }); setResults({ ...results, [step.entity]: null }) }} />
                <Button variant="secondary" disabled={!files[step.entity] || busy !== ''} onClick={() => run(step.entity, false)}>{busy === step.entity + ':dry' ? 'Checking…' : 'Dry run'}</Button>
                <Button disabled={!result || !result.dry_run || result.valid === 0 || busy !== ''} onClick={() => run(step.entity, true)}>{busy === step.entity + ':commit' ? 'Importing…' : `Import ${result?.valid ?? 0} rows`}</Button>
              </div>
              {error[step.entity] && <p className="text-[13.5px] text-destructive">{error[step.entity]}</p>}
              {result && (
                <div className="space-y-2">
                  <p className="text-[13.5px]">{result.dry_run ? 'Dry run' : 'Imported'}: {result.valid} of {result.total} rows ok{result.rejected ? `, ${result.rejected} cannot be taken` : ''}{!result.dry_run ? `, ${result.imported} written` : ''}.</p>
                  {result.problems.length > 0 && (
                    <Table head={['Row', 'Problem']}>
                      {result.problems.slice(0, 50).map((p, i) => (
                        <tr key={i}><Td className="tabular-nums">{p.row}</Td><Td className="whitespace-normal">{p.problem}</Td></tr>
                      ))}
                    </Table>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  )
}
