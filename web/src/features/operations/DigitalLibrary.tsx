import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpen, ExternalLink, Eye, Library, Link2, Newspaper, Plus, Search, Trash2, X,
} from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Checkbox, Field, FormGrid, FormNotice,
  Input, Select, Textarea, Loading, ErrorState, UnavailableState,
} from '@/components/ui'
import { useCan } from '@/lib/session'

/* institution_admin.library.digital_e_book_journal_integration

   The catalogue entry promises single sign-on to EBSCO and JSTOR. This
   deployment holds neither subscription, so this screen does not draw a
   working integration: the providers tab records what a school has, shows it
   as unconnected, and opening a title behind one says so in a sentence rather
   than sending the reader to a dead link.

   What it does deliver is the part that works without a subscription — the
   school's own digital holdings beside the physical ones, per-class and
   per-role visibility so a Class 2 pupil is not shown a research database, and
   lending for the e-books licensed a single reader at a time.

   Lending here is the physical desk's, not a second one. A single-copy e-book
   carries a shadow row in the book catalogue; "Borrow" places an ordinary hold
   on it and the existing library screen makes it ready, issues it and takes it
   back. This screen therefore has no due-date arithmetic and no fine anywhere
   in it, which is the point — two lending desks that disagree about who has
   what is the failure that reuse avoids.
*/

interface Holding {
  id: string
  kind: 'ebook' | 'journal' | 'database'
  title: string
  author?: string
  publisher?: string
  identifier?: string
  language?: string
  description?: string
  access_model: 'open' | 'subscription' | 'single_copy_loan'
  has_file: boolean
  file_name?: string
  subject_tags: string[]
  provider_id?: string
  provider_name?: string
  provider_status?: string
  campus_id?: string
  loan_days: number
  is_active: boolean
  library_title_id?: string
  on_loan: boolean
  due_on?: string
  readers_waiting: number
  available_to_me: boolean
  visible_to_classes: string[]
  visible_to_roles: string[]
  updated_at: string
}
interface Provider {
  id: string
  kind: string
  name: string
  base_url?: string
  has_credentials: boolean
  status: string
  notes?: string
  holdings: number
}
interface Named { id: string; name: string }
interface Audiences { classes: Named[]; roles: Named[] }
interface AccessGrant {
  holding_id: string
  title: string
  url?: string
  file_id?: string
  due_on?: string
  note?: string
}

const KIND_LABEL: Record<string, string> = {
  ebook: 'E-book',
  journal: 'Journal',
  database: 'Database',
}
const ACCESS_LABEL: Record<string, string> = {
  open: 'Open access',
  subscription: 'Subscription',
  single_copy_loan: 'One reader at a time',
}

const TABS = [
  ['catalogue', 'Catalogue', Library],
  ['providers', 'Subscriptions', Link2],
] as const

