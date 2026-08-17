import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Button, Input, Loading, ErrorState, ExportButton, FormNotice } from '@/components/ui'

interface UDISERow {
  admission_no: string; name: string; apaar_id?: string
  date_of_birth?: string; gender?: string; category?: string
  class_name?: string; is_rte: boolean; aadhaar_consent: boolean; issues: string
}

/** The UDISE+ return. The useful output is not the data — it is the list of
    records that would be rejected, surfaced early enough to fix. */
export default function UDISE() {
  const qc = useQueryClient()
  const [onlyIssues, setOnlyIssues] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [apaar, setApaar] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['udise'],
    queryFn: () => api.get<List<UDISERow>>('/api/v1/compliance/udise'),
  })

  const setAPAAR = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      api.post('/api/v1/compliance/apaar', {
        student_id: id, apaar_id: value, aadhaar_consent: true,
      }),
    onSuccess: () => { setEditing(null); setApaar(''); qc.invalidateQueries({ queryKey: ['udise'] }) },
  })

  const all = data?.items ?? []
  const bad = all.filter((r) => r.issues)
  const rows = onlyIssues ? bad : all
  const withAPAAR = all.filter((r) => r.apaar_id).length

  return (
    <>
      <PageHead
        eyebrow="Compliance"
        title="UDISE+ return"
        description="Validate every student record against the annual return before submission. UDISE+ rejects the whole file on field errors."
        actions={
          <>
            <ExportButton report="udise" />
            <Button variant="secondary" onClick={() => setOnlyIssues((v) => !v)}>
              {onlyIssues ? 'Show all students' : 'Show only problems'}
            </Button>
          </>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Students in return" value={all.length} />
          <Stat label="Would be rejected" value={bad.length}
            delta={{ value: bad.length ? 'Fix before filing' : 'Clean', positive: bad.length === 0 }} />
          <Stat label="APAAR issued" value={`${withAPAAR}/${all.length}`} />
          <Stat label="RTE students" value={all.filter((r) => r.is_rte).length} />
        </CellGrid>

        <Card>
          <CardHeader
            title={onlyIssues ? 'Records with problems' : 'All records'}
            description={`${rows.length} rows`}
          />
          {isLoading ? <Loading /> : error ? <ErrorState error={error} /> : (
            <Table head={['Admission no.', 'Student', 'Class', 'APAAR ID', 'Aadhaar', 'Problems', '']}
              empty={!rows.length} emptyLabel="Every record passes validation.">
              {rows.map((r) => (
                <tr key={r.admission_no}>
                  <Td className="font-mono text-[12px]">{r.admission_no}</Td>
                  <Td className="font-medium">{r.name}</Td>
                  <Td>{r.class_name ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">
                    {editing === r.admission_no ? (
                      <Input value={apaar} onChange={setApaar} placeholder="12 digits" />
                    ) : (
                      r.apaar_id ?? '—'
                    )}
                  </Td>
                  <Td>
                    {r.aadhaar_consent
                      ? <CheckCircle2 className="h-4 w-4 text-success" />
                      : <AlertTriangle className="h-4 w-4 text-warning" />}
                  </Td>
                  <Td className="max-w-md text-[13px] text-destructive">{r.issues || '—'}</Td>
                  <Td>
                    {editing === r.admission_no ? (
                      <div className="flex gap-1.5">
                        <Button size="sm" disabled={apaar.length !== 12}
                          onClick={() => setAPAAR.mutate({ id: r.admission_no, value: apaar })}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {setAPAAR.isError && (
            <div className="border-t px-5 py-3">
              <FormNotice error={setAPAAR.error} />
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
