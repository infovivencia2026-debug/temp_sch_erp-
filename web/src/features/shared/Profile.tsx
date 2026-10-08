import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Info, KeyRound, Lock, Pencil, ShieldCheck, UserCheck } from 'lucide-react'
import { formatDateTime, cn } from '@/lib/utils'
import {
  Card, CardHeader, Button, Loading, ErrorState, Badge, Input, Field, FormNotice, PageBody,
} from '@/components/ui'
import { useSession } from '@/lib/session'
import { MyGrowthPanels } from '@/features/hr/MyGrowth'
import { TwoFactorCard, MyDevicesCard, MySessionActivityCard } from './SecurityCards'


/* A SECTION, AS THE DESIGN DRAWS ONE.
 *
 * An icon in a tinted tile, the heading, a line saying what the section is
 * for, and the section's own control on the right. Four sections on this page
 * used four slightly different headers before, because each was written where
 * it stood; the design has one shape and so does this.
 *
 * Every tint is a palette token rather than a literal. The design's indigo-50
 * and slate-900 are right in one theme and wrong in the other, and wrong again
 * for a school that has set its own colours.
 */
function Section({
  icon: Icon,
  tone = 'neutral',
  title,
  hint,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  tone?: 'neutral' | 'primary' | 'warning' | 'success' | 'danger'
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}) {
  const tile = {
    neutral: 'bg-muted text-muted-foreground',
    primary: 'bg-primary/10 text-primary',
    warning: 'bg-warning/10 text-warning',
    success: 'bg-success/10 text-success',
    danger: 'bg-destructive/10 text-destructive',
  }[tone]
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b bg-surface-sunken/40 px-5 py-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', tile)}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-bold leading-tight">{title}</h2>
            {hint && <p className="text-[12.5px] text-muted-foreground">{hint}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}

/* One fact about this account in its own bordered tile: the label small and
   quiet above, the value plain below. A row of label-rule-value reads as a form
   somebody has to fill in; a tile reads as a record, which is what it is. */
function Fact({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="space-y-1 rounded-xl border p-4 transition-colors hover:border-foreground/15">
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className={cn('text-[14px] font-semibold', mono && 'font-mono')}>{value}</div>
    </div>
  )
}
interface Profile {
  id: string; full_name: string; email?: string; phone?: string
  status: string; last_login_at?: string; mfa_enabled: boolean
  enrolment?: {
    admission_no: string; class_name?: string; section_name?: string
    roll_no?: number; status?: string
  }
}

import { ConcernsCard } from '@/features/me/MyConcerns'

export default function ProfileView() {
  const session = useSession()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<Profile>('/api/v1/profile'),
  })
  /* The cards below fetch their own lists. Asked for here too, under the same
     keys, so the page draws once with all of them: the day code arriving late
     slid in above the password card, and the device list grew from one line
     to many, and both pushed everything under them down. */
  const extras = [
    useQuery({ queryKey: ['my-day-code'], queryFn: () => api.get<unknown>('/api/v1/me/day-code'), retry: false }),
    useQuery({ queryKey: ['own-sessions'], queryFn: () => api.get<unknown>('/api/v1/profile/sessions'), retry: false }),
    useQuery({ queryKey: ['own-session-activity'], queryFn: () => api.get<unknown>('/api/v1/profile/session-activity'), retry: false }),
  ]

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

  /* BLANK THE PAGE ONCE, NOT ON EVERY RELOAD.

     This was `isLoading || extras.some(q => q.isLoading)`, and isLoading
     is true for EVERY load of a query, not only the first -- so any one
     of these four refetching replaced a page that was already drawn with
     a sheet of grey bars and then drew it again. Four queries means four
     chances of that per refresh, and three of them 403 for a parent, so
     the page flashed on its own with nothing wrong and nothing changing.

     isFetched is the honest test: false until a query has settled once,
     true forever after, including for one that settled by failing. A
     card whose own list is refused says so itself; it does not get to
     hold the whole screen at a skeleton. */
  if ((isLoading && !data) || extras.some((q) => !q.isFetched)) return <Loading />
  if (error) return <ErrorState error={error} />

  return (
    /* THE ACCOUNT SCREEN, AS THE DESIGN DRAWS IT.
     *
     * One column of sections at a readable measure, each opening with an icon
     * in a tinted tile, a heading and a line saying what the section is for.
     * It used to be two columns of cards headed "Profile" and "Change
     * password" -- which names the first section rather than the screen, and
     * put a password form beside a list of facts as though they were the same
     * kind of thing.
     *
     * Every tint is a palette token, never a literal: the design's indigo-50
     * and slate-900 would be right in one theme and wrong in the other, and
     * wrong again for a school that has set its own colours.
     *
     * PageBody carries the gutter. Without it this screen's cards began at the
     * exact pixel the sidebar ended and ran to the window's edge -- 286 to
     * 1440, measured -- which is the "everything touches the sidebar", and it
     * was this page rather than the sidebar. `top` does the same for the top
     * edge, which a screen with no PageHead has nothing else to supply.
     */
    <PageBody top width="form">
      <div className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <Badge tone="primary" className="self-start">
            <Lock className="h-3 w-3" />
            Security centre
          </Badge>
          <h1 className="text-[26px] font-extrabold tracking-[-0.02em] sm:text-[30px]">
            Account &amp; security
          </h1>
          <p className="max-w-2xl text-[13px] text-muted-foreground">
            Your details as the school records them, the password you sign in with, and every
            browser currently holding a sign-in for you.
          </p>
        </div>
      </div>

      <Section
        icon={UserCheck}
        tone="primary"
        title="Identity and profile"
        hint="What the school has on record, and how it reaches you"
        action={editing ? undefined : (
          /* A pencil in the card's corner, the way a phone shows "edit"
             (owner, 2026-10-08). The word stays for screen readers. */
          <button type="button" onClick={startEditing} aria-label="Edit" title="Edit"
            className="grid size-9 place-items-center rounded-full border bg-[hsl(var(--card))] text-[hsl(var(--primary))] shadow-sm transition-colors hover:bg-muted">
            <Pencil className="size-4" aria-hidden="true" />
          </button>
        )}
      >
        {/* WHO THIS IS, before what is recorded about them.

            A list of label-and-value rows answers "what is my phone number"
            and never answers "whose account am I looking at" -- which is the
            first thing anybody checks on a shared machine. */}
        {!editing && (
          <div className="m-5 flex flex-col gap-4 rounded-2xl border bg-surface-sunken/40 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <span
                className="grid h-16 w-16 flex-none place-items-center rounded-2xl bg-primary/10 text-[20px] font-extrabold text-primary"
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
                  <h3 className="text-[19px] font-bold">{data?.full_name}</h3>
                  {session.user?.roles.map((role) => <Badge key={role}>{role}</Badge>)}
                  <Badge tone={data?.status === 'active' ? 'success' : 'warning'}>
                    {data?.status}
                  </Badge>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  {session.institution?.name ?? 'This school'}
                  {data?.last_login_at
                    ? ' · last signed in ' + formatDateTime(data.last_login_at)
                    : ''}
                </p>
              </div>
            </div>
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-4 p-5 pt-0">
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
          /* EACH FACT IN ITS OWN TILE.

             These were rows of label, rule, value down a narrow card: a shape
             that reads as a form somebody has to fill in. A record should look
             like a record, and two columns of tiles also stop the page being
             a single column of text on a wide screen. */
          <div className="grid gap-3 p-5 pt-0 sm:grid-cols-2">
            <Fact label="Full name" value={data?.full_name ?? '—'} />
            <Fact label="Email" value={data?.email ?? '—'} />
            <Fact label="Phone" value={data?.phone ?? '—'} mono={!!data?.phone} />
            {data?.enrolment && (
              <>
                <Fact label="Admission no" value={data.enrolment.admission_no} mono />
                <Fact
                  label="Class"
                  value={
                    data.enrolment.class_name
                      ? data.enrolment.class_name
                        + (data.enrolment.section_name ? '-' + data.enrolment.section_name : '')
                      : 'Not placed'
                  }
                />
                {data.enrolment.roll_no != null && (
                  <Fact label="Roll no" value={String(data.enrolment.roll_no)} mono />
                )}
              </>
            )}
            <Fact label="Roles" value={session.user?.roles.join(', ') || '—'} />
            <Fact
              label="Two-factor"
              value={
                data?.mfa_enabled
                  ? <span className="text-success">On</span>
                  : <span className="text-muted-foreground">Not set up</span>
              }
            />
            <Fact label="Permissions" value={`${session.permissions.length} granted`} />
          </div>
        )}
      </Section>

      <MyDayCode />

      {session.user?.day_code ? (
        <Section icon={KeyRound} tone="warning" title="Password" hint="Signed in with a day code">
          <p className="p-5 text-[14px] text-muted-foreground">
            You signed in with the classroom day code, so this screen cannot change your
            password. Sign in with your password on your own phone to change it.
          </p>
        </Section>
      ) : (
        <Section
          icon={KeyRound}
          tone="warning"
          title="Login password"
          hint="Changing it signs out every other browser"
        >
          <form
            className="max-w-xl space-y-4 p-5"
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
            {change.isSuccess && (
              <p className="text-xs text-success">Password changed. Other sessions signed out.</p>
            )}
            <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
              <span data-help-anchor="change-password"><Button
                type="submit"
                disabled={change.isPending || next.length < 12 || !current || confirm !== next}
              >
                {change.isPending ? 'Saving…' : 'Change password'}
              </Button></span>
              <span className="text-[12px] text-muted-foreground">
                Everywhere else you are signed in will be signed out.
              </span>
            </div>
          </form>
        </Section>
      )}

      {/* The person's own security: a second factor, and every device holding
          a sign-in for them. See SecurityCards.tsx. */}
      <TwoFactorCard enabled={!!data?.mfa_enabled} dayCode={!!session.user?.day_code} />
      <MyDevicesCard />
      <MySessionActivityCard />

      {/* Leaving. Google Play requires an in-app route to account deletion for
          any app with sign-in, and a family has a right to ask regardless. The
          account is the school's to remove, so this opens the public page that
          explains what is deleted, what the school must keep by law, and how to
          ask — the same page the store listing links to. */}
      <Section
        icon={ShieldCheck}
        tone="danger"
        title="Delete my account"
        hint="Your account is created by your school; ask them to remove it"
      >
        <div className="flex flex-wrap items-center gap-3 p-5 text-[13px] text-muted-foreground">
          <span className="max-w-[60ch]">
            Deletion is completed within 30 days. Records the school must keep by law (fee receipts,
            attendance, certificates) are retained by the school and unlinked from your login.
          </span>
          <a
            href="/delete-account"
            target="_blank"
            rel="noopener"
            className="btn inline-flex min-h-[36px] items-center rounded-sm border border-destructive/30 px-3.5 text-[13px] font-medium text-destructive hover:bg-destructive/5 [@media(pointer:coarse)]:min-h-[44px]"
            data-variant="secondary"
          >
            Request account deletion
          </a>
        </div>
      </Section>

      {/* The staff side of "my own record".

          A teacher's appraisal, training hours and duty roster are read through
          /hr-growth/me/*, which is gated on self.profile.read — the same
          entitlement that opens this screen — and narrowed to the caller's own
          employee row by the server. They belong here because this is where
          somebody looks for what the school holds about them; the HR screens
          that hold the other side of these records are gated on
          hr.employees.read and a teacher cannot open them. Renders nothing for
          a signed-in user who has no staff record. */}
      <ConcernsCard />
      <MyGrowthPanels quiet />

      <div className="flex items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 text-[12.5px]">
        <Info className="h-4 w-4 shrink-0 text-primary" />
        <span>
          Need a role changed, a name corrected on the school&rsquo;s records, or access you do
          not have? The office can do all three; this screen cannot.
        </span>
      </div>
    </PageBody>
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


/* Today's classroom sign-in code, for a teacher reading it off their phone.

   The server answers 404 for anybody without a teaching role, and "off" for
   a school that has not switched it on; both render nothing, so the card
   exists only where it has something to say. */
function MyDayCode() {
  const { data } = useQuery({
    queryKey: ['my-day-code'],
    queryFn: () => api.get<{ enabled: boolean; code?: string; date?: string }>('/api/v1/me/day-code'),
    retry: false,
  })
  if (!data?.enabled) return null
  return (
    <Card>
      <CardHeader title="Classroom sign-in code" />
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4">
        <p className="font-mono text-[34px] font-semibold tracking-[0.18em] tabular-nums">{data.code}</p>
        <p className="max-w-sm text-[14px] text-muted-foreground">
          Type this instead of your password when signing in on a classroom screen. It is the
          same for every teacher today and changes at midnight.
        </p>
      </div>
    </Card>
  )
}