export default function DigitalLibrary() {
  const can = useCan()
  const librarian = can('operations.library.write')
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('catalogue')
  const [manage, setManage] = useState(false)
  const [kind, setKind] = useState('')
  const [q, setQ] = useState('')

  const params = new URLSearchParams()
  if (manage && librarian) params.set('manage', '1')
  if (kind) params.set('kind', kind)
  if (q.trim()) params.set('q', q.trim())

  const holdings = useQuery({
    queryKey: ['digital-library', 'catalogue', params.toString()],
    queryFn: () =>
      api.get<List<Holding>>(`/api/v1/ops/digital-library/catalogue?${params.toString()}`),
  })

  if (holdings.isLoading) return <Loading label="Opening the digital shelves…" />
  /* A failed query is an error, never "nothing here". Telling a librarian the
     catalogue is empty when the server refused is how titles get entered
     twice. */
  if (holdings.error) return <ErrorState error={holdings.error} />

  const items = holdings.data?.items ?? []
  const lendable = items.filter((h) => h.access_model === 'single_copy_loan')

  return (
    <>
      <PageHead
        eyebrow="Library"
        title="E-books, journals and databases"
        description="The school's digital holdings beside the physical ones. Who may see each title is set here; the ones lent a single reader at a time go through the library's own hold queue."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Digital titles" value={items.length} icon={BookOpen} />
          <Stat label="Journals" value={items.filter((h) => h.kind === 'journal').length} icon={Newspaper} />
          <Stat label="Lent one at a time" value={lendable.length} />
          <Stat
            label="Out on loan"
            value={lendable.filter((h) => h.on_loan).length}
            hint={lendable.some((h) => h.readers_waiting > 0) ? 'Readers are queuing' : undefined}
          />
        </CellGrid>

        <div className="flex gap-1 border-b">
          {TABS.map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-[14px] transition-colors ' +
                (tab === k
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {tab === 'catalogue' ? (
          <Catalogue
            items={items}
            librarian={librarian}
            manage={manage}
            onManage={setManage}
            kind={kind}
            onKind={setKind}
            q={q}
            onQ={setQ}
          />
        ) : (
          <Providers librarian={librarian} />
        )}
      </PageBody>
    </>
  )
}

// --- catalogue ---------------------------------------------------------------

function Catalogue({
  items,
  librarian,
  manage,
  onManage,
  kind,
  onKind,
  q,
  onQ,
}: {
  items: Holding[]
  librarian: boolean
  manage: boolean
  onManage: (v: boolean) => void
  kind: string
  onKind: (v: string) => void
  q: string
  onQ: (v: string) => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Holding | null>(null)
  const [adding, setAdding] = useState(false)
  const [visibilityFor, setVisibilityFor] = useState<Holding | null>(null)
  const [grant, setGrant] = useState<AccessGrant | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['digital-library'] })

  const open = useMutation({
    mutationFn: (id: string) =>
      api.get<AccessGrant>(`/api/v1/ops/digital-library/holdings/${id}/access`),
    onSuccess: (g) => {
      setGrant(g)
      // A link out opens in a new tab; a file the school holds is fetched
      // through the files endpoint, which is the only thing that can sign it.
      if (g.url) window.open(g.url, '_blank', 'noopener,noreferrer')
    },
  })
  const borrow = useMutation({
    mutationFn: (id: string) =>
      api.post<{ status: string }>(`/api/v1/ops/digital-library/holdings/${id}/borrow`, {}),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/ops/digital-library/holdings/${id}`),
    onSuccess: refresh,
  })

  return (
    <div className="space-y-7">
      <Card>
        <CardHeader
          title="Digital holdings"
          description={
            manage
              ? 'Everything you may catalogue, withdrawn titles included.'
              : 'What you can open. A title you cannot see here is one the librarian has not shared with your class or role.'
          }
          action={
            librarian && (
              <>
                <Checkbox
                  label="Manage"
                  checked={manage}
                  onChange={onManage}
                  srLabel="Show every holding, including withdrawn ones"
                />
                <Button size="sm" onClick={() => { setAdding(true); setEditing(null) }}>
                  <Plus className="h-3.5 w-3.5" />
                  Add a title
                </Button>
              </>
            )
          }
        />
        <div className="flex flex-wrap items-end gap-3 border-b p-5">
          <div className="min-w-[180px]">
            <Field label="Kind">
              <Select
                value={kind}
                onChange={onKind}
                options={[
                  { value: 'ebook', label: 'E-books' },
                  { value: 'journal', label: 'Journals' },
                  { value: 'database', label: 'Databases' },
                ]}
                placeholder="Everything"
              />
            </Field>
          </div>
          <div className="min-w-[220px] flex-1">
            <Field label="Search">
              <Input value={q} onChange={onQ} placeholder="Title or author" />
            </Field>
          </div>
          <Search className="mb-2.5 h-4 w-4 text-muted-foreground" />
        </div>
        <Table
          head={['Title', 'Kind', 'Access', 'Subjects', manage ? 'Visible to' : 'Status', '']}
          empty={items.length === 0}
          emptyLabel={
            manage
              ? 'Nothing catalogued yet. Add a title and it appears here.'
              : 'Nothing here for you yet. The librarian shares titles with a class or a role.'
          }
        >
          {items.map((h) => (
            <tr key={h.id}>
              <Td>
                <span className="font-medium">{h.title}</span>
                <span className="block text-[13px] text-muted-foreground">
                  {[h.author, h.publisher, h.identifier].filter(Boolean).join(' · ') || '—'}
                </span>
              </Td>
              <Td>{KIND_LABEL[h.kind] ?? h.kind}</Td>
              <Td>
                {ACCESS_LABEL[h.access_model] ?? h.access_model}
                {h.provider_name && (
                  <span className="block text-[13px] text-muted-foreground">
                    via {h.provider_name}
                    {h.provider_status !== 'live' && ' (not connected)'}
                  </span>
                )}
              </Td>
              <Td>
                {h.subject_tags.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {h.subject_tags.map((t) => (
                      <Badge key={t} tone="neutral" solid>
                        {t}
                      </Badge>
                    ))}
                  </span>
                )}
              </Td>
              <Td>
                {manage ? (
                  <span className="text-[13px] text-muted-foreground">
                    {h.visible_to_classes.length === 0 && h.visible_to_roles.length === 0
                      ? 'Everyone'
                      : [...h.visible_to_classes, ...h.visible_to_roles].join(', ')}
                  </span>
                ) : (
                  <HoldingStatus holding={h} />
                )}
              </Td>
              <Td className="text-right">
                <span className="inline-flex flex-wrap justify-end gap-1.5">
                  {h.access_model === 'single_copy_loan' && !h.available_to_me ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={borrow.isPending}
                      onClick={() => borrow.mutate(h.id)}
                    >
                      {h.on_loan ? 'Join the queue' : 'Borrow'}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={open.isPending}
                      onClick={() => open.mutate(h.id)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open
                    </Button>
                  )}
                  {librarian && manage && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setVisibilityFor(h)}>
                        <Eye className="h-3.5 w-3.5" />
                        Who sees it
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditing(h); setAdding(false) }}
                      >
                        Edit
                      </Button>
                      <ConfirmButton
                        confirmLabel="Delete"
                        question="Remove this title from the digital catalogue?"
                        tone="danger"
                        onConfirm={() => remove.mutate(h.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </ConfirmButton>
                    </>
                  )}
                </span>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {(open.error || borrow.error || remove.error) && (
        <FormNotice error={open.error || borrow.error || remove.error} />
      )}

      {grant && !grant.url && (
        <Card>
          <CardHeader
            title={grant.title}
            action={
              <Button size="sm" variant="ghost" onClick={() => setGrant(null)}>
                <X className="h-3.5 w-3.5" />
                Close
              </Button>
            }
          />
          <div className="p-5">
            <p className="text-[14px]">
              This title is a file the school holds. Reference{' '}
              <span className="font-mono text-[12.5px]">{grant.file_id}</span>.
            </p>
            {grant.note && <p className="mt-2 text-[13px] text-muted-foreground">{grant.note}</p>}
          </div>
        </Card>
      )}

      {(adding || editing) && (
        /* key resets the form when the record being edited changes. Without
           it, opening one title after another leaves the previous title's
           fields in the boxes and saves them over the new record. */
        <HoldingForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onClose={() => { setEditing(null); setAdding(false) }}
        />
      )}

      {visibilityFor && (
        <VisibilityForm
          key={visibilityFor.id}
          holding={visibilityFor}
          onClose={() => setVisibilityFor(null)}
        />
      )}
    </div>
  )
}

function HoldingStatus({ holding }: { holding: Holding }) {
  if (holding.access_model !== 'single_copy_loan') {
    return <Badge tone="success">Open to you</Badge>
  }
  if (holding.available_to_me) {
    return <Badge tone="success">Yours until {holding.due_on ?? '—'}</Badge>
  }
  if (holding.on_loan) {
    return (
      <Badge tone="warning">
        Out until {holding.due_on ?? '—'}
        {holding.readers_waiting > 0 && ` · ${holding.readers_waiting} waiting`}
      </Badge>
    )
  }
  return <Badge tone="neutral">On the shelf</Badge>
}

// --- cataloguing -------------------------------------------------------------

function HoldingForm({ editing, onClose }: { editing: Holding | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState(editing?.kind ?? 'ebook')
  const [title, setTitle] = useState(editing?.title ?? '')
  const [author, setAuthor] = useState(editing?.author ?? '')
  const [publisher, setPublisher] = useState(editing?.publisher ?? '')
  const [identifier, setIdentifier] = useState(editing?.identifier ?? '')
  const [language, setLanguage] = useState(editing?.language ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [accessModel, setAccessModel] = useState(editing?.access_model ?? 'open')
  const [externalURL, setExternalURL] = useState('')
  const [fileID, setFileID] = useState('')
  const [tags, setTags] = useState((editing?.subject_tags ?? []).join(', '))
  /* Held as a string. An emptied box must mean "use the default", not zero —
     a loan of 0 days is a title that is overdue the moment it is issued. */
  const [loanDays, setLoanDays] = useState(editing ? String(editing.loan_days) : '')
  const [providerID, setProviderID] = useState(editing?.provider_id ?? '')
  const [active, setActive] = useState(editing?.is_active ?? true)

  const providers = useQuery({
    queryKey: ['digital-library', 'providers'],
    queryFn: () => api.get<List<Provider>>('/api/v1/ops/digital-library/providers'),
  })

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/ops/digital-library/holdings', {
        id: editing?.id,
        kind,
        title,
        author,
        publisher,
        identifier,
        language,
        description,
        access_model: accessModel,
        provider_id: providerID,
        external_url: externalURL,
        file_id: fileID,
        subject_tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        is_active: active,
        ...(loanDays.trim() === '' ? {} : { loan_days: Number(loanDays) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['digital-library'] })
      onClose()
    },
  })

  return (
    <Card>
      <CardHeader
        title={editing ? `Edit “${editing.title}”` : 'Add a digital title'}
        description="A link out, or a file the school holds. Object storage is unconfigured on this deployment, so a link is the one that works today."
        action={
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
        }
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Title" required>
            <Input value={title} onChange={setTitle} placeholder="A Brief History of Time" />
          </Field>
          <Field label="Kind" required>
            <Select
              value={kind}
              onChange={(v) => setKind(v as Holding['kind'])}
              options={[
                { value: 'ebook', label: 'E-book' },
                { value: 'journal', label: 'Journal' },
                { value: 'database', label: 'Database' },
              ]}
            />
          </Field>
          <Field label="Author">
            <Input value={author} onChange={setAuthor} />
          </Field>
          <Field label="Publisher">
            <Input value={publisher} onChange={setPublisher} />
          </Field>
          <Field label="ISBN or ISSN" hint="ISBN for an e-book, ISSN for a journal.">
            <Input value={identifier} onChange={setIdentifier} />
          </Field>
          <Field label="Language">
            <Input value={language} onChange={setLanguage} placeholder="English" />
          </Field>
          <Field
            label="Access"
            required
            hint={
              accessModel === 'single_copy_loan'
                ? 'Borrowed like a physical book, through the library’s own hold queue.'
                : undefined
            }
          >
            <Select
              value={accessModel}
              onChange={(v) => setAccessModel(v as Holding['access_model'])}
              options={[
                { value: 'open', label: 'Open access' },
                { value: 'subscription', label: 'Subscription' },
                ...(kind === 'database'
                  ? []
                  : [{ value: 'single_copy_loan', label: 'One reader at a time' }]),
              ]}
            />
          </Field>
          {accessModel === 'single_copy_loan' && (
            <Field label="Loan length (days)" hint="Blank uses fourteen.">
              <Input value={loanDays} onChange={setLoanDays} type="number" placeholder="14" />
            </Field>
          )}
          <Field label="Link" hint="Starts with https://" wide>
            <Input
              value={externalURL}
              onChange={setExternalURL}
              placeholder={editing ? 'Leave blank to keep the existing link' : 'https://…'}
            />
          </Field>
          <Field
            label="Uploaded file id"
            hint="Only if the school holds the file itself. Uploads answer 503 on this deployment, so a link is usually the answer."
            wide
          >
            <Input value={fileID} onChange={setFileID} srLabel="Uploaded file id" />
          </Field>
          <Field label="Subjects" hint="Comma separated: history, physics" wide>
            <Input value={tags} onChange={setTags} placeholder="history, civics" />
          </Field>
          <Field label="Subscription" hint="Leave blank for a title the school holds itself.">
            <Select
              value={providerID}
              onChange={setProviderID}
              options={(providers.data?.items ?? []).map((p) => ({
                value: p.id,
                label: `${p.name}${p.status === 'live' ? '' : ' (not connected)'}`,
              }))}
              placeholder="None"
            />
          </Field>
          <Field label="Description" wide>
            <Textarea value={description} onChange={setDescription} />
          </Field>
        </FormGrid>

        <Checkbox
          label="In the catalogue"
          hint="Withdraw a title instead of deleting it when readers still have it in a reading list."
          checked={active}
          onChange={setActive}
        />

        <FormNotice error={save.error} />

        <div className="flex gap-3">
          <Button disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>
            {editing ? 'Save changes' : 'Add to catalogue'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

// --- visibility --------------------------------------------------------------

function VisibilityForm({ holding, onClose }: { holding: Holding; onClose: () => void }) {
  const qc = useQueryClient()
  const audiences = useQuery({
    queryKey: ['digital-library', 'audiences'],
    queryFn: () => api.get<Audiences>('/api/v1/ops/digital-library/audiences'),
  })
  const [classIDs, setClassIDs] = useState<string[]>([])
  const [roleKeys, setRoleKeys] = useState<string[]>(holding.visible_to_roles)
  const [seeded, setSeeded] = useState(false)

  // The holding carries class NAMES for display; the ids come with the
  // audience list, so the ticks are matched once that has arrived.
  if (!seeded && audiences.data) {
    setSeeded(true)
    setClassIDs(
      audiences.data.classes.filter((c) => holding.visible_to_classes.includes(c.name)).map((c) => c.id),
    )
  }

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/ops/digital-library/holdings/${holding.id}/visibility`, {
        class_ids: classIDs,
        role_keys: roleKeys,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['digital-library'] })
      onClose()
    },
  })

  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key])

  return (
    <Card>
      <CardHeader
        title={`Who sees “${holding.title}”`}
        description="Tick nothing and everyone sees it. Tick a class or a role and only they do — which is how a research database reaches the staff room and not Class 2."
        action={
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
        }
      />
      <div className="space-y-5 p-5">
        {audiences.isLoading ? (
          <Loading label="Loading classes and roles…" />
        ) : audiences.error ? (
          <ErrorState error={audiences.error} />
        ) : (
          <>
            <div>
              <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Classes</p>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {(audiences.data?.classes ?? []).map((c) => (
                  <Checkbox
                    key={c.id}
                    label={c.name}
                    checked={classIDs.includes(c.id)}
                    onChange={() => toggle(classIDs, setClassIDs, c.id)}
                  />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Roles</p>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {(audiences.data?.roles ?? []).map((r) => (
                  <Checkbox
                    key={r.id}
                    label={r.name}
                    checked={roleKeys.includes(r.id)}
                    onChange={() => toggle(roleKeys, setRoleKeys, r.id)}
                  />
                ))}
              </div>
            </div>

            {classIDs.length === 0 && roleKeys.length === 0 && (
              <p className="text-[13px] text-muted-foreground">
                Nothing ticked: every reader who can reach this campus will see this title.
              </p>
            )}

            <FormNotice error={save.error} />
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              Save visibility
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}

// --- providers ---------------------------------------------------------------

function Providers({ librarian }: { librarian: boolean }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const providers = useQuery({
    queryKey: ['digital-library', 'providers'],
    queryFn: () => api.get<List<Provider>>('/api/v1/ops/digital-library/providers'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/ops/digital-library/providers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digital-library'] }),
  })

  if (providers.isLoading) return <Loading label="Loading subscriptions…" />
  if (providers.error) return <ErrorState error={providers.error} />
  const items = providers.data?.items ?? []

  return (
    <div className="space-y-7">
      <Card>
        <div className="p-5">
          <UnavailableState
            title="No provider is connected on this deployment."
            body="EBSCO, JSTOR and ProQuest each need a paid subscription and a signed link resolver. The seam is built — record what the school holds below and the titles behind it are catalogued and visible — but opening one answers honestly rather than sending a reader to a dead link. Connecting a provider is a code change, not a setting."
            technical={[
              { label: 'Endpoint', value: 'GET /api/v1/ops/digital-library/holdings/{id}/access' },
              { label: 'Answers', value: '503 provider_unavailable' },
              { label: 'Resolver', value: 'resolveDigitalProvider, internal/api/digital_library.go' },
            ]}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Subscriptions the school holds"
          description="A record, not a connection. No password is stored here — there is nothing yet that could use one."
          action={
            librarian && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="h-3.5 w-3.5" />
                Record a subscription
              </Button>
            )
          }
        />
        <Table
          head={['Provider', 'Kind', 'Base URL', { label: 'Titles', align: 'right' }, 'Status', '']}
          empty={items.length === 0}
          emptyLabel="None recorded."
        >
          {items.map((p) => (
            <tr key={p.id}>
              <Td>
                <span className="font-medium">{p.name}</span>
                {p.notes && (
                  <span className="block text-[13px] text-muted-foreground">{p.notes}</span>
                )}
              </Td>
              <Td>{p.kind}</Td>
              <Td>
                <span className="break-all text-[13px] text-muted-foreground">
                  {p.base_url ?? '—'}
                </span>
              </Td>
              <Td className="text-right tabular-nums">{p.holdings}</Td>
              <Td>
                {p.status === 'live' ? (
                  <Badge tone="success">Connected</Badge>
                ) : (
                  <Badge tone="warning">
                    Not connected{p.has_credentials && ' · credentials held offline'}
                  </Badge>
                )}
              </Td>
              <Td className="text-right">
                {librarian && (
                  <ConfirmButton
                    confirmLabel="Remove"
                    question="Remove this subscription? Its titles stay in the catalogue."
                    tone="danger"
                    onConfirm={() => remove.mutate(p.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </ConfirmButton>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {remove.error && <FormNotice error={remove.error} />}
      {adding && <ProviderForm onClose={() => setAdding(false)} />}
    </div>
  )
}

function ProviderForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState('ebsco')
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [hasCredentials, setHasCredentials] = useState(false)
  const [notes, setNotes] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/ops/digital-library/providers', {
        kind,
        name,
        base_url: baseURL,
        has_credentials: hasCredentials,
        notes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['digital-library'] })
      onClose()
    },
  })

  return (
    <Card>
      <CardHeader
        title="Record a subscription"
        action={
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
        }
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Provider" required>
            <Select
              value={kind}
              onChange={setKind}
              options={[
                { value: 'ebsco', label: 'EBSCO' },
                { value: 'jstor', label: 'JSTOR' },
                { value: 'proquest', label: 'ProQuest' },
                { value: 'other', label: 'Other' },
              ]}
            />
          </Field>
          <Field label="Name" required hint="What the school calls it.">
            <Input value={name} onChange={setName} placeholder="EBSCO Academic Search" />
          </Field>
          <Field label="Base URL" wide hint="Where a link resolver would send a reader.">
            <Input value={baseURL} onChange={setBaseURL} placeholder="https://search.ebscohost.com" />
          </Field>
          <Field label="Notes" wide>
            <Input value={notes} onChange={setNotes} placeholder="Renews in March; contact the district office" />
          </Field>
        </FormGrid>
        <Checkbox
          label="The librarian holds the login"
          hint="Recorded as a fact only. The password is not stored here — nothing yet could use it, and holding a secret to do nothing with is worse than not holding it."
          checked={hasCredentials}
          onChange={setHasCredentials}
        />
        <FormNotice error={save.error} />
        <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
          Record it
        </Button>
      </div>
    </Card>
  )
}
