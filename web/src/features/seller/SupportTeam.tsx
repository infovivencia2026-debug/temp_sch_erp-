import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, X } from 'lucide-react'
import { api, ApiError, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader,
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
  { value: 'support_admin', label: 'Support (read-only across schools)' },
  { value: 'seller_admin', label: 'Seller administrator (runs this console)' },
]

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

  const rows = staff.data?.items ?? []
  const active = rows.filter((a) => a.status === 'active').length

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
              setCreating((c) => !c)
            }}
          >
            {creating ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {creating ? 'Cancel' : 'Add a person'}
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

        <Card>
          <CardHeader
            title="People"
            description={`${rows.length} ${rows.length === 1 ? 'account' : 'accounts'}, ${active} active.`}
          />
          {rows.length === 0 ? (
            <EmptyState title="Nobody yet" body="Add the first person to give them a login to this console." />
          ) : (
            <Table head={['Name', 'Signs in as', 'Role', 'Status', 'Last sign-in', '']}>
              {rows.map((a) => {
                const fixed = a.you || a.roles.includes('super_admin')
                const role = a.roles.find((r) => r === 'super_admin') ?? a.roles.find((r) => r === 'seller_admin') ?? a.roles[0] ?? ''
                return (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap font-medium">
                      {a.full_name}
                      {a.you && <span className="ml-2 text-[12px] font-normal text-muted-foreground">you</span>}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-[13px]">{a.email ?? a.phone ?? '-'}</Td>
                    <Td className="min-w-[13rem]">
                      {fixed ? (
                        <span className="text-[13.5px]">{ROLE_NAME[role] ?? (role || 'No role')}</span>
                      ) : (
                        <Select
                          value={role}
                          onChange={(v) => { if (v && v !== role) setRole.mutate({ id: a.id, role: v }) }}
                          options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: ROLE_NAME[o.value] }))}
                        />
                      )}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.status}</Badge>
                    </Td>
                    <Td className="num text-muted-foreground">
                      {a.last_login_at ? formatDate(a.last_login_at) : 'never'}
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
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={setStatus.isPending}
                              onClick={() => setStatus.mutate({ id: a.id, status: 'active' })}
                            >
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
    <Card>
      <CardHeader
        title="Add a person"
        description="Creates their login and shows a one-time password to hand over."
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
          {!legacy && <Field label="Role" required wide hint="Support can look across schools but changes nothing and sees no child's records. A seller administrator can do everything in this console, including this screen.">
            <Select value={f.role} onChange={(x) => set('role', x || 'support_admin')} options={ROLE_OPTIONS} />
          </Field>}
        </FormGrid>

        <FormNotice error={create.error} />
        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={create.isPending || !ready}>
            {create.isPending ? 'Creating…' : 'Create and show password'}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
