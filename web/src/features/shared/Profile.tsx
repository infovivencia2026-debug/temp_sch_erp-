import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
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

  /* Editing was never wired up.

     PUT /api/v1/profile has accepted a name and a phone since the endpoint was
     written, and the screen showed both as read-only rows -- so a student whose
     number changed had no way to say so, on the one screen that is entirely
     about them. Email stays read-only on purpose: it is a login identifier and
     changing it needs a verification round trip, not a PUT. */
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/profile', { full_name: name.trim(), phone: phone.trim() || null }),
    onSuccess: () => {
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['profile'] })
      qc.invalidateQueries({ queryKey: ['session'] })
    },
  })

  function startEditing() {
    setName(data?.full_name ?? '')
    setPhone(data?.phone ?? '')
    setEditing(true)
  }

  const change = useMutation({
    mutationFn: () => api.post('/api/v1/profile/password', {
      current_password: current, new_password: next,
    }),
    onSuccess: () => {
      setCurrent(''); setNext('')
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

        {editing ? (
          <div className="flex flex-col gap-4 p-5">
            <Field label="Name">
              <Input value={name} onChange={setName} placeholder="Your full name" />
            </Field>
            <Field label="Phone" hint="Used for attendance and fee alerts.">
              <Input value={phone} onChange={setPhone} placeholder="98xxxxxxxx" />
            </Field>
            <p className="text-[12.5px] text-muted-foreground">
              Email is your sign-in and cannot be changed here.
            </p>
            <FormNotice error={save.error} />
            <div className="flex gap-2">
              <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
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
          <PasswordField label="New password" value={next} onChange={setNext} hint="At least 12 characters." />
          {change.isError && (
            <p className="text-xs text-destructive">
              {change.error instanceof Error ? change.error.message : 'Could not change password'}
            </p>
          )}
          {change.isSuccess && <p className="text-xs text-success">Password changed. Other sessions signed out.</p>}
          <Button type="submit" disabled={change.isPending || next.length < 12 || !current}>
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
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
      />
      {hint && <span className="mt-0.5 block text-[12px] text-muted-foreground">{hint}</span>}
    </label>
  )
}
