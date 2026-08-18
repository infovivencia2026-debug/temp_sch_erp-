import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Image, ShieldCheck, Trophy } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'
import { commsQueryKeys } from './comms-keys'

/* institution_admin.communication.school_achievements_showcase

   student_achievements has existed since the first migration and until now
   nothing in the product ever wrote to it — one read, in the portfolio screen,
   and no insert anywhere. So this is the register's first write path, plus
   publication, plus pictures.

   The consent step is the part worth reading. There is no photo-consent flag
   anywhere in this product: not on students, not on guardians. Rather than
   invent a school-wide one that gets defaulted at import and never revisited,
   permission is recorded against the single act it authorises — publishing
   this achievement, this child's name, these photographs — with who confirmed
   it and on what basis. The publish button is refused without it by a database
   constraint, not only by this screen. */

interface Media {
  id: string
  file_id?: string
  file_name?: string
  external_url?: string
  caption?: string
  sort_order: number
}

interface Achievement {
  id: string
  student_id: string
  student: string
  class?: string
  kind: string
  title: string
  description?: string
  showcase_note?: string
  level?: string
  position?: string
  awarded_on?: string
  is_published: boolean
  published_at?: string
  published_by?: string
  consent_basis?: string
  consent_confirmed_by?: string
  consent_confirmed_at?: string
  media_count: number
  media?: Media[]
}

const KINDS = ['award', 'sport', 'club', 'activity', 'competition', 'position']
const LEVELS = ['class', 'school', 'district', 'state', 'national', 'international']

const CONSENT_BASES = [
  { value: 'signed_consent_form', label: 'Signed consent form on file' },
  { value: 'admission_form', label: 'Agreed at admission' },
  { value: 'portal_confirmation', label: 'Confirmed by the family in the portal' },
  { value: 'recorded_verbal', label: 'Agreed by phone, minuted' },
  { value: 'staff_child', label: "A member of staff's own child" },
]

const LEVEL_TONE: Record<string, 'neutral' | 'info' | 'success' | 'primary'> = {
  class: 'neutral',
  school: 'neutral',
  district: 'info',
  state: 'info',
  national: 'success',
  international: 'primary',
}

const blank = {
  student_id: '', kind: 'award', title: '', description: '', showcase_note: '',
  level: '', position: '', awarded_on: '',
}

