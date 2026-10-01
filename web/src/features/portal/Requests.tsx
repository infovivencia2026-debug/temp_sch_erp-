import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileCheck2 } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Field, FormGrid, FormNotice, Select, Textarea, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
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
  const t = useT()
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

  if (requests.isLoading && !requests.data) return <ScreenSkeleton label={t('portal.requests.loading')} />
  if (requests.error && !requests.data) return <ScreenError error={requests.error} />

  const rows = requests.data?.items ?? []
  const available = types.data?.items ?? []
  const waiting = rows.filter((r) => r.status === 'requested' || r.status === 'approved')
  const ready = studentId !== '' && typeCode !== '' && reason.trim() !== ''

  return (
    <>
      <PageHead
        eyebrow={t('portal.requests.eyebrow')}
        title={t('portal.requests.title')}
        description={t('portal.requests.description')}
      />
      <Freshness query={requests} />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.requests.stat_with_office')} value={waiting.length} icon={FileCheck2} />
          <Stat label={t('portal.requests.stat_issued')} value={rows.filter((r) => r.status === 'issued').length} />
          <Stat label={t('portal.requests.stat_ready')} value={rows.filter((r) => r.has_file).length} />
        </CellGrid>

        <Card>
          <CardHeader
            title={t('portal.requests.form_title')}
            description={t('portal.requests.form_description')}
          />
          <div className="p-4">
            <FormGrid>
              {children.length > 1 && (
                <Field label={t('portal.requests.field_child')} required>
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    placeholder={t('portal.requests.choose_child')}
                    options={childOptions(children)}
                  />
                </Field>
              )}
              <Field
                label={t('portal.requests.field_which')}
                required
                hint={
                  available.find((rt) => rt.code === typeCode)?.requires_approval
                    ? t('portal.requests.hint_needs_approval')
                    : undefined
                }
              >
                <Select
                  value={typeCode}
                  onChange={setTypeCode}
                  placeholder={
                    available.length
                      ? t('portal.requests.choose_one')
                      : t('portal.requests.no_types')
                  }
                  /* "Something else" sorts last wherever the office named it,
                     because it is the answer for when none of the others fit
                     and it should be read after them, not in the middle of the
                     alphabet between Fee Payment and Study. */
                  options={[...available]
                    .sort((a, b) => Number(a.code === 'OTHER') - Number(b.code === 'OTHER'))
                    .map((rt) => ({ value: rt.code, label: rt.name }))}
                />
              </Field>
              {/* WHEN NOTHING ON THE LIST IS WHAT THEY NEED.

                  A school issues a handful of certificates and a parent
                  occasionally needs a thing none of them is -- a letter for a
                  consulate, a form the bank has its own name for. The list
                  could not say so, and a dropdown with no way out is a dead
                  end at the exact moment somebody needs help.

                  "Something else" is a type like any other, so it goes into
                  the same queue, gets the same serial and the same tracking;
                  the purpose box, which is already required, is where they
                  write what it is. It just asks a plainer question. */}
              <Field
                label={typeCode === 'OTHER' ? 'What do you need, and what for?' : t('portal.requests.field_purpose')}
                required
                wide
                hint={typeCode === 'OTHER'
                  ? 'Say it in your own words. The office will tell you whether they can issue it.'
                  : undefined}
              >
                <Textarea
                  rows={typeCode === 'OTHER' ? 3 : 2}
                  value={reason}
                  onChange={setReason}
                  placeholder={typeCode === 'OTHER'
                    ? 'For example: a letter confirming my child studies here, addressed to the passport office'
                    : t('portal.requests.purpose_placeholder')}
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Button disabled={!ready || raise.isPending} onClick={() => raise.mutate()}>
                {raise.isPending ? t('portal.requests.sending') : t('portal.requests.action_ask')}
              </Button>
            </div>
            <FormNotice
              error={raise.error}
              ok={raise.isSuccess ? t('portal.requests.sent_ok') : undefined}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('portal.requests.list_title')}
            description={t('portal.requests.list_description')}
          />
          <Table
            head={[
              t('portal.requests.col_number'),
              t('portal.requests.col_certificate'),
              t('portal.requests.col_child'),
              t('portal.requests.col_for'),
              t('portal.requests.col_asked_on'),
              t('portal.requests.col_where'),
            ]}
            empty={rows.length === 0}
            emptyLabel={t('portal.requests.empty')}
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium tabular-nums">{r.serial_no}</Td>
                <Td>{r.type}</Td>
                <Td>{r.student_name}</Td>
                <Td className="max-w-[16rem]">{r.reason ?? '-'}</Td>
                <Td>{formatDate(r.issued_on)}</Td>
                <Td>
                  <Badge tone={TONE[r.status]}>{r.status}</Badge>
                  {r.has_file && (
                    <div className="text-[12px] text-muted-foreground">{t('portal.requests.signed_copy')}</div>
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
  const t = useT()
  const q = useQuery({
    queryKey: ['portal-documents'],
    queryFn: () => api.get<List<DocumentRow>>('/api/v1/portal/documents'),
  })
  const rows = q.data?.items ?? []
  const unchecked = rows.filter((d) => !d.verified)

  return (
    <Card>
      <CardHeader
        title={t('portal.requests.docs_title')}
        description={
          rows.length
            ? t('portal.requests.docs_description', {
                count: rows.length,
                unchecked: unchecked.length,
              })
            : t('portal.requests.docs_description_empty')
        }
      />
      {/* NOTHING ON FILE IS AN ANSWER, NOT AN EMPTY TABLE.

          A header row -- Document, Child, Given on, Size, Checked -- ruled
          across an empty card reads as a list that failed to load, and a
          parent cannot tell that from a school that holds nothing. The columns
          describe rows that do not exist; without rows they are furniture. So
          when there is nothing, the card says so in a sentence and the table
          is not drawn at all. */}
      {rows.length === 0 ? (
        <div className="px-[var(--card-pad)] pb-5">
          <EmptyState
            title="No documents on file"
            body={'The school has not recorded any document for '
              + 'your child yet — no birth certificate, no transfer certificate, nothing. '
              + 'Anything you hand in at the office appears here once it has been filed.'}
          />
        </div>
      ) : (
      <Table
        head={[
          t('portal.requests.docs_col_document'),
          t('portal.requests.docs_col_child'),
          t('portal.requests.docs_col_given_on'),
          t('portal.requests.docs_col_size'),
          t('portal.requests.docs_col_checked'),
        ]}
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
                {d.verified
                  ? t('portal.requests.docs_badge_checked')
                  : t('portal.requests.docs_badge_unchecked')}
              </Badge>
              {d.verified_by && (
                <div className="text-[12px] text-muted-foreground">
                  {t('portal.requests.docs_checked_by', { name: d.verified_by })}
                </div>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      )}
    </Card>
  )
}
