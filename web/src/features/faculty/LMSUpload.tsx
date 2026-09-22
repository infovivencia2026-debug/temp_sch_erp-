import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload, Eye, Users, School, BookOpen, Search } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { formatDate, formatDateTime, cn } from '@/lib/utils'
import {
  MATERIAL_KINDS, AUDIENCES, SHOW_FOR, useTeachingClasses, useTeachingSubjects, label,
  type Material, type MaterialView,
} from './teaching'
import { useRoster } from './comms'

/* The digital library, from the teacher's side.

   Writes the same study_materials rows the children's resource hub reads,
   and since 00334 says who each one is for: a class or a subject, the
   whole school, or a list of named children. The third is the one this
   screen was missing. A remedial worksheet, a certificate, a photograph of
   one child's project: five families' business, not the class's, and
   until now the only way to share it was to share it with everyone.

   A picture or a video posted here shows to the children the way a status
   shows on a phone: full screen, in order, marked seen as it is looked at.
   "Seen" below is the other half of that, the count of readers who have
   opened each thing, and who they were.

   A file and a link are both accepted and at least one is required,
   because an item that points at nothing is a title that disappoints
   thirty children when they tap it. */

type Audience = (typeof AUDIENCES)[number]['value']

const AUDIENCE_ICON = { class: BookOpen, students: Users, school: School } as const

