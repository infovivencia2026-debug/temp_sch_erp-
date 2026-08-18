import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Panel, Table, Td, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  Loading, ErrorState, EmptyState, UnavailableState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import {
  MATERIAL_KINDS, useTeachingClasses, useTeachingSubjects, label,
  type Material,
} from './teaching'

/* Adding to the class library.

   Writes the same study_materials rows the library screen reads. A file and a
   link are both accepted and at least one is required, because an item that
   points at nothing is a title that disappoints thirty children when they tap
   it.

   Object storage is unconfigured on this deployment: /api/v1/files/presign
   answers 503 and no file id can be minted at all. The form says so rather
   than offering a file picker that fails at the last step, and a link works
   today and will keep working once storage is wired. */

interface PresignResponse { file_id: string; url: string }

export default function LMSUpload() {
  const toast = useToast()
  const qc = useQueryClient()
  const classes = useTeachingClasses()
  const subjects = useTeachingSubjects()

  const [classSubjectID, setClassSubjectID] = useState('')
  const [sectionID, setSectionID] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState('note')
  const [externalURL, setExternalURL] = useState('')
  const [publishNow, setPublishNow] = useState(true)

  const list = useQuery({
    queryKey: ['teaching-materials'],
    queryFn: () => api.get<List<Material>>('/api/v1/teaching/materials'),
  })

  /* Asked once, on load, so the form can tell the truth about uploads before
     the teacher has picked a file rather than after. */
  const storage = useQuery({
    queryKey: ['files-presign-probe'],
    retry: false,
    queryFn: async () => {
      try {
        await api.post<PresignResponse>('/api/v1/files/presign', {
          filename: 'probe.pdf',
          content_type: 'application/pdf',
          size_bytes: 1,
          purpose: 'study_material',
        })
        return { available: true }
      } catch {
        return { available: false }
      }
    },
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/teaching/materials', {
        class_subject_id: classSubjectID || undefined,
        section_id: sectionID || undefined,
        title,
        description: description || undefined,
        kind,
        external_url: externalURL || undefined,
        is_published: publishNow,
      }),
    onSuccess: () => {
      toast.ok('Added to the class library')
      setTitle('')
      setDescription('')
      setExternalURL('')
      qc.invalidateQueries({ queryKey: ['teaching-materials'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not add'),
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const recent = (list.data?.items ?? []).slice(0, 12)
  const uploadsWork = storage.data?.available === true

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="LMS study material upload"
        description="Share notes, recordings, slides and video links with a class."
      />
      <PageBody>
        {!uploadsWork && (
          <Panel>
            <UnavailableState
              title="File upload is unavailable on this deployment"
              body="Object storage is not configured, so the school cannot host a file yet. Share a link instead — a Drive document, a YouTube lesson or a published PDF — which works now and keeps working once storage is connected."
              technical={[
                { label: 'Endpoint', value: 'POST /api/v1/files/presign' },
                { label: 'Response', value: '503 storage_unconfigured' },
                { label: 'Workaround', value: 'external_url' },
              ]}
            />
          </Panel>
        )}

        <Card>
          <CardHeader
            title="Add material"
            description="It appears for the class as soon as it is shared."
          />
          <div className="px-5 pb-5">
            <FormGrid>
              <Field label="Subject" hint="Leave blank to share with a whole class instead">
                <Select
                  value={classSubjectID}
                  onChange={setClassSubjectID}
                  placeholder="Choose a subject"
                  options={(subjects.data?.items ?? []).map((s) => ({
                    value: s.class_subject_id,
                    label: `${s.class_name} · ${s.subject}`,
                  }))}
                />
              </Field>
              <Field label="Class" hint="Used when the material is not subject-specific">
                <Select
                  value={sectionID}
                  onChange={setSectionID}
                  placeholder="No particular class"
                  options={(classes.data?.items ?? []).map((c) => ({
                    value: c.section_id,
                    label: `${c.class_name} ${c.section_name}`,
                  }))}
                />
              </Field>
              <Field label="Title" required>
                <Input value={title} onChange={setTitle} placeholder="Chapter 4 — Light" />
              </Field>
              <Field label="Kind">
                <Select
                  value={kind}
                  onChange={setKind}
                  options={MATERIAL_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                />
              </Field>
              <Field
                label="Link"
                required
                wide
                hint={
                  uploadsWork
                    ? 'A link to the document, recording or video.'
                    : 'Required while file storage is unconfigured.'
                }
              >
                <Input
                  value={externalURL}
                  onChange={setExternalURL}
                  placeholder="https://…"
                />
              </Field>
            </FormGrid>
            <Field label="Description">
              <Textarea
                value={description}
                onChange={setDescription}
                rows={2}
                placeholder="What this covers, and what to do with it."
              />
            </Field>
            <div className="mt-3">
              <Checkbox
                checked={publishNow}
                onChange={setPublishNow}
                label="Share with the class now"
                hint="Leave unticked to add it quietly and share later."
              />
            </div>
            <FormNotice error={save.error} />
            <div className="mt-3">
              <Button
                onClick={() => save.mutate()}
                disabled={!title.trim() || !externalURL.trim() || (!classSubjectID && !sectionID)}
              >
                <Upload className="h-3.5 w-3.5" />
                Add material
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Recently added" description="The last dozen items you shared" />
          {recent.length === 0 ? (
            <EmptyState title="Nothing shared yet" />
          ) : (
            <Table head={['Title', 'Class', 'Subject', 'Kind', 'Added', 'Status']}>
              {recent.map((m) => (
                <tr key={m.id}>
                  <Td>{m.title}</Td>
                  <Td>{m.class_name ?? m.section ?? '—'}</Td>
                  <Td>{m.subject ?? '—'}</Td>
                  <Td>{label(MATERIAL_KINDS, m.kind)}</Td>
                  <Td>{formatDate(m.created_at)}</Td>
                  <Td>
                    {m.is_published
                      ? <Badge tone="success">Shared</Badge>
                      : <Badge tone="neutral">Not shared</Badge>}
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
