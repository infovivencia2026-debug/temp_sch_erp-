import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type List } from '@/lib/api'
import { Card, CardHeader, Button, ConfirmButton, Input, Badge, FormNotice } from '@/components/ui'
import { formatDateTime } from '@/lib/utils'

/* The person's own security, on their profile: a second factor, and the
   devices they are signed in on. */

export function TwoFactorCard({ enabled, dayCode }: { enabled: boolean; dayCode: boolean }) {
  const qc = useQueryClient()
  const [setup, setSetup] = useState<{ secret: string; uri: string; image: string } | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; uri: string; image: string }>('/api/v1/profile/mfa/setup', {}),
    onSuccess: (r) => {
      setSetup(r)
      setCode('')
      setMsg(null)
    },
  })
  const enable = useMutation({
    mutationFn: () => api.post('/api/v1/profile/mfa/enable', { code }),
    onSuccess: () => {
      setSetup(null)
      setMsg('Two-factor is on. From now on, sign-in asks for the six-digit code after your password.')
      qc.invalidateQueries({ queryKey: ['session'] })
      qc.invalidateQueries({ queryKey: ['profile'] })
    },
  })
  const disable = useMutation({
    mutationFn: () => api.post('/api/v1/profile/mfa/disable', { password }),
    onSuccess: () => {
      setPassword('')
      setMsg('Two-factor is off.')
      qc.invalidateQueries({ queryKey: ['session'] })
      qc.invalidateQueries({ queryKey: ['profile'] })
    },
  })

  if (dayCode) {
    return (
      <Card>
        <CardHeader title="Two-factor sign-in" />
        <p className="p-4 text-[14px] text-muted-foreground">
          You signed in with the classroom day code. Two-factor is set up from your own sign-in on your
          own phone.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Two-factor sign-in"
        description="A six-digit code from an authenticator app on your phone, asked for after your password. Somebody who learns your password still cannot get in."
        action={enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
      />
      <div className="space-y-3 p-4">
        {msg && <p className="text-[13.5px] text-success">{msg}</p>}
        {!enabled && !setup && (
          <>
            <p className="text-[13.5px] text-muted-foreground">
              You need an authenticator app: Google Authenticator, Microsoft Authenticator or any other.
              Install it first, then press Set up.
            </p>
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? 'Preparing…' : 'Set up two-factor'}
            </Button>
            <FormNotice error={start.error} />
          </>
        )}
        {!enabled && setup && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              enable.mutate()
            }}
          >
            <ol className="list-decimal space-y-2 pl-5 text-[13.5px]">
              <li>Open the authenticator app and choose “Add” or “+”.</li>
              <li>
                Scan this code, or type the key below it.
                <div className="mt-2 inline-block rounded-xl border bg-white p-2">
                  <img src={setup.image} width={180} height={180} alt="Scan with your authenticator app" style={{ display: 'block' }} />
                </div>
                <div className="mt-1 break-all font-mono text-[12.5px] text-muted-foreground">{setup.secret}</div>
              </li>
              <li>Type the six digits the app shows now.</li>
            </ol>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Six-digit code</span>
              <Input value={code} onChange={setCode} className="mt-1 w-40" placeholder="123 456" />
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={enable.isPending || code.replace(/\s/g, '').length !== 6}>
                {enable.isPending ? 'Checking…' : 'Turn on'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
            <FormNotice error={enable.error} />
          </form>
        )}
        {enabled && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              disable.mutate()
            }}
          >
            <p className="text-[13.5px] text-muted-foreground">
              To switch it off, confirm your password. If you have lost the phone, ask the school office:
              they can switch it off for you from Logins &amp; access.
            </p>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Password</span>
              <Input type="password" value={password} onChange={setPassword} className="mt-1 w-60" />
            </label>
            <Button type="submit" variant="secondary" disabled={disable.isPending || !password}>
              {disable.isPending ? 'Switching off…' : 'Switch two-factor off'}
            </Button>
            <FormNotice error={disable.error} />
          </form>
        )}
      </div>
    </Card>
  )
}

interface OwnSession {
  id: string
  device: string
  ip?: string
  created_at: string
  last_seen_at: string
  current: boolean
}

export function MyDevicesCard() {
  const qc = useQueryClient()
  const { data, error } = useQuery({
    queryKey: ['own-sessions'],
    queryFn: () => api.get<List<OwnSession>>('/api/v1/profile/sessions'),
  })
  const others = useMutation({
    mutationFn: () => api.post<{ signed_out: number }>('/api/v1/profile/sessions/sign-out-others', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['own-sessions'] }),
  })
  const rows = data?.items ?? []
  return (
    <Card>
      <CardHeader
        title="Where you are signed in"
        description="Every device holding a live sign-in for your account. If one is not yours, sign the others out and change your password."
        action={
          rows.length > 1 ? (
            <ConfirmButton
              tone="danger"
              disabled={others.isPending}
              question="Sign out every device except this one?"
              confirmLabel="Sign others out"
              onConfirm={() => others.mutate()}
            >
              Sign out other devices
            </ConfirmButton>
          ) : undefined
        }
      />
      <ul className="divide-y">
        {rows.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-[13.5px]">
            <span>
              <span className="font-medium">{s.device}</span>
              {s.current && <Badge tone="success">This device</Badge>}
              {s.ip && <span className="ml-2 font-mono text-[12px] text-muted-foreground">{s.ip}</span>}
            </span>
            <span className="text-[12.5px] text-muted-foreground">
              since {formatDateTime(s.created_at)} · last active {formatDateTime(s.last_seen_at)}
            </span>
          </li>
        ))}
        {!rows.length && !error && <li className="px-4 py-3 text-[13.5px] text-muted-foreground">Loading…</li>}
      </ul>
      {(error || others.error) && (
        <div className="border-t px-4 py-3">
          <FormNotice error={(error ?? others.error) as ApiError} />
        </div>
      )}
      {others.isSuccess && (
        <div className="border-t px-4 py-3 text-[13px] text-muted-foreground">
          Signed out {others.data.signed_out} other device{others.data.signed_out === 1 ? '' : 's'}.
        </div>
      )}
    </Card>
  )
}
