import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileCheck2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Select, Textarea, Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

interface DocumentRow {
  id: string
  student_id: string
  student_name: string
  doc_type: string
  file_name: string
  size_bytes: number
  uploaded_on: string
  verified: boolean
  verified_by?: string
  notes?: string
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* Asking the office for a certificate.

   Bonafide certificates for a passport, conduct certificates for a scholarship,
   a transfer certificate when a family moves. All of it happens at a counter
   today, and the family's only way to check progress is to come back.

   Every request arrives as 'requested', never 'issued'. The office's own screen
   issues immediately — a clerk pressing the button has already decided — and a
   transfer certificate issued that way also marks the child as having left the
   school. A portal that could do that would let a parent withdraw their own
   child by filling in a form. */

interface RequestRow {
  id: string
  student_id: string
  student_name: string
  serial_no: string
  type: string
  code: string
  status: 'requested' | 'approved' | 'issued' | 'cancelled'
  issued_on: string
  reason?: string
  has_file: boolean
}

interface RequestType {
  id: string
  code: string
  name: string
  requires_approval: boolean
}

const TONE: Record<RequestRow['status'], 'warning' | 'info' | 'success' | 'neutral'> = {
  requested: 'warning',
  approved: 'info',
  issued: 'success',
  cancelled: 'neutral',
}

export default function Requests() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const [typeCode, setTypeCode] = useState('')
  const [reason, setReason] = useState('')

  const requests = useQuery({
    queryKey: ['portal-requests'],
    queryFn: () => api.get<List<RequestRow>>('/api/v1/portal/requests'),
  })
  const types = useQuery({
    queryKey: ['portal-request-types'],
    queryFn: () => api.get<List<RequestType>>('/api/v1/portal/requests/types'),
  })

  const raise = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/requests', {
        student_id: studentId,
        type_code: typeCode,
        reason,
      }),
    onSuccess: () => {
      setReason('')
      qc.invalidateQueries({ queryKey: ['portal-requests'] })
    },
  })

  if (requests.isLoading) return <Loading label="Looking up your requests…" />
  if (requests.error) return <ErrorState error={requests.error} />

  const rows = requests.data?.items ?? []
  const available = types.data?.items ?? []
  const waiting = rows.filter((r) => r.status === 'requested' || r.status === 'approved')
  const ready = studentId !== '' && typeCode !== '' && reason.trim() !== ''

  return (
    <>
      <PageHead
        eyebrow="Requests"
        title="Certificates"
        description="Ask the office for a document, and see how far it has got without ringing them."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="With the office" value={waiting.length} icon={FileCheck2} />
          <Stat label="Issued" value={rows.filter((r) => r.status === 'issued').length} />
          <Stat label="Ready to collect" value={rows.filter((r) => r.has_file).length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Ask for a certificate"
            description="The office writes the purpose on the certificate itself, so say what it is for."
          />
          <div className="p-4">
            <FormGrid>
              {children.length > 1 && (
                <Field label="Child" required>
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    placeholder="Choose a child"
                    options={childOptions(children)}
                  />
                </Field>
              )}
              <Field
                label="Which certificate"
                required
                hint={
                  available.find((t) => t.code === typeCode)?.requires_approval
                    ? 'This one needs the principal to approve it first.'
                    : undefined
                }
              >
                <Select
                  value={typeCode}
                  onChange={setTypeCode}
                  placeholder={available.length ? 'Choose one' : 'The school has not set any up'}
                  options={available.map((t) => ({ value: t.code, label: t.name }))}
                />
              </Field>
              <Field label="What it is for" required wide>
                <Textarea
                  rows={2}
                  value={reason}
                  onChange={setReason}
                  placeholder="Passport application"
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Button disabled={!ready || raise.isPending} onClick={() => raise.mutate()}>
                {raise.isPending ? 'Sending…' : 'Ask the office'}
              </Button>
            </div>
            <FormNotice
              error={raise.error}
              ok={raise.isSuccess ? 'Asked. The office can see it now.' : undefined}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Your requests"
            description="The number is what to quote if you ring the office."
          />
          <Table
            head={['Number', 'Certificate', 'Child', 'For', 'Asked on', 'Where it is']}
            empty={rows.length === 0}
            emptyLabel="You have not asked for any certificates."
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium tabular-nums">{r.serial_no}</Td>
                <Td>{r.type}</Td>
                <Td>{r.student_name}</Td>
                <Td className="max-w-[16rem]">{r.reason ?? '—'}</Td>
                <Td>{formatDate(r.issued_on)}</Td>
                <Td>
                  <Badge tone={TONE[r.status]}>{r.status}</Badge>
                  {r.has_file && (
                    <div className="text-[12px] text-muted-foreground">signed copy on file</div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <DocumentsOnFile />
      </PageBody>
    </>
  )
}

/* What the school already holds.

   Folded in here rather than living on its own screen: a family opening
   Requests is asking "where is my paperwork", and the answer is partly what
   has been issued and partly what the office is still holding. Two menu
   entries made that one question look like two.
*/
function DocumentsOnFile() {
  const q = useQuery({
    queryKey: ['portal-documents'],
    queryFn: () => api.get<List<DocumentRow>>('/api/v1/portal/documents'),
  })
  const rows = q.data?.items ?? []
  const unchecked = rows.filter((d) => !d.verified)

  return (
    <Card>
      <CardHeader
        title="Documents the school holds"
        description={
          rows.length
            ? `${rows.length} on file, ${unchecked.length} still to be checked. Anything missing has to go to the office — the portal does not accept uploads yet.`
            : 'Nothing on file yet. Documents given to the office appear here.'
        }
      />
      <Table
        head={['Document', 'Child', 'Given on', 'Size', 'Checked']}
        empty={rows.length === 0}
        emptyLabel="The school holds nothing on file."
      >
        {rows.map((d) => (
          <tr key={d.id}>
            <Td>
              <div className="font-medium">{d.doc_type}</div>
              <div className="text-[12px] text-muted-foreground">{d.file_name}</div>
              {d.notes && <div className="text-[12px] text-muted-foreground">{d.notes}</div>}
            </Td>
            <Td>{d.student_name}</Td>
            <Td>{formatDate(d.uploaded_on)}</Td>
            <Td className="tabular-nums">{fileSize(d.size_bytes)}</Td>
            <Td>
              <Badge tone={d.verified ? 'success' : 'warning'}>
                {d.verified ? 'checked' : 'not checked yet'}
              </Badge>
              {d.verified_by && (
                <div className="text-[12px] text-muted-foreground">by {d.verified_by}</div>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
