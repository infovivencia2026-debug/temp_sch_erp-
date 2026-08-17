import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Upload, Download, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { actingInstitution } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Button, ErrorState,
} from '@/components/ui'

interface Problem { row: number; problem: string; data?: Record<string, string> }
interface Result {
  total: number; valid: number; rejected: number; imported: number
  dry_run: boolean; problems: Problem[]
}

/**
 * Bulk import.
 *
 * Validate-first is the whole design: a clerk uploads the spreadsheet, sees
 * exactly which rows are wrong and why, fixes them in Excel and re-uploads.
 * Importing 800 children and finding out afterwards that forty had unreadable
 * dates is the version of this feature nobody trusts twice.
 */
export default function ImportStudents() {
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')

  const run = useMutation({
    mutationFn: (commit: boolean) =>
      // Raw fetch rather than the api helper because the body is text/csv,
      // not JSON — but the acting-institution header still has to travel, or a
      // platform operator importing into a school they picked would post the
      // rows against no school at all.
      fetch(`/api/v1/students/import${commit ? '?commit=true' : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'text/csv',
          ...(actingInstitution() ? { 'X-Acting-Institution': actingInstitution()! } : {}),
        },
        body: csv,
      }).then(async (res) => {
        const body = await res.json()
        if (!res.ok) throw new Error(body?.error?.message ?? 'Import failed')
        return body as Result
      }),
  })

  const onFile = (f: File) => {
    setFileName(f.name)
    const reader = new FileReader()
    reader.onload = () => setCsv(String(reader.result ?? ''))
    reader.readAsText(f)
  }

  const r = run.data
  const clean = r && r.rejected === 0 && r.total > 0

  return (
    <>
      <PageHead
        eyebrow="Getting started"
        title="Import students"
        description="Upload your existing roll as a spreadsheet. Rows are checked before anything is written."
        actions={
          <a href="/api/v1/students/import/template" download>
            <Button variant="secondary">
              <Download className="h-4 w-4" /> Download template
            </Button>
          </a>
        }
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Choose a file"
            description="Dates may be dd/mm/yyyy — the format Excel exports in India."
          />
          <div className="p-5">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed py-10 text-center transition-colors hover:bg-accent/40">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-[14px] font-medium">
                {fileName || 'Click to choose a CSV file'}
              </span>
              <span className="text-[13px] text-muted-foreground">
                first_name is the only mandatory column
              </span>
              <input
                type="file" accept=".csv,text/csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }}
              />
            </label>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled={!csv || run.isPending} onClick={() => run.mutate(false)}>
                {run.isPending ? 'Checking…' : 'Check the file'}
              </Button>
              <Button
                variant="secondary"
                disabled={!clean || run.isPending}
                onClick={() => run.mutate(true)}
                title={clean ? undefined : 'Fix every problem before importing'}
              >
                Import {r?.valid ? `${r.valid} students` : ''}
              </Button>
            </div>
          </div>
        </Card>

        {run.isError && <ErrorState error={run.error} />}

        {r && (
          <>
            <CellGrid cols={4}>
              <Stat label="Rows read" value={r.total} />
              <Stat label="Valid" value={r.valid} />
              <Stat
                label="Rejected"
                value={r.rejected}
                delta={{ value: r.rejected ? 'Fix and re-upload' : 'None', positive: r.rejected === 0 }}
              />
              <Stat label="Imported" value={r.imported} hint={r.dry_run ? 'Nothing written yet' : 'Written'} />
            </CellGrid>

            {r.problems.length > 0 ? (
              <Card>
                <CardHeader
                  title="Problems"
                  description="Row numbers match your spreadsheet, counting the header as row 1"
                />
                <Table head={['Row', 'Problem', 'Student']} empty={false}>
                  {r.problems.map((p) => (
                    <tr key={p.row}>
                      <Td className="font-mono text-[12px]">{p.row}</Td>
                      <Td className="text-destructive">
                        <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
                        {p.problem}
                      </Td>
                      <Td className="text-muted-foreground">
                        {p.data?.first_name || p.data?.admission_no || '—'}
                      </Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            ) : (
              <Card className="p-6">
                <p className="inline-flex items-center gap-2 text-[14px] text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  {r.dry_run
                    ? `All ${r.total} rows are valid. Import them when you are ready.`
                    : `Imported ${r.imported} students.`}
                </p>
              </Card>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}
