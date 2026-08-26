/* The paperwork against one application.
 *
 * A checklist rather than a pile: the office needs to know what is still
 * outstanding, and a list of what happens to have been uploaded cannot say
 * that. Required rows come first because those are the ones that hold a seat.
 *
 * Any file type the store accepts — a photograph of a birth certificate taken
 * on a phone is what parents actually bring, and refusing it in favour of a
 * scanned PDF means the clerk keeps the paper instead.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, FileText, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import {
  Badge, Button, Input, Loading, ErrorState, FormNotice, Table, Td,
} from '@/components/ui'

export interface ApplicationDocument {
  id: string
  doc_type: string
  is_required: boolean
  status: string
  note?: string
  file_id?: string
  file_name?: string
  content_type?: string
  size_bytes?: number
  verified_by?: string
  verified_at?: string
}

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  verified: 'success',
  received: 'warning',
  rejected: 'danger',
  pending: 'neutral',
}

const SAYS: Record<string, string> = {
  pending: 'not brought in',
  received: 'in, not checked',
  verified: 'verified',
  rejected: 'rejected',
}

export default function Documents({
  applicationId,
  canWrite,
}: {
  applicationId: string
  canWrite: boolean
}) {
  const qc = useQueryClient()
  /* Which row is being rejected. The reason is required, so the box has to
     appear before the verdict is sent rather than after. */
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [why, setWhy] = useState('')

  const q = useQuery({
    queryKey: ['application-documents', applicationId],
    queryFn: () => api.get<List<ApplicationDocument>>(
      `/api/v1/admissions/workflow/applications/${applicationId}/documents`),
  })

  const decide = useMutation({
    mutationFn: (v: { id: string; status: string; note?: string; file_id?: string }) =>
      api.post(
        `/api/v1/admissions/workflow/applications/${applicationId}/documents/${v.id}`,
        { status: v.status, note: v.note, file_id: v.file_id },
      ),
    onSuccess: () => {
      setRejecting(null)
      setWhy('')
      qc.invalidateQueries({ queryKey: ['application-documents', applicationId] })
    },
  })

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />

  const items = q.data?.items ?? []
  const outstanding = items.filter((d) => d.is_required && d.status !== 'verified')

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="eyebrow">Documents</p>
        {outstanding.length === 0 ? (
          <Badge tone="success">All required paperwork verified</Badge>
        ) : (
          <Badge tone="warning">
            {outstanding.length} required {outstanding.length === 1 ? 'document' : 'documents'} outstanding
          </Badge>
        )}
      </div>

      <FormNotice error={decide.error} />

      <Table
        wide
        head={['Document', 'Status', 'File', 'Checked by', '']}
        empty={!items.length}
        emptyLabel="No checklist on this application."
      >
        {items.map((d) => (
          <tr key={d.id}>
            <Td className="font-medium">
              {d.doc_type}
              {d.is_required && (
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  required
                </span>
              )}
            </Td>
            <Td>
              <Badge tone={TONE[d.status] ?? 'neutral'}>{SAYS[d.status] ?? d.status}</Badge>
              {d.note && (
                <div className="mt-1 text-[12px] text-muted-foreground">{d.note}</div>
              )}
            </Td>
            <Td>
              {d.file_id ? (
                <a
                  href={`/api/v1/files/${d.file_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary"
                >
                  <FileText className="h-3.5 w-3.5" />
                  {d.file_name ?? 'the file'}
                </a>
              ) : canWrite ? (
                <div className="w-56">
                  <FilePicker
                    value={null}
                    purpose="admission_document"
                    label="Attach"
                    hint="Photo or scan, any format"
                    onChange={(f: UploadedFile | null) => {
                      if (!f) return
                      /* Attaching one is the school saying it has arrived, so
                         it moves to "in, not checked" in the same step. Nobody
                         uploads a document and then separately records that
                         they received it. */
                      decide.mutate({ id: d.id, status: 'received', file_id: f.file_id })
                    }}
                  />
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Td>
            <Td className="text-muted-foreground">
              {d.verified_by ? (
                <>
                  {d.verified_by}
                  {d.verified_at && (
                    <div className="text-[12px]">{d.verified_at}</div>
                  )}
                </>
              ) : '—'}
            </Td>
            <Td>
              {canWrite && (
                rejecting === d.id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <div className="w-52">
                      <Input
                        value={why}
                        onChange={setWhy}
                        srLabel="Why it was rejected"
                        placeholder="What is wrong with it?"
                      />
                    </div>
                    <Button
                      size="sm"
                      tone="danger"
                      disabled={!why.trim() || decide.isPending}
                      onClick={() => decide.mutate({ id: d.id, status: 'rejected', note: why })}
                    >
                      Reject
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => { setRejecting(null); setWhy('') }}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <span className="flex flex-wrap gap-2">
                    {d.status !== 'verified' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={decide.isPending}
                        title={d.file_id
                          ? 'Mark this document verified'
                          : 'Mark verified — the school has seen the original'}
                        onClick={() => decide.mutate({ id: d.id, status: 'verified' })}
                      >
                        <Check className="h-3.5 w-3.5" />
                        Verify
                      </Button>
                    )}
                    {d.status !== 'rejected' && d.status !== 'pending' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        tone="danger"
                        onClick={() => { setRejecting(d.id); setWhy('') }}
                      >
                        <X className="h-3.5 w-3.5" />
                        Reject
                      </Button>
                    )}
                  </span>
                )
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  )
}
