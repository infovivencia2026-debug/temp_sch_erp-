import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api, ApiError, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Dialog, Field, FormGrid, FormNotice,
  Input, Select, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useOptimisticMutation } from '@/lib/optimistic'

/* The vendor's own people: everyone who signs in to this console.

   This began as one command made into a screen: create a support_admin, and
   nothing more. A team of real people needs the rest of it. A second seller
   administrator, a support engineer who has left, a forgotten password and a
   change of role were all SQL on the platform database.

   Two roles are offered. Support is read-only by construction: it sees that
   a school exists, that its jobs run and what its audit trail says, and no
   child's records. Seller administrator runs this console. Super admin is
   listed when there is one and is never created or changed from here.

   The server holds three rules whatever is pressed: nobody changes their
   own access, a super admin is only touched by a super admin, and the last
   active seller administrator cannot be suspended or demoted. A password is
   shown once, on the handover panel, and stored only as a hash. */

interface Staff {
  id: string
  full_name: string
  email?: string
  phone?: string
  status: string
  roles: string[]
  you: boolean
  last_login_at?: string
  created_at: string
}
interface Handover {
  full_name: string
  sign_in_as: string
  temporary_password: string
  note: string
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  invited: 'warning',
  suspended: 'danger',
}
const ROLE_NAME: Record<string, string> = {
  super_admin: 'Super admin',
  seller_admin: 'Seller administrator',
  support_admin: 'Support',
}
const ROLE_OPTIONS = [
  { value: 'support_admin', label: 'Support', about: 'Answers schools’ tickets. Looks across schools, changes nothing, and sees no child’s records.' },
  { value: 'seller_admin', label: 'Seller administrator', about: 'Runs this console: schools, plans, billing and this team.' },
]
const STATUS_NAME: Record<string, string> = { active: 'Active', suspended: 'Suspended', invited: 'Invited' }
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')

