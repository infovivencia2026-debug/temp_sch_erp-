import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatDateTime, cn } from '@/lib/utils'
import {
  Card, CardHeader, Button, Loading, ErrorState, Badge, Input, Field, FormNotice,
} from '@/components/ui'
import { useSession } from '@/lib/session'
import { MyGrowthPanels } from '@/features/hr/MyGrowth'

interface Profile {
  id: string; full_name: string; email?: string; phone?: string
  status: string; last_login_at?: string; mfa_enabled: boolean
  enrolment?: {
    admission_no: string; class_name?: string; section_name?: string
    roll_no?: number; status?: string
  }
}

export default function ProfileView() {
  const session = useSession()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<Profile>('/api/v1/profile'),
  })

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  /* Typed twice, because this is the one field nobody can read back.

     A mistyped password is not discovered at the keyboard -- it is discovered
     the next morning, by somebody who is now locked out of the school they
     work at, with no way to prove who they are except asking the office. */
  const [confirm, setConfirm] = useState('')

  /* Editing was never wired up.

     PUT /api/v1/profile has accepted a name and a phone since the endpoint was
     written, and the screen showed both as read-only rows -- so a student whose
     number changed had no way to say so, on the one screen that is entirely
     about them. Email stays read-only on purpose: it is a login identifier and
     changing it needs a verification round trip, not a PUT. */
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  /* The address you sign in with, and the password that authorises moving it.
     Asked for only when the address actually changes -- correcting a phone
     number should not require a password. */
  const [email, setEmail] = useState('')
  const [pwForEmail, setPwForEmail] = useState('')
  const emailChanged =
    email.trim().toLowerCase() !== (data?.email ?? '').trim().toLowerCase()

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/profile', {
        full_name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        current_password: pwForEmail,
      }),
    onSuccess: () => {
      setEditing(false)
      setPwForEmail('')
      qc.invalidateQueries({ queryKey: ['profile'] })
      qc.invalidateQueries({ queryKey: ['session'] })
    },
  })

  function startEditing() {
    setName(data?.full_name ?? '')
    setPhone(data?.phone ?? '')
    setEmail(data?.email ?? '')
    setPwForEmail('')
    setEditing(true)
  }

  const change = useMutation({
    mutationFn: () => api.post('/api/v1/profile/password', {
      current_password: current, new_password: next,
    }),
    onSuccess: () => {
      setCurrent(''); setNext(''); setConfirm('')
      qc.invalidateQueries({ queryKey: ['profile'] })
    },
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />

  return (
    <>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Profile"
          action={
            editing ? undefined : (
              <Button size="sm" variant="secondary" onClick={startEditing}>Edit</Button>
            )
          }
        />

        {/* WHO THIS IS, before what is recorded about them.

            A list of label-and-value rows answers "what is my phone number"
            and never answers "whose account am I looking at" -- which is the
            first thing somebody checks on a shared machine. Name, school and
            standing, once, at the top. */}
        {!editing && (
          <div className="flex items-start gap-4 border-b p-5">
            <span
              className="flex h-14 w-14 flex-none items-center justify-center rounded-full
                         bg-primary/10 text-[18px] font-semibold text-primary"
              aria-hidden
            >
              {(data?.full_name ?? '?')
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((w) => w[0]?.toUpperCase())
                .join('')}
            </span>
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[19px] font-semibold">{data?.full_name}</h3>
                {session.user?.roles.map((role) => (
                  <Badge key={role}>{role}</Badge>
                ))}
                <Badge tone={data?.status === 'active' ? 'success' : 'warning'}>
                  {data?.status}
                </Badge>
              </div>
              <p className="text-[13px] text-muted-foreground">
                {session.institution?.name ?? 'This school'}
                {data?.last_login_at ? ` \u00b7 last signed in ${formatDateTime(data.last_login_at)}` : ''}
              </p>
            </div>
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-4 p-5">
            <Field label="Name">
              <Input value={name} onChange={setName} placeholder="Your full name" />
            </Field>
            <Field label="Phone" hint="Used for attendance and fee alerts.">
              <Input value={phone} onChange={setPhone} placeholder="98xxxxxxxx" />
            </Field>
            <Field label="Email" hint="This is how you sign in.">
              <Input value={email} onChange={setEmail} placeholder="you@school.in" />
            </Field>
            {/* Only when it actually changes. A password box that appears
                whether or not you touched the field trains people to type
                their password without reading why. */}
            {emailChanged && (
              <Field
                label="Your current password"
                hint="Moving the address you sign in with needs it, so a session left open on a shared machine cannot lock you out of your own school."
              >
                <Input type="password" value={pwForEmail} onChange={setPwForEmail} />
              </Field>
            )}
            <FormNotice error={save.error} />
            <div className="flex gap-2">
              <Button
                disabled={!name.trim() || save.isPending || (emailChanged && !pwForEmail)}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
        <dl className="divide-y text-sm">
          <Row label="Name" value={data?.full_name} />
          <Row label="Email" value={data?.email ?? '—'} />
          <Row label="Phone" value={data?.phone ?? '—'} />
          {data?.enrolment && (
            <>
              <Row label="Admission no." value={data.enrolment.admission_no} />
              <Row
                label="Class"
                value={
                  data.enrolment.class_name
                    ? `${data.enrolment.class_name}${data.enrolment.section_name ? `-${data.enrolment.section_name}` : ''}`
                    : 'Not placed'
                }
              />
              {data.enrolment.roll_no != null && (
                <Row label="Roll no." value={String(data.enrolment.roll_no)} />
              )}
            </>
          )}
          <Row label="Status" value={<Badge tone="success">{data?.status}</Badge>} />
          <Row label="Two-factor" value={data?.mfa_enabled ? 'Enabled' : 'Not set up'} />
          <Row label="Roles" value={session.user?.roles.join(', ') || '—'} />
          <Row label="Permissions" value={`${session.permissions.length} granted`} />
        </dl>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Change password"
          description="Signing in elsewhere will be revoked."
        />
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => { e.preventDefault(); change.mutate() }}
        >
          <PasswordField label="Current password" value={current} onChange={setCurrent} />
          <PasswordField label="New password" value={next} onChange={setNext} />
          <PasswordMeter value={next} />
          <PasswordField
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            hint={confirm && confirm !== next ? 'These two do not match.' : undefined}
          />
          {change.isError && (
            <p className="text-xs text-destructive">
              {change.error instanceof Error ? change.error.message : 'Could not change password'}
            </p>
          )}
          {change.isSuccess && <p className="text-xs text-success">Password changed. Other sessions signed out.</p>}
          <Button
            type="submit"
            disabled={change.isPending || next.length < 12 || !current || confirm !== next}
          >
            {change.isPending ? 'Saving…' : 'Change password'}
          </Button>
        </form>
      </Card>
    </div>

    {/* The staff side of "my own record".

        A teacher's appraisal, training hours and duty roster are read through
        /hr-growth/me/*, which is gated on self.profile.read — the same
        entitlement that opens this screen — and narrowed to the caller's own
        employee row by the server. They belong here because this is where
        somebody looks for what the school holds about them; the HR screens
        that hold the other side of these records are gated on
        hr.employees.read and a teacher cannot open them. Renders nothing for
        a signed-in user who has no staff record. */}
    <div className="mt-4 grid gap-4">
      <MyGrowthPanels quiet />
    </div>
    </>
  )
}


/* What is actually wrong with the password, while it is being typed.
 *
 * "At least 12 characters" as a hint under the box is read once and then
 * ignored, and the refusal arrives after the form is submitted. The rules are
 * few and checkable, so they are shown filling in as they are met -- the
 * person can see which one they have not done rather than guessing at a
 * strength word.
 *
 * The bar is a count of rules met, not an opinion about entropy. A meter that
 * says "Strong" for a password a school will reject teaches somebody to trust
 * the wrong thing.
 */
function PasswordMeter({ value }: { value: string }) {
  const rules = [
    { label: '12 characters', ok: value.length >= 12 },
    { label: 'a capital', ok: /[A-Z]/.test(value) },
    { label: 'a small letter', ok: /[a-z]/.test(value) },
    { label: 'a number', ok: /[0-9]/.test(value) },
    { label: 'a symbol', ok: /[^A-Za-z0-9]/.test(value) },
  ]
  const met = rules.filter((r) => r.ok).length

  if (!value) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5" aria-hidden>
        {rules.map((r, i) => (
          <span
            key={r.label}
            className={cn(
              'h-1 flex-1 rounded-full',
              i < met
                ? met <= 2 ? 'bg-destructive' : met <= 4 ? 'bg-warning' : 'bg-success'
                : 'bg-border',
            )}
          />
        ))}
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        {rules.map((r) => (
          <span
            key={r.label}
            className={cn('inline-flex items-center gap-1',
              r.ok ? 'text-success' : 'text-muted-foreground')}
          >
            <span aria-hidden>{r.ok ? '✓' : '○'}</span>
            {r.label}
          </span>
        ))}
      </p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 px-4 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function PasswordField({ label, value, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      {/* The shared Input, rather than a hand-rolled one, so this box gets the
          reveal every other password box has. Changing a password means typing
          the old one and the new one twice, which is three chances to make a
          mistake nobody can see. */}
      <div className="mt-1">
        <Input type="password" value={value} onChange={onChange} />
      </div>
      {hint && <span className="mt-0.5 block text-[12px] text-muted-foreground">{hint}</span>}
    </label>
  )
}
