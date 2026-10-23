import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, Input, Button, Loading, ErrorState, Badge } from '@/components/ui'
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
  const idx = STEPS.findIndex((x) => x.entity === open)
  /* Turn an import field's name into something a person reads: the API
     sends them as they are stored (admission_no, father_phone), and the
     screen was printing them in monospace with a red asterisk, which is
     what a database tool looks like, not this product. */
  const words = (n: string) => n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  const stateOf = (e: string) => {
    const r = results[e]
    return !r ? 'todo' : r.dry_run ? 'checked' : 'done'
  }

  return (
    <>
      <PageHead eyebrow="Getting started" title="Move from MyClassBoard" />
      <PageBody>
        <div className="space-y-4 pb-24">
          {/* THE FIVE FILES AS STEPS, NOT AS A TABLE (owner, 2026-10-12:
              "nothing in that feature matches our theme").

              They were drawn with the shared data Table, which gave a list
              of five instructions a row count and an Export button -- there
              is nothing to export from a set of instructions -- and no sign
              of which one you were on beyond a faint row tint. They are a
              sequence, so they are drawn as one: numbered, joined by a line,
              each carrying its own state, the open one marked. */}
          <Card>
            <CardHeader title="Five files, in this order" description="Download each from MyClassBoard as Excel, save it as CSV, and bring it here. A dry run writes nothing." />
            <ol className="px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
              {STEPS.map((x, i) => {
                const st = stateOf(x.entity)
                const here = x.entity === open
                return (
                  <li key={x.entity} className="relative flex gap-3">
                    {i < STEPS.length - 1 && (
                      <span aria-hidden className={cn('absolute left-[15px] top-9 h-[calc(100%-1.5rem)] w-px', st === 'done' ? 'bg-success' : 'bg-border')} />
                    )}
                    <span aria-hidden className={cn('relative z-10 mt-2 grid h-8 w-8 shrink-0 place-items-center rounded-full border text-[13px] font-semibold',
                      st === 'done' ? 'border-success bg-success text-success-foreground'
                        : here ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card text-muted-foreground')}>
                      {st === 'done' ? '\u2713' : i + 1}
                    </span>
                    <button type="button" onClick={() => setOpen(x.entity)}
                      className={cn('mb-1 flex min-h-11 w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg px-3 py-2 text-left transition-colors',
                        here ? 'bg-muted' : 'hover:bg-muted/50')}>
                      <span className="min-w-0">
                        <span className="block text-[14.5px] font-semibold">{x.title}</span>
                        <span className="block text-[12.5px] text-muted-foreground">{x.note}</span>
                      </span>
                      {st === 'done'
                        ? <Badge tone="success">{results[x.entity]!.imported} imported</Badge>
                        : st === 'checked'
                          ? <Badge tone="info">Checked: {results[x.entity]!.valid} of {results[x.entity]!.total} ok</Badge>
                          : <span className="text-[12.5px] text-muted-foreground">Not started</span>}
                    </button>
                  </li>
                )
              })}
            </ol>
          </Card>

          <Card>
            <CardHeader title={`Step ${idx + 1} \u00b7 ${step.title}`} description={step.note} action={
              <a href={templateUrl(step.entity)} className="shrink-0">
                <Button variant="secondary" size="sm">Our template</Button>
              </a>
            } />
            <div className="space-y-5 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
              {/* Where it comes from belongs with the step you are on, not in
                  a column repeated five times down a table. */}
              <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
                <span className="block text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Where to find it in MyClassBoard</span>
                <span className="mt-0.5 block text-[13.5px]">{step.mcb}</span>
              </div>

              <div>
                <h3 className="text-[14px] font-semibold">Match the columns</h3>
                <p className="mt-0.5 text-[13px] text-muted-foreground">MyClassBoard&rsquo;s own column names are filled in already. Change one only where that school&rsquo;s export differs; leave it empty if there is no such column.</p>
                {fields.isLoading ? <Loading shape="inline" /> : fields.error ? <ErrorState error={fields.error} /> : (
                  <div className="mt-3 divide-y rounded-lg border">
                    {(fields.data?.fields ?? []).map((f) => (
                      <div key={f.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                        <span className="min-w-[9rem] flex-1">
                          <span className="text-[13.5px] font-medium">{words(f.name)}</span>
                          {f.required && <Badge tone="warning" className="ml-2">Required</Badge>}
                          {f.example && <span className="block text-[12px] text-muted-foreground">e.g. {f.example}</span>}
                        </span>
                        <Input className="w-full sm:w-64" value={maps[step.entity][f.name] ?? ''} placeholder="No such column"
                          onChange={(v) => setMaps({ ...maps, [step.entity]: { ...maps[step.entity], [f.name]: v } })} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-[14px] font-semibold">Choose the file</h3>
                {/* A bare <input type="file"> was the one unstyled control on
                    the page, and on Windows it reads "No file chosen" in the
                    browser's own grey. The input is still the input -- it is
                    inside the label, so the keyboard and the screen reader
                    get the real control -- it is simply not drawn. */}
                <label className="mt-2 flex min-h-11 cursor-pointer flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-3 transition-colors hover:bg-muted/40">
                  <input type="file" accept=".csv,text/csv" className="sr-only"
                    onChange={(e) => { setFiles({ ...files, [step.entity]: e.target.files?.[0] ?? null }); setResults({ ...results, [step.entity]: null }) }} />
                  <span className="rounded-md border bg-card px-3 py-1.5 text-[13px] font-medium">Choose a CSV</span>
                  <span className="text-[13.5px] text-muted-foreground">{files[step.entity]?.name ?? 'No file chosen yet'}</span>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" disabled={!files[step.entity] || busy !== ''} onClick={() => run(step.entity, false)}>{busy === step.entity + ':dry' ? 'Checking\u2026' : 'Dry run'}</Button>
                <Button disabled={!result || !result.dry_run || result.valid === 0 || busy !== ''} onClick={() => run(step.entity, true)}>{busy === step.entity + ':commit' ? 'Importing\u2026' : `Import ${result?.valid ?? 0} row${result?.valid === 1 ? '' : 's'}`}</Button>
                {!files[step.entity] && <span className="text-[12.5px] text-muted-foreground">Choose a file to begin.</span>}
              </div>

              {error[step.entity] && <p className="text-[13.5px] text-destructive">{error[step.entity]}</p>}

              {result && (
                <div className={cn('rounded-lg border px-3 py-3', result.rejected ? 'border-warning/40 bg-warning/5' : 'border-success/40 bg-success/5')}>
                  <p className="text-[13.5px] font-medium">
                    {result.dry_run ? 'Dry run' : 'Imported'}: {result.valid} of {result.total} rows ok{result.rejected ? `, ${result.rejected} cannot be taken` : ''}{!result.dry_run ? `, ${result.imported} written` : ''}.
                  </p>
                  {result.dry_run && result.valid > 0 && <p className="mt-0.5 text-[12.5px] text-muted-foreground">Nothing has been written yet. Press Import to keep it.</p>}
                  {result.problems.length > 0 && (
                    <ul className="mt-2.5 space-y-1 border-t pt-2.5">
                      {result.problems.slice(0, 50).map((x, i) => (
                        <li key={i} className="flex gap-2 text-[13px]">
                          <span className="shrink-0 tabular-nums text-muted-foreground">Row {x.row}</span>
                          <span>{x.problem}</span>
                        </li>
                      ))}
                      {result.problems.length > 50 && <li className="text-[12.5px] text-muted-foreground">and {result.problems.length - 50} more.</li>}
                    </ul>
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
