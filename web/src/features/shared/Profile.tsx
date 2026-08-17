import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, Button, Loading, ErrorState, Badge } from '@/components/ui'
import { useSession } from '@/lib/session'

interface Profile {
  id: string; full_name: string; email?: string; phone?: string
  status: string; last_login_at?: string; mfa_enabled: boolean
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
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Profile" />
        <dl className="divide-y text-sm">
          <Row label="Name" value={data?.full_name} />
          <Row label="Email" value={data?.email ?? '—'} />
          <Row label="Phone" value={data?.phone ?? '—'} />
          <Row label="Status" value={<Badge tone="success">{data?.status}</Badge>} />
          <Row label="Two-factor" value={data?.mfa_enabled ? 'Enabled' : 'Not set up'} />
          <Row label="Roles" value={session.user?.roles.join(', ') || '—'} />
          <Row label="Permissions" value={`${session.permissions.length} granted`} />
        </dl>
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
          <Field label="Current password" value={current} onChange={setCurrent} />
          <Field label="New password" value={next} onChange={setNext} hint="At least 12 characters." />
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

function Field({ label, value, onChange, hint }: {
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
