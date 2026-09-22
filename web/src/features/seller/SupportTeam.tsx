import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader,
  Table, Td, Badge, Button, Field, FormGrid, FormNotice,
  Input, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The vendor's support-team logins.

   A support engineer needs a login that reaches across schools to reproduce a
   fault — the support_admin role, read-only by construction: it sees that a
   school exists, that its jobs run and what its audit trail says, and no child's
   records at all. Until now those accounts were a shell command on the server,
   so a support hire could not be given access without an engineer.

   This is that command as a screen, and nothing more. It creates ONLY a
   support_admin — the role is fixed on the server, never chosen here — so it can
   never mint a seller or a super admin. The password is shown once, on the
   handover panel, and stored only as a hash: lose it and the answer is to make a
   fresh account, the same as everywhere else in this product. */

interface SupportAccount {
  id: string
  full_name: string
  email?: string
  phone?: string
  status: string
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

export default function SupportTeam() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [handover, setHandover] = useState<Handover | null>(null)

  const accounts = useQuery({
    queryKey: ['support-accounts'],
    queryFn: () => api.get<List<SupportAccount>>('/api/v1/seller/support-accounts'),
  })

  const rows = accounts.data?.items ?? []

  if (accounts.isLoading) return <SkeletonTable columns={4} />
  if (accounts.error) return <ErrorState error={accounts.error} />

  return (
    <>
      <PageHead
        eyebrow="Support"
        title="Support team"
        description={
          'The vendor’s own support-desk logins. Read-only platform accounts that reach across '
          + 'schools to reproduce faults, and see no child’s records.'
        }
        actions={
          <Button
            onClick={() => {
              setHandover(null)
              setCreating((c) => !c)
            }}
          >
            {creating ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {creating ? 'Cancel' : 'Create support account'}
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
              qc.invalidateQueries({ queryKey: ['support-accounts'] })
            }}
            onCancel={() => setCreating(false)}
          />
        )}

        <Card>
          <CardHeader
            title="Support accounts"
            description={`${rows.length} on the support team, name, sign-in, when created and last used.`}
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No support accounts yet"
              body="Create one to give a support engineer read-only access across every school."
            />
          ) : (
            <Table head={['Name', 'Signs in as', 'Status', 'Created', 'Last sign-in']}>
              {rows.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap font-medium">{a.full_name}</Td>
                  <Td className="whitespace-nowrap font-mono text-[13px]">
                    {a.email ?? a.phone ?? '-'}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.status}</Badge>
                  </Td>
                  <Td className="num text-muted-foreground">{formatDate(a.created_at)}</Td>
                  <Td className="num text-muted-foreground">
                    {a.last_login_at ? formatDate(a.last_login_at) : 'never'}
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
}: {
  onDone: (h: Handover) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '' })
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v })

  const create = useMutation({
    mutationFn: () => api.post<Handover>('/api/v1/seller/support-accounts', f),
    onSuccess: onDone,
  })

  const ready = f.full_name.trim() !== '' && (f.email.trim() !== '' || f.phone.trim() !== '')

  return (
    <Card>
      <CardHeader
        title="Create a support account"
        description={
          'A read-only platform login holding the support_admin role. It can see every school’s '
          + 'shape and audit trail, and no child’s records.'
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
