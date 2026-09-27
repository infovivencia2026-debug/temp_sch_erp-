import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Button, FormNotice } from '@/components/ui'
import { bytes, stamp } from './BackupsShared'

interface ExportRow {
  id: string
  status: string
  size_bytes: number
  tables: number
  row_count: number
  files: number
  requested_by_name: string | null
  requested_by_platform: boolean
  created_at: string
  expires_at: string | null
  download_url: string | null
}

/** For a school's own administrator: take all of the school's data away, as CSV in a ZIP. */
export function BackupsSchoolExport() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['data-export'], queryFn: () => api.get<{ items: ExportRow[]; ttl_days: number }>('/api/v1/admin/data-export'), retry: false })
  const ask = useMutation({ mutationFn: () => api.post('/api/v1/admin/data-export'), onSuccess: () => qc.invalidateQueries({ queryKey: ['data-export'] }) })
  if (q.error) return null // not this person's to see
  const items = q.data?.items ?? []
  return (
    <Card>
      <CardHeader title="Export all of the school's data"
        action={<Button size="sm" pending={ask.isPending} onClick={() => ask.mutate()}>Request export</Button>} />
      <p className="border-b px-5 py-3 text-[13px] text-muted-foreground">
        Every table as a CSV file, plus a list of every uploaded file, in one ZIP. The download link works for {q.data?.ttl_days ?? 7} days.
      </p>
      <Table head={['Asked', 'By', 'Status', 'Rows', 'Files', 'Size', 'Expires', '']} empty={items.length === 0} loading={q.isLoading} emptyLabel="No export yet.">
        {items.map((e) => (
          <tr key={e.id}>
            <Td className="num whitespace-nowrap">{stamp(e.created_at)}</Td>
            <Td>{e.requested_by_platform ? 'Software provider' : e.requested_by_name ?? '-'}</Td>
            <Td><Badge tone={e.status === 'ready' ? 'success' : e.status === 'failed' ? 'danger' : 'neutral'}>{e.status}</Badge></Td>
            <Td className="num">{e.row_count.toLocaleString()}</Td>
            <Td className="num">{e.files}</Td>
            <Td className="num">{bytes(e.size_bytes)}</Td>
            <Td className="num">{e.expires_at?.slice(0, 10) ?? '-'}</Td>
            <Td>{e.download_url && <a className="text-primary hover:underline" href={e.download_url}>Download</a>}</Td>
          </tr>
        ))}
      </Table>
      {ask.error ? <div className="border-t px-5 py-3"><FormNotice error={ask.error} /></div> : null}
    </Card>
  )
}
