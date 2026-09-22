import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Copy, Plus, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader,
  Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Checkbox, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { SearchBox } from '@/components/rows'

/* Cross-institution board members, minted from the vendor console.

   A board member oversees several schools at once — a trust's finance
   committee, say — and reads each in turn through the school switcher in the
   header. They are not a platform role: an ordinary school user with a home
   institution plus a board_member grant in every school they oversee. This
   screen is where those grants are made and dropped.

   It mirrors the Support Team screen. The one-time password is shown once, on
   the handover panel, and stored only as a hash — and only when this call
   actually creates a new user; adding schools to someone who already has an
   account changes no password. */

interface School {
  id: string
  name: string
}
interface BoardMember {
  id: string
  full_name: string
  email?: string
  phone?: string
  status: string
  schools: School[]
}
interface Institution {
  id: string
  name: string
}
interface Handover {
  full_name: string
  sign_in_as?: string
  temporary_password?: string
  created: boolean
  schools: number
  note: string
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  invited: 'warning',
  suspended: 'danger',
}

export default function BoardMembers() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [handover, setHandover] = useState<Handover | null>(null)

  const members = useQuery({
    queryKey: ['board-members'],
    queryFn: () => api.get<List<BoardMember>>('/api/v1/seller/board-members'),
  })

  const remove = useMutation({
    mutationFn: ({ userID, instID }: { userID: string; instID: string }) =>
      api.del(`/api/v1/seller/board-members/${userID}/institutions/${instID}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board-members'] }),
  })

  const rows = members.data?.items ?? []

  if (members.isLoading) return <SkeletonTable columns={4} />
  if (members.error) return <ErrorState error={members.error} />

  return (
    <>
      <PageHead
        eyebrow="Support"
        title="Board members"
        description={
          'People who oversee several schools at once — a trust’s committee, a group '
          + 'director. Each holds an ordinary account in every school they oversee and switches '
          + 'between them from the header. Assign the schools here.'
        }
        actions={
          <Button
            onClick={() => {
              setHandover(null)
              setCreating((c) => !c)
            }}
          >
            {creating ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {creating ? 'Cancel' : 'Add board member'}
          </Button>
        }
      />
      <PageBody>
        {handover && <HandoverCard h={handover} onClose={() => setHandover(null)} />}

        {creating && (
          <CreateForm
            onDone={(h) => {
              setCreating(false)
              setHandover(h)
              qc.invalidateQueries({ queryKey: ['board-members'] })
            }}
            onCancel={() => setCreating(false)}
          />
        )}

        <Card>
          <CardHeader
            title="Board members"
            description={`${rows.length} overseeing schools across the platform — remove a school to drop that membership.`}
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No board members yet"
              body="Add one to give a trust director read-across access to the schools they oversee."
            />
          ) : (
            <Table head={['Name', 'Signs in as', 'Status', 'Oversees']}>
              {rows.map((m) => (
                <tr key={m.id}>
                  <Td className="whitespace-nowrap font-medium">{m.full_name}</Td>
                  <Td className="whitespace-nowrap font-mono text-[13px]">
                    {m.email ?? m.phone ?? '—'}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{m.status}</Badge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {m.schools.map((s) => (
                        <span
                          key={s.id}
                          className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[12px]"
                        >
                          {s.name}
                          <ConfirmButton
                            label={`Remove ${m.full_name} from ${s.name}`}
                            question={`Drop ${m.full_name}’s access to ${s.name}? Their home and other schools are untouched.`}
                            confirmLabel="Remove"
                            variant="ghost"
                            size="sm"
                            disabled={remove.isPending}
                            onConfirm={() => remove.mutate({ userID: m.id, instID: s.id })}
                          >
                            <X className="h-3 w-3" />
                          </ConfirmButton>
                        </span>
                      ))}
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

/**
 * The handover: the one moment the password exists in readable form. Shown only
 * when this call created a new account; adding schools to someone who already
 * had one changes no password, and the panel says so instead.
 */
function HandoverCard({ h, onClose }: { h: Handover; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  if (!h.created || !h.temporary_password) {
    return (
      <Card className="border-primary/40">
        <CardHeader
          title={h.full_name}
          description={h.note}
          action={
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <div className="px-5 py-4 text-[13px] text-muted-foreground">
          Now overseeing {h.schools} {h.schools === 1 ? 'school' : 'schools'}.
        </div>
      </Card>
    )
  }

  const text = `${h.full_name}\nSign in as: ${h.sign_in_as ?? ''}\nTemporary password: ${h.temporary_password}`

  return (
    <Card className="border-primary/40">
      <CardHeader
        title={`Credentials for ${h.full_name}`}
        description={h.note}
        action={
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <div className="px-5 py-5">
        <FormGrid>
          <Field label="Hand to">
            <p className="text-[14px] font-medium">{h.full_name}</p>
          </Field>
          <Field label="They sign in as">
            <p className="font-mono text-[15px]">{h.sign_in_as}</p>
          </Field>
        </FormGrid>
        <div className="mt-4">
          <p className="mb-1.5 text-[13px] font-medium text-secondary-foreground">
            One-time password
          </p>
          <p className="rounded-md border bg-muted px-3 py-2.5 font-mono text-[18px] tracking-wider">
            {h.temporary_password}
          </p>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              navigator.clipboard?.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Card>
  )
}

function CreateForm({
  onDone,
  onCancel,
}: {
  onDone: (h: Handover) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '' })
  const [picked, setPicked] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v })

  // The school list, reused from the platform picker every seller screen uses.
  const institutions = useQuery({
    queryKey: ['institutions', 'all'],
    queryFn: () => api.get<List<Institution>>('/api/v1/admin/institutions'),
  })
  const all = institutions.data?.items ?? []
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? all.filter((i) => i.name.toLowerCase().includes(q)) : all
  }, [all, filter])

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  const create = useMutation({
    mutationFn: () =>
      api.post<Handover>('/api/v1/seller/board-members', {
        full_name: f.full_name.trim(),
        email: f.email.trim() || undefined,
        phone: f.phone.trim() || undefined,
        institution_ids: picked,
      }),
    onSuccess: onDone,
  })

  const ready =
    f.full_name.trim() !== ''
    && (f.email.trim() !== '' || f.phone.trim() !== '')
    && picked.length > 0

  return (
    <Card>
      <CardHeader
        title="Add a board member"
        description={
          'They get an ordinary account holding the board_member role in each school picked. '
          + 'If they are new, a one-time password is shown once; if they already have an account, '
          + 'it just gains the schools.'
        }
      />
      <form
        className="px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <FormGrid>
          <Field label="Full name" required wide>
            <Input
              value={f.full_name}
              onChange={(x) => set('full_name', x)}
              placeholder="Priya Nair"
            />
          </Field>
          <Field label="Email" hint="What they sign in with. Email or phone is required.">
            <Input type="email" value={f.email} onChange={(x) => set('email', x)} />
          </Field>
          <Field label="Phone">
            <Input value={f.phone} onChange={(x) => set('phone', x)} />
          </Field>
        </FormGrid>

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-secondary-foreground">
              Schools they oversee
              {picked.length > 0 && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  ({picked.length} selected)
                </span>
              )}
            </p>
          </div>
          {institutions.isLoading ? (
            <p className="text-[13px] text-muted-foreground">Loading schools{'…'}</p>
          ) : institutions.error ? (
            <ErrorState error={institutions.error} />
          ) : (
            <>
              {all.length > 8 && (
                <div className="mb-2">
                  <SearchBox value={filter} onChange={setFilter} placeholder="Filter schools" className="w-full" />
                </div>
              )}
              <div className="max-h-64 overflow-y-auto rounded-md border">
                {shown.length === 0 ? (
                  <p className="px-3 py-3 text-[13px] text-muted-foreground">
                    No schools match that.
                  </p>
                ) : (
                  shown.map((i) => (
                    <label
                      key={i.id}
                      className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-surface-hover"
                    >
                      <Checkbox
                        checked={picked.includes(i.id)}
                        onChange={() => toggle(i.id)}
                        label=""
                        srLabel={i.name}
                      />
                      <span className="inline-flex items-center gap-1.5 text-[13.5px]">
                        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {i.name}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <FormNotice error={create.error} />
        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={create.isPending || !ready}>
            {create.isPending ? 'Adding…' : 'Add and show password'}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