export default function LMSUpload() {
  const toast = useToast()
  const qc = useQueryClient()
  const classes = useTeachingClasses()
  const subjects = useTeachingSubjects()

  const [audience, setAudience] = useState<Audience>('class')
  const [classSubjectID, setClassSubjectID] = useState('')
  const [sectionID, setSectionID] = useState('')
  const [rosterSection, setRosterSection] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(() => new Set())
  const [find, setFind] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState('note')
  const [showFor, setShowFor] = useState('')
  const [externalURL, setExternalURL] = useState('')
  const [file, setFile] = useState<UploadedFile | null>(null)
  const [publishNow, setPublishNow] = useState(true)
  const [seenOf, setSeenOf] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['teaching-materials'],
    queryFn: () => api.get<List<Material>>('/api/v1/teaching/materials'),
  })
  const roster = useRoster(rosterSection)
  const pupils = useMemo(() => {
    const q = find.trim().toLowerCase()
    const all = roster.data?.items ?? []
    if (!q) return all
    return all.filter((s) =>
      s.full_name.toLowerCase().includes(q) || s.admission_no.toLowerCase().includes(q))
  }, [roster.data, find])

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/teaching/materials', {
        audience,
        class_subject_id: audience === 'class' && classSubjectID ? classSubjectID : undefined,
        section_id: audience === 'class' && sectionID ? sectionID : undefined,
        student_ids: audience === 'students' ? Array.from(chosen) : undefined,
        title,
        description: description || undefined,
        kind,
        external_url: externalURL || undefined,
        file_id: file?.file_id,
        is_published: publishNow,
        expires_in_days: showFor ? Number(showFor) : undefined,
      }),
    onSuccess: () => {
      toast.ok(
        audience === 'students'
          ? `Shared with ${chosen.size} student${chosen.size === 1 ? '' : 's'}`
          : audience === 'school' ? 'Shared with the whole school' : 'Added to the class library',
      )
      setTitle('')
      setDescription('')
      setExternalURL('')
      setFile(null)
      setChosen(new Set())
      qc.invalidateQueries({ queryKey: ['teaching-materials'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not add'),
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const recent = (list.data?.items ?? []).slice(0, 20)

  const addressed =
    audience === 'class' ? Boolean(classSubjectID || sectionID)
    : audience === 'students' ? chosen.size > 0
    : true
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Digital library"
        description="Share notes, pictures, recordings and links with a class, the whole school, or the students you choose."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Share something"
            description="It appears for the people it is addressed to as soon as it is shared. Pictures and videos show full screen, like a status."
          />
          <div className="px-5 pb-5">
            {/* WHO. Three widths of audience as three buttons, because the
                choice is what the rest of the form depends on and a dropdown
                hides the option most teachers did not know they had. */}
            <div className="mb-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Share with">
              {AUDIENCES.map((a) => {
                const Icon = AUDIENCE_ICON[a.value]
                const on = audience === a.value
                return (
                  <button
                    key={a.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setAudience(a.value)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {a.label}
                  </button>
                )
              })}
            </div>

            {audience === 'class' && (
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
              </FormGrid>
            )}

            {audience === 'students' && (
              <div className="mb-4 rounded-xl border">
                <div className="flex flex-wrap items-end gap-3 border-b p-3">
                  <div className="min-w-[200px] flex-1">
                    <Field label="Class" hint="Pick a class, then tick the students">
                      <Select
                        value={rosterSection}
                        onChange={(v) => { setRosterSection(v); setFind('') }}
                        placeholder="Choose a class"
                        options={(classes.data?.items ?? []).map((c) => ({
                          value: c.section_id,
                          label: `${c.class_name} ${c.section_name}`,
                        }))}
                      />
                    </Field>
                  </div>
                  <div className="min-w-[200px] flex-1">
                    <Field label="Find">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <input
                          value={find}
                          onChange={(e) => setFind(e.target.value)}
                          placeholder="Name or admission no."
                          className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-[13.5px]"
                        />
                      </div>
                    </Field>
                  </div>
                  <div className="flex items-center gap-2 pb-0.5 text-[13px]">
                    <Badge tone={chosen.size ? 'primary' : 'neutral'}>{chosen.size} chosen</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pupils.length === 0}
                      onClick={() => setChosen(new Set([...chosen, ...pupils.map((s) => s.id)]))}
                    >
                      Tick all shown
                    </Button>
                    <Button variant="ghost" size="sm" disabled={chosen.size === 0} onClick={() => setChosen(new Set())}>
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {!rosterSection ? (
                    <p className="p-4 text-[13px] text-muted-foreground">Choose a class to see its students.</p>
                  ) : roster.isLoading ? (
                    <p className="p-4 text-[13px] text-muted-foreground">Loading the class list…</p>
                  ) : pupils.length === 0 ? (
                    <p className="p-4 text-[13px] text-muted-foreground">Nobody matches.</p>
                  ) : (
                    <ul className="divide-y">
                      {pupils.map((s) => {
                        const on = chosen.has(s.id)
                        return (
                          <li key={s.id}>
                            <label className={cn('flex cursor-pointer items-center gap-3 px-3 py-2 text-[13.5px] hover:bg-muted/60', on && 'bg-primary/5')}>
                              <input type="checkbox" checked={on} onChange={() => toggle(s.id)} className="size-4" />
                              <span className="min-w-0 flex-1 truncate font-medium">{s.full_name}</span>
                              <span className="text-[12px] tabular-nums text-muted-foreground">
                                {s.roll_no ? `Roll ${s.roll_no} · ` : ''}{s.admission_no}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {audience === 'school' && (
              <p className="mb-4 rounded-xl border border-dashed p-3 text-[13px] text-muted-foreground">
                Every student in the school will see this. Only somebody whose reach is the whole school
                can share this way; a class teacher's post is refused rather than sent to children they do not teach.
              </p>
            )}

            <FormGrid>
              <Field label="Title" required>
                <Input value={title} onChange={setTitle} placeholder="Chapter 4 · Light" />
              </Field>
              <Field label="Kind">
                <Select
                  value={kind}
                  onChange={setKind}
                  options={MATERIAL_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                />
              </Field>
              <Field label="Upload a file" wide hint="A picture, a video, a PDF, a slide deck or an archive, up to 64 MB. Pictures and videos play full screen for the students.">
                <FilePicker value={file} onChange={setFile} purpose="study_material" />
              </Field>
              <Field label="Or share a link" wide hint="A Drive document, a YouTube lesson, a published PDF.">
                <Input value={externalURL} onChange={setExternalURL} placeholder="https://…" />
              </Field>
              <Field label="Show for" hint="A status disappears; a handbook stays.">
                <Select value={showFor} onChange={setShowFor} options={SHOW_FOR} />
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
                label="Share now"
                hint="Leave unticked to add it quietly and share later."
              />
            </div>
            <FormNotice error={save.error} />
            <div className="mt-3">
              <Button
                onClick={() => save.mutate()}
                disabled={save.isPending || !title.trim() || (!externalURL.trim() && !file) || !addressed}
              >
                <Upload className="h-3.5 w-3.5" />
                {audience === 'students' ? `Share with ${chosen.size || 'the'} student${chosen.size === 1 ? '' : 's'}`
                  : audience === 'school' ? 'Share with the school' : 'Add to the class library'}
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Recently shared" description="The last twenty items, with how many readers have opened each" />
          {recent.length === 0 ? (
            <EmptyState title="Nothing shared yet" />
          ) : (
            <Table head={['Title', 'Shared with', 'Kind', 'Added', 'Seen', 'Status']}>
              {recent.map((m) => (
                <RecentRow
                  key={m.id}
                  m={m}
                  open={seenOf === m.id}
                  onToggle={() => setSeenOf(seenOf === m.id ? null : m.id)}
                />
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function audienceLabel(m: Material): string {
  if (m.audience === 'students') return `${m.targets ?? 0} student${m.targets === 1 ? '' : 's'}`
  if (m.audience === 'school' || (!m.class_name && !m.section)) return 'Whole school'
  const where = m.class_name ?? m.section ?? ''
  return m.subject ? `${where} · ${m.subject}` : where
}

/* One shared item and, opened, who has seen it. The list of names sits
   under the row rather than in a dialog because a teacher reads it while
   looking at the row it belongs to. */
function RecentRow({ m, open, onToggle }: { m: Material; open: boolean; onToggle: () => void }) {
  const views = useQuery({
    queryKey: ['teaching-material-views', m.id],
    queryFn: () => api.get<List<MaterialView>>(`/api/v1/teaching/materials/${m.id}/views`),
    enabled: open,
  })
  const expired = m.expires_at ? new Date(m.expires_at).getTime() < Date.now() : false
  return (
    <>
      <tr>
        <Td>
          <span className="font-medium">{m.title}</span>
          {m.expires_at && (
            <span className="ml-2 text-[12px] text-muted-foreground">
              {expired ? 'expired' : `until ${formatDate(m.expires_at)}`}
            </span>
          )}
        </Td>
        <Td>{audienceLabel(m)}</Td>
        <Td>{label(MATERIAL_KINDS, m.kind)}</Td>
        <Td>{formatDate(m.created_at)}</Td>
        <Td>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12.5px] tabular-nums hover:bg-muted"
          >
            <Eye className="size-3.5" aria-hidden />
            {m.views ?? 0}
          </button>
        </Td>
        <Td>
          {m.is_published
            ? <Badge tone="success">Shared</Badge>
            : <Badge tone="neutral">Not shared</Badge>}
        </Td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-muted/40 px-4 py-3 text-[13px]">
            {views.isLoading ? (
              <span className="text-muted-foreground">Looking up who has opened it…</span>
            ) : (views.data?.items ?? []).length === 0 ? (
              <span className="text-muted-foreground">Nobody has opened this yet.</span>
            ) : (
              <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {(views.data?.items ?? []).map((v, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {v.student && v.student !== v.name ? `${v.student} (${v.name})` : v.name}
                    </span>
                    <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                      {formatDateTime(v.viewed_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
