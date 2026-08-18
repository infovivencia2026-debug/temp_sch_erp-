import { useQuery } from '@tanstack/react-query'
import { FolderCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

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
  const docs = useQuery({
    queryKey: ['portal-documents'],
    queryFn: () => api.get<List<DocumentRow>>('/api/v1/portal/documents'),
  })

  if (docs.isLoading) return <Loading label="Looking up the file…" />
  if (docs.error) return <ErrorState error={docs.error} />

  const rows = docs.data?.items ?? []
  const unverified = rows.filter((d) => !d.verified)

  return (
    <>
      <PageHead
        eyebrow="Requests"
        title="Documents on file"
        description="What the school holds for your child, and whether the office has checked it."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="On file" value={rows.length} icon={FolderCheck} />
          <Stat label="Checked by the office" value={rows.length - unverified.length} />
          <Stat label="Still to be checked" value={unverified.length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Documents"
            description="Anything missing has to go to the office — the portal does not accept uploads yet."
          />
          <Table
            head={['Document', 'Child', 'Given on', 'Size', 'Checked']}
            empty={rows.length === 0}
            emptyLabel="The school holds nothing on file for your child."
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
      </PageBody>
    </>
  )
}
