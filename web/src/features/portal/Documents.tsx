import { useQuery } from '@tanstack/react-query'
import { FolderCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  SkeletonTable, } from '@/components/ui'
import { ScreenError } from './screen-error'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'

/* What the school holds on file for your child.

   The birth certificate, the Aadhaar copy, the last school's transfer
   certificate — and, the part families actually ring about, whether the office
   has checked them. A parent who cannot see this telephones to ask whether a
   document arrived, which is most of what the front desk's line is for.

   It lists what is held rather than handing the bytes back. A download means
   presigning object storage from a family endpoint, and that deserves its own
   review rather than being folded in here; the office can still send a copy. */

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

export default function Documents() {
  const t = useT()
  const docs = useQuery({
    queryKey: ['portal-documents'],
    queryFn: () => api.get<List<DocumentRow>>('/api/v1/portal/documents'),
  })

  if (docs.isLoading) return <SkeletonTable columns={6} label={t('portal.documents.loading')} />
  if (docs.error) return <ScreenError error={docs.error} />

  const rows = docs.data?.items ?? []
  const unverified = rows.filter((d) => !d.verified)

  return (
    <>
      <PageHead
        eyebrow={t('portal.documents.eyebrow')}
        title={t('portal.documents.title')}
        description={t('portal.documents.description')}
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.documents.stat_on_file')} value={rows.length} icon={FolderCheck} />
          <Stat
            label={t('portal.documents.stat_checked')}
            value={rows.length - unverified.length}
          />
          <Stat label={t('portal.documents.stat_unchecked')} value={unverified.length} />
        </CellGrid>

        <Card>
          <CardHeader
            title={t('portal.documents.card_title')}
            description={t('portal.documents.card_description')}
          />
          <Table
            head={[
              t('portal.documents.col_document'),
              t('portal.documents.col_child'),
              t('portal.documents.col_given_on'),
              t('portal.documents.col_size'),
              t('portal.documents.col_checked'),
            ]}
            empty={rows.length === 0}
            emptyLabel={t('portal.documents.empty')}
          >
            {rows.map((d) => (
              <tr key={d.id}>
                <Td>
                  <div className="font-medium">{d.doc_type}</div>
                  <div className="text-[12px] text-muted-foreground">{d.file_name}</div>
                  {d.notes && (
                    <div className="text-[12px] text-muted-foreground">{d.notes}</div>
                  )}
                </Td>
                <Td>{d.student_name}</Td>
                <Td>{formatDate(d.uploaded_on)}</Td>
                <Td className="tabular-nums">{fileSize(d.size_bytes)}</Td>
                <Td>
                  <Badge tone={d.verified ? 'success' : 'warning'}>
                    {d.verified
                      ? t('portal.documents.badge_checked')
                      : t('portal.documents.badge_unchecked')}
                  </Badge>
                  {d.verified_by && (
                    <div className="text-[12px] text-muted-foreground">
                      {t('portal.documents.checked_by', { name: d.verified_by })}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}