export default function SupportTeam() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [handover, setHandover] = useState<Handover | null>(null)
  const [suspending, setSuspending] = useState<Staff | null>(null)

  /* A backend that predates the staff routes (the web app and the server
     deploy separately) answers 404 or 501 for them. The screen then falls
     back to what it could always do, list and create support accounts, and
     says so, rather than failing whole. */
  const staff = useQuery({
    queryKey: ['platform-staff'],
    queryFn: async (): Promise<List<Staff> & { legacy?: boolean }> => {
      try {
        return await api.get<List<Staff>>('/api/v1/seller/staff')
      } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 501)) throw e
        const old = await api.get<List<Omit<Staff, 'roles' | 'you'>>>('/api/v1/seller/support-accounts')
        return { ...old, items: old.items.map((a) => ({ ...a, roles: ['support_admin'], you: true })), legacy: true }
      }
    },
  })
  const legacy = staff.data?.legacy === true
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-staff'] })

  /* Shown at once, settled by the server (lib/optimistic): the row changes
     the moment the control is pressed, and if the server refuses -- the last
     seller administrator, your own account -- it is put back with the reason. */
  const patch = (id: string, change: Partial<Staff>) => (old: unknown) => {
    const l = old as List<Staff>
    return { ...l, items: l.items.map((a) => (a.id === id ? { ...a, ...change } : a)) }
  }
  const setStatus = useOptimisticMutation<{ id: string; status: string; reason?: string }>({
    mutationFn: (v) => api.post(`/api/v1/seller/staff/${v.id}/status`, { status: v.status, reason: v.reason }),
    queryKeys: [['platform-staff']],
    apply: (old, v) => patch(v.id, { status: v.status })(old),
    failure: "Couldn't change that account",
  })
  const setRole = useOptimisticMutation<{ id: string; role: string }>({
    mutationFn: (v) => api.post(`/api/v1/seller/staff/${v.id}/role`, { role: v.role }),
    queryKeys: [['platform-staff']],
    apply: (old, v) => patch(v.id, { roles: [v.role] })(old),
    failure: "Couldn't change the role",
  })
  const resetPassword = useMutation({
    mutationFn: (id: string) => api.post<Handover>(`/api/v1/seller/staff/${id}/password`, {}),
    onSuccess: (h) => { setCreating(false); setHandover(h) },
  })

  /* The three figures are the filters: pressing a part of one narrows the
     table to those people, pressing it again shows everyone. */
  const [focus, setFocus] = useState<{ by: string; key: string } | null>(null)
  const all = staff.data?.items ?? []
  const isAdmin = (a: Staff) => a.roles.some((r) => r !== 'support_admin')
  const weekAgo = Date.now() - 7 * 86_400_000
  const seen = (a: Staff) => (!a.last_login_at ? 'never' : new Date(a.last_login_at).getTime() >= weekAgo ? 'week' : 'earlier')
  const tests: Record<string, (a: Staff, k: string) => boolean> = {
    role: (a, k) => (k === 'seller_admin' ? isAdmin(a) : !isAdmin(a)),
    seen: (a, k) => seen(a) === k,
    status: (a, k) => (k === 'active' ? a.status === 'active' : a.status !== 'active'),
  }
  const rows = focus ? all.filter((a) => tests[focus.by](a, focus.key)) : all
  const pick = (by: string) => (key: string | null) => setFocus(key ? { by, key } : null)
  const on = (by: string) => (focus?.by === by ? focus.key : null)
  const active = all.filter((a) => a.status === 'active').length
  const admins = all.filter(isAdmin).length
  const recent = all.filter((a) => seen(a) === 'week').length
  const never = all.filter((a) => seen(a) === 'never').length

  if (staff.isLoading && !staff.data) return <SkeletonTable columns={6} />
  if (staff.error) return <ErrorState error={staff.error} />

  return (
    <>
      <PageHead
        eyebrow="Support"
        title="Team"
        description="Everyone who signs in to this console: seller administrators who run it, and support staff who can look across schools without seeing any child's records."
        actions={
          <Button
            onClick={() => {
              setHandover(null)
              setCreating(true)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add a person
          </Button>
        }
      />
      <PageBody>
        {handover && <HandoverCard h={handover} onClose={() => setHandover(null)} />}

        {creating && (
          <CreateForm
            legacy={legacy}
            onDone={(h) => {
              setCreating(false)
              setHandover(h)
              refresh()
            }}
            onCancel={() => setCreating(false)}
          />
        )}

        <FormNotice error={resetPassword.error} />
        {legacy && (
          <p className="rounded-md border bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
            The server has not been updated yet, so this shows support accounts only and cannot suspend, re-role or reset them.
          </p>
        )}

        {!legacy && all.length > 0 && (
          <CellGrid cols={3}>
            <Stat
              label="People"
              value={all.length}
              detail={`${admins} run the console and ${all.length - admins} answer support.`}
              parts={[
                { key: 'seller_admin', label: 'Seller administrators', value: admins, tone: 'primary' },
                { key: 'support_admin', label: 'Support', value: all.length - admins, tone: 'info' },
              ]}
              onPart={pick('role')}
              activePart={on('role')}
            />
            <Stat
              label="Signed in this week"
              value={recent}
              detail={never ? `${never} ${never === 1 ? 'person has' : 'people have'} never signed in: their one-time password may still be waiting to be handed over.` : 'Everyone has signed in at least once.'}
              parts={[
                { key: 'week', label: 'This week', value: recent, tone: 'success' },
                { key: 'earlier', label: 'Earlier', value: all.length - recent - never, tone: 'neutral' },
                { key: 'never', label: 'Never', value: never, tone: 'warning' },
              ]}
              onPart={pick('seen')}
              activePart={on('seen')}
            />
            <Stat
              label="Can sign in"
              value={`${active} of ${all.length}`}
              detail={all.length - active ? `${all.length - active} suspended. Suspended accounts keep their history and can be reactivated.` : 'Nobody is suspended.'}
              parts={[
                { key: 'active', label: 'Active', value: active, tone: 'success' },
                { key: 'suspended', label: 'Suspended', value: all.length - active, tone: 'danger' },
              ]}
              onPart={pick('status')}
              activePart={on('status')}
            />
          </CellGrid>
        )}

        {focus && (
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">Showing</span>
            <span className="rounded-full bg-primary/10 px-2.5 py-1 font-semibold text-primary">{rows.length} of {all.length}</span>
            <Button variant="ghost" size="sm" onClick={() => setFocus(null)}>Clear</Button>
          </p>
        )}

        <Card>
          <CardHeader title="People" description={focus ? `${rows.length} matching. Press Clear above to see everyone.` : `${all.length} ${all.length === 1 ? 'account' : 'accounts'}.`} />
          {rows.length === 0 ? (
            <EmptyState title="Nobody yet" body="Add the first person to give them a login to this console." />
          ) : (
            <Table head={['Name', 'Role', 'Status', 'Signs in as', 'Last sign-in', '']}>
              {rows.map((a) => {
                const fixed = a.you || a.roles.includes('super_admin')
                const role = a.roles.find((r) => r === 'super_admin') ?? a.roles.find((r) => r === 'seller_admin') ?? a.roles[0] ?? ''
                const off = a.status !== 'active'
                return (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap font-medium">
                      <span className="inline-flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className={cn('grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold',
                            off ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')}
                        >
                          {initials(a.full_name)}
                        </span>
                        <span className={off ? 'text-muted-foreground' : undefined}>{a.full_name}</span>
                        {a.you && !legacy && <Badge tone="info">You</Badge>}
                      </span>
                    </Td>
                    <Td className="min-w-[14.5rem]">
                      {fixed ? (
                        <span className="text-[13.5px]">{ROLE_NAME[role] ?? (role || 'No role')}</span>
                      ) : (
                        <Select
                          value={role}
                          onChange={(v) => { if (v && v !== role) setRole.mutate({ id: a.id, role: v }) }}
                          options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                        />
                      )}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{STATUS_NAME[a.status] ?? a.status}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-[13px]">{a.email ?? a.phone ?? '-'}</Td>
                    <Td className="num whitespace-nowrap text-muted-foreground">
                      {a.last_login_at ? formatDate(a.last_login_at) : 'Not yet'}
                    </Td>
                    <Td className="whitespace-nowrap text-right">
                      {!fixed && (
                        <span className="inline-flex items-center gap-1.5">
                          <ConfirmButton
                            confirmLabel="Reset password"
                            question="Signs them out everywhere and shows a new one-time password."
                            onConfirm={() => resetPassword.mutate(a.id)}
                            disabled={resetPassword.isPending}
                            variant="ghost"
                          >
                            Reset password
                          </ConfirmButton>
                          {a.status === 'active' ? (
                            <Button variant="ghost" size="sm" tone="danger" onClick={() => setSuspending(a)}>
                              Suspend
                            </Button>
                          ) : (
                            <Button variant="secondary" size="sm" onClick={() => setStatus.mutate({ id: a.id, status: 'active' })}>
                              Reactivate
                            </Button>
                          )}
                        </span>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>
      </PageBody>

      {suspending && (
        <SuspendDialog
          who={suspending}
          onClose={() => setSuspending(null)}
          onConfirm={(reason) => {
            setStatus.mutate({ id: suspending.id, status: 'suspended', reason })
            setSuspending(null)
          }}
        />
      )}
    </>
  )
}

/* Suspending takes a reason: it is written to the platform's event log, and
   the next administrator to look needs to know why a colleague cannot sign in. */
function SuspendDialog({ who, onClose, onConfirm }: {
  who: Staff
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog
      onClose={onClose}
      size="sm"
      title={`Suspend ${who.full_name}`}
      description="They are signed out now and cannot sign in until reactivated. Nothing is deleted."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button tone="danger" disabled={reason.trim().length < 4} onClick={() => onConfirm(reason.trim())}>
            Suspend
          </Button>
        </>
      }
    >
      <Field label="Reason" required hint="Kept in the platform event log.">
        <Input value={reason} onChange={setReason} placeholder="Left the company" />
      </Field>
    </Dialog>
  )
}

/**
 * The handover: the one moment the password exists in readable form. Only the
 * hash is stored, so this panel is loud and temporary on purpose.
 */
function HandoverCard({ h, onClose }: { h: Handover; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = `${h.full_name}\nSign in as: ${h.sign_in_as}\nTemporary password: ${h.temporary_password}`

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
  legacy,
}: {
  onDone: (h: Handover) => void
  onCancel: () => void
  /** The older server: support accounts only, by the older route. */
  legacy: boolean
}) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '', role: 'support_admin' })
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v })

  const create = useMutation({
    mutationFn: () => api.post<Handover>(legacy ? '/api/v1/seller/support-accounts' : '/api/v1/seller/staff', f),
    onSuccess: onDone,
  })

  const ready = f.full_name.trim() !== '' && (f.email.trim() !== '' || f.phone.trim() !== '')

  return (
    <Dialog
      onClose={onCancel}
      title="Add a person"
      description="Creates their login and shows a one-time password to hand over."
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button disabled={create.isPending || !ready} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create and show password'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && !create.isPending) create.mutate()
        }}
      >
        <FormGrid>
          <Field label="Full name" required wide>
            <Input value={f.full_name} onChange={(x) => set('full_name', x)} placeholder="Priya Nair" />
          </Field>
          <Field label="Email" hint="What they sign in with. Email or phone is required.">
            <Input type="email" value={f.email} onChange={(x) => set('email', x)} />
          </Field>
          <Field label="Phone">
            <Input value={f.phone} onChange={(x) => set('phone', x)} />
          </Field>
        </FormGrid>

        {!legacy && (
          <fieldset className="mt-4">
            <legend className="mb-1.5 text-[13px] font-medium text-secondary-foreground">Role</legend>
            {/* Two choices with what each can do, side by side: a select hid
                the difference behind a click and one long hint. */}
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLE_OPTIONS.map((o) => {
                const on = f.role === o.value
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set('role', o.value)}
                    className={cn('flex flex-col justify-start rounded-[var(--radius-input)] border px-3.5 py-3 text-left transition-colors',
                      on ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}
                  >
                    <span className="flex items-center justify-between gap-2 text-[14px] font-semibold">
                      {o.label}
                      {on && <Check className="size-4 text-primary" aria-hidden />}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-snug text-muted-foreground">{o.about}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}

        <FormNotice error={create.error} />
        {/* Enter in a field submits. */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  )
}
