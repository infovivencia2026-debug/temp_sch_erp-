import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, ExternalLink } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import { MATERIAL_KINDS, label, type Material } from './teaching'

/* The library a class already has.

   The same rows the upload screen writes — one table, so the two screens can
   never disagree about what a class has been given. This one is for finding
   and withdrawing; LMS Study Material Upload is for adding. */

export default function StudyMaterials() {
  const toast = useToast()
  const qc = useQueryClient()
  const [kind, setKind] = useState('')
  const [subject, setSubject] = useState('')

  const list = useQuery({
    queryKey: ['teaching-materials'],
    queryFn: () => api.get<List<Material>>('/api/v1/teaching/materials'),
  })

  const publish = useMutation({
    mutationFn: (v: { id: string; is_published: boolean }) =>
      api.put(`/api/v1/teaching/materials/${v.id}`, { is_published: v.is_published }),
    onSuccess: () => {
      toast.ok('Updated')
      qc.invalidateQueries({ queryKey: ['teaching-materials'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not update'),
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const all = list.data?.items ?? []
  const subjects = [...new Set(all.map((m) => m.subject).filter(Boolean))] as string[]
  const rows = all.filter(
    (m) => (!kind || m.kind === kind) && (!subject || m.subject === subject),
  )

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Study materials"
        description="Notes, worksheets and references shared with your classes."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Items shared" value={all.length} icon={BookOpen} />
          <Stat label="Published" value={all.filter((m) => m.is_published).length} />
          <Stat label="Withdrawn" value={all.filter((m) => !m.is_published).length} />
        </CellGrid>

        <Card>
          <CardHeader
            title="Library"
            description="Withdrawing hides an item from the class without deleting it."
            action={
              <>
                <Select
                  value={kind}
                  onChange={setKind}
                  placeholder="Any kind"
                  options={MATERIAL_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                />
                <Select
                  value={subject}
                  onChange={setSubject}
                  placeholder="Any subject"
                  options={subjects.map((s) => ({ value: s, label: s }))}
                />
              </>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing shared yet"
              body="Add notes or a video link from the LMS Study Material Upload screen."
            />
          ) : (
            <Table head={['Title', 'Class', 'Subject', 'Kind', 'Added', 'Status', '']}>
              {rows.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <span className="font-medium">{m.title}</span>
                    {m.description && (
                      <span className="block text-[12px] text-muted-foreground">
                        {m.description}
                      </span>
                    )}
                  </Td>
                  <Td>{m.class_name ?? m.section ?? '—'}</Td>
                  <Td>{m.subject ?? '—'}</Td>
                  <Td>{label(MATERIAL_KINDS, m.kind)}</Td>
                  <Td>{formatDate(m.created_at)}</Td>
                  <Td>
                    {m.is_published
                      ? <Badge tone="success">Shared</Badge>
                      : <Badge tone="neutral">Withdrawn</Badge>}
                  </Td>
                  <Td>
                    <div className="flex gap-2">
                      {m.external_url && (
                        <a
                          href={m.external_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[13px] underline"
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          publish.mutate({ id: m.id, is_published: !m.is_published })
                        }
                      >
                        {m.is_published ? 'Withdraw' : 'Share'}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