export default function AchievementsShowcase() {
  const qc = useQueryClient()
  const can = useCan()
  const mayEdit = can('students.write')
  const mayPublish = can('comms.announcements.write')

  const [filters, setFilters] = useState({ kind: '', level: '', q: '' })
  const [form, setForm] = useState(blank)
  const [selected, setSelected] = useState<string | null>(null)
  const [consent, setConsent] = useState('signed_consent_form')
  const [media, setMedia] = useState({ external_url: '', caption: '' })

  /* Opening another achievement resets the consent basis and the media box.

     Both were held here against an id, so the basis chosen for one child —
     "verbal permission from a parent", say — stayed selected when the next
     entry was opened, and confirming recorded that basis against a different
     child. The basis is the record of why this child's name and photograph may
     be published, and the media box is the photograph itself: carried across,
     it attaches one child's picture to another's achievement. Back to the
     default, which is the safest of the bases and still has to be chosen
     deliberately. */
  const openEntry = (id: string | null) => {
    setSelected(id)
    setConsent('signed_consent_form')
    setMedia({ external_url: '', caption: '' })
  }

  const list = useQuery({
    queryKey: commsQueryKeys.achievements(filters.kind, filters.level, filters.q),
    queryFn: () =>
      api.get<List<Achievement>>(
        `/api/v1/comms/achievements/?kind=${filters.kind}&level=${filters.level}` +
          `&q=${encodeURIComponent(filters.q)}`,
      ),
  })
  const detail = useQuery({
    queryKey: commsQueryKeys.achievement(selected),
    queryFn: () => api.get<Achievement>(`/api/v1/comms/achievements/${selected}`),
    enabled: !!selected,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: commsQueryKeys.achievementRoot() })

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/comms/achievements/', {
        student_id: form.student_id,
        kind: form.kind,
        title: form.title,
        description: form.description || undefined,
        showcase_note: form.showcase_note || undefined,
        level: form.level || undefined,
        position: form.position || undefined,
        awarded_on: form.awarded_on || undefined,
      }),
    onSuccess: (r) => {
      setForm(blank)
      openEntry(r.id)
      refresh()
    },
  })
  const recordConsent = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/comms/achievements/${selected}/consent`, { basis: consent }),
    onSuccess: refresh,
  })
  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/comms/achievements/${id}/publish`, {}),
    onSuccess: refresh,
  })
  const unpublish = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/comms/achievements/${id}/unpublish`, {}),
    onSuccess: refresh,
  })
  const addMedia = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/comms/achievements/${selected}/media`, {
        external_url: media.external_url,
        caption: media.caption || undefined,
      }),
    onSuccess: () => {
      setMedia({ external_url: '', caption: '' })
      refresh()
    },
  })
  const removeMedia = useMutation({
    mutationFn: (mid: string) =>
      api.del(`/api/v1/comms/achievements/${selected}/media/${mid}`),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/comms/achievements/${id}`),
    onSuccess: () => {
      openEntry(null)
      refresh()
    },
  })

  const rows = list.data?.items ?? []
  const published = rows.filter((a) => a.is_published).length
  const awaiting = rows.filter((a) => !a.is_published && !a.consent_confirmed_at).length

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="School achievements"
        description="Awards, sporting wins and academic honours — recorded here, and published to families only once the school has confirmed the family agreed."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="On the register" value={rows.length} icon={Trophy} />
          <Stat label="Live on the parent portal" value={published} icon={Image} />
          <Stat
            label="Awaiting a confirmation"
            value={awaiting}
            icon={ShieldCheck}
            hint="Cannot be published until recorded"
          />
        </CellGrid>

        {mayEdit && (
          <Card>
            <CardHeader
              title="Record an achievement"
              description="Created unpublished, always. Publishing is a separate decision by a separate person."
            />
            <div className="space-y-4 p-5">
              <FormGrid>
                <Field label="Student id" required hint="The child's uuid from the students register">
                  <Input
                    value={form.student_id}
                    onChange={(v) => setForm({ ...form, student_id: v })}
                  />
                </Field>
                <Field label="Title" required>
                  <Input
                    value={form.title}
                    onChange={(v) => setForm({ ...form, title: v })}
                    placeholder="First place, district athletics 400m"
                  />
                </Field>
                <Field label="Kind">
                  <Select
                    value={form.kind}
                    onChange={(v) => setForm({ ...form, kind: v })}
                    options={KINDS.map((k) => ({ value: k, label: k }))}
                  />
                </Field>
                <Field label="Level">
                  <Select
                    value={form.level}
                    onChange={(v) => setForm({ ...form, level: v })}
                    placeholder="Not stated"
                    options={LEVELS.map((l) => ({ value: l, label: l }))}
                  />
                </Field>
                <Field label="Position">
                  <Input
                    value={form.position}
                    onChange={(v) => setForm({ ...form, position: v })}
                    placeholder="Gold, runner-up, 3rd"
                  />
                </Field>
                <Field label="Awarded on">
                  <Input
                    type="date"
                    value={form.awarded_on}
                    onChange={(v) => setForm({ ...form, awarded_on: v })}
                  />
                </Field>
                <Field
                  label="Showcase note"
                  wide
                  hint="The sentence families read. The description below stays on the child's record."
                >
                  <Textarea
                    value={form.showcase_note}
                    onChange={(v) => setForm({ ...form, showcase_note: v })}
                    rows={2}
                  />
                </Field>
                <Field label="Internal description" wide>
                  <Textarea
                    value={form.description}
                    onChange={(v) => setForm({ ...form, description: v })}
                    rows={2}
                  />
                </Field>
              </FormGrid>
              <Button
                disabled={!form.student_id.trim() || !form.title.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                Record
              </Button>
              <FormNotice error={create.error} />
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="The register"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={filters.q}
                  onChange={(v) => setFilters({ ...filters, q: v })}
                  placeholder="Search titles"
                  srLabel="Search achievements"
                />
                <Select
                  value={filters.kind}
                  onChange={(v) => setFilters({ ...filters, kind: v })}
                  placeholder="Any kind"
                  options={KINDS.map((k) => ({ value: k, label: k }))}
                />
                <Select
                  value={filters.level}
                  onChange={(v) => setFilters({ ...filters, level: v })}
                  placeholder="Any level"
                  options={LEVELS.map((l) => ({ value: l, label: l }))}
                />
              </div>
            }
          />
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorState error={list.error} />
          ) : (
            <Table
              head={['Awarded', 'Child', 'Achievement', 'Level', 'Pictures', 'Confirmation', 'Portal', '']}
              empty={rows.length === 0}
              emptyLabel="Nothing recorded yet."
            >
              {rows.map((a) => (
                <tr key={a.id}>
                  <Td>{a.awarded_on ? formatDate(a.awarded_on) : '—'}</Td>
                  <Td>
                    {a.student}
                    {a.class && (
                      <span className="block text-[13px] text-muted-foreground">{a.class}</span>
                    )}
                  </Td>
                  <Td>
                    <span className="font-medium">{a.title}</span>
                    {a.position && (
                      <span className="block text-[13px] text-muted-foreground">{a.position}</span>
                    )}
                  </Td>
                  <Td>
                    {a.level ? (
                      <Badge tone={LEVEL_TONE[a.level] ?? 'neutral'}>{a.level}</Badge>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>{a.media_count}</Td>
                  <Td>
                    {a.consent_confirmed_at ? (
                      <Badge tone="success">recorded</Badge>
                    ) : (
                      <Badge tone="warning">not recorded</Badge>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={a.is_published ? 'success' : 'neutral'}>
                      {a.is_published ? 'live' : 'draft'}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" onClick={() => openEntry(a.id)}>
                        Open
                      </Button>
                      {mayPublish &&
                        (a.is_published ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => unpublish.mutate(a.id)}
                          >
                            Withdraw
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={!a.consent_confirmed_at}
                            title={
                              a.consent_confirmed_at
                                ? undefined
                                : "Record the family's confirmation first"
                            }
                            onClick={() => publish.mutate(a.id)}
                          >
                            Publish
                          </Button>
                        ))}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <FormNotice error={publish.error ?? unpublish.error} />
        </Card>

        {selected && detail.data && (
          <Card>
            <CardHeader
              title={detail.data.title}
              description={`${detail.data.student}${detail.data.class ? ` · ${detail.data.class}` : ''}`}
              action={
                <div className="flex gap-2">
                  {mayEdit && (
                    <ConfirmButton
                      confirmLabel="Delete"
                      question="This removes the record and its pictures."
                      tone="danger"
                      onConfirm={() => remove.mutate(detail.data!.id)}
                    >
                      Delete
                    </ConfirmButton>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => openEntry(null)}>
                    Close
                  </Button>
                </div>
              }
            />
            <div className="space-y-5 p-5">
              {detail.data.showcase_note && (
                <p className="text-[14px] leading-relaxed">{detail.data.showcase_note}</p>
              )}

              <div className="rounded-md border p-4">
                <h4 className="text-[14px] font-semibold">Permission to publish</h4>
                {detail.data.consent_confirmed_at ? (
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Recorded by {detail.data.consent_confirmed_by ?? 'a member of staff'} on{' '}
                    {formatDate(detail.data.consent_confirmed_at)} —{' '}
                    {CONSENT_BASES.find((b) => b.value === detail.data!.consent_basis)?.label ??
                      detail.data.consent_basis}
                    .
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      This school holds no photograph-consent register, so permission is
                      confirmed here, against this achievement. Say where the family&apos;s
                      agreement came from — it is what has to be produced if they object.
                    </p>
                    {mayEdit && (
                      <div className="mt-3 flex flex-wrap items-end gap-3">
                        <Field label="Basis">
                          <Select value={consent} onChange={setConsent} options={CONSENT_BASES} />
                        </Field>
                        <Button
                          size="sm"
                          disabled={recordConsent.isPending}
                          onClick={() => recordConsent.mutate()}
                        >
                          Record confirmation
                        </Button>
                      </div>
                    )}
                    <FormNotice error={recordConsent.error} />
                  </>
                )}
              </div>

              <div>
                <h4 className="mb-2 text-[14px] font-semibold">Pictures</h4>
                {(detail.data.media?.length ?? 0) === 0 ? (
                  <p className="text-[13px] text-muted-foreground">None attached.</p>
                ) : (
                  <ul className="space-y-2">
                    {detail.data.media?.map((m) => (
                      <li
                        key={m.id}
                        className="flex flex-wrap items-center justify-between gap-2 text-[14px]"
                      >
                        <span>
                          {m.file_name ?? m.external_url ?? (
                            <span className="text-destructive">file deleted</span>
                          )}
                          {m.caption && (
                            <span className="ml-2 text-[13px] text-muted-foreground">
                              {m.caption}
                            </span>
                          )}
                        </span>
                        {mayEdit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => removeMedia.mutate(m.id)}
                          >
                            Remove
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {mayEdit && (
                  <div className="mt-3 space-y-3">
                    <FormGrid>
                      <Field
                        label="Picture link"
                        hint="Object storage is not configured on this deployment, so uploads answer 503 and a link is the working route."
                      >
                        <Input
                          value={media.external_url}
                          onChange={(v) => setMedia({ ...media, external_url: v })}
                          placeholder="https://…"
                        />
                      </Field>
                      <Field label="Caption">
                        <Input
                          value={media.caption}
                          onChange={(v) => setMedia({ ...media, caption: v })}
                        />
                      </Field>
                    </FormGrid>
                    <Button
                      size="sm"
                      disabled={!media.external_url.trim() || addMedia.isPending}
                      onClick={() => addMedia.mutate()}
                    >
                      Attach
                    </Button>
                    <FormNotice error={addMedia.error} />
                  </div>
                )}
              </div>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
