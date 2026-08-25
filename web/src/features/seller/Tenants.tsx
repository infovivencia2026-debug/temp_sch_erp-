import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus, X } from 'lucide-react'
import { api, setActingInstitution, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader,
  Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, Loading, ErrorState, EmptyState, useSort,
} from '@/components/ui'
import { cn, formatDate, formatPaise } from '@/lib/utils'

/* The vendor's customer list.

   A sale ends with somebody able to sign in. Before this screen that last step
   was a shell command on the server, so closing a deal needed an engineer and
   the credentials were pasted into whatever chat window was open.

   Provisioning is one action here: school, campus, first administrator and
   subscription in a single transaction, ending in a handover panel the
   salesperson reads out. The password is shown once and never stored in the
   clear — if it is lost the answer is to reset it, which is also one click. */

interface Tenant {
  id: string
  name: string
  short_name: string
  district?: string
  status: string
  students: number
  staff: number
  plan?: string
  plan_name?: string
  subscription_status?: string
  renews_on?: string
  licensed_students?: number
  over_by: number
  setup_percent: number
  last_sign_in?: string
  created_on: string
}
interface Plan {
  code: string
  name: string
  price_paise: number
  max_students?: number
  modules: string[]
  schools: number
}
interface Handover {
  school: string
  admin_name: string
  sign_in_as: string
  password: string
  note: string
}

const SUB_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  trial: 'warning',
  past_due: 'danger',
  suspended: 'danger',
  cancelled: 'neutral',
}

/* One screen, seven doors into it.

   Every entry in this workspace rendered this page unfiltered, so the rail
   read as seven promises and paid out one. They stay one screen — a school is
   a single row, and splitting it would mean seven copies of that row and seven
   half-views of the same account — but each entry now opens on what its own
   name says.

   VIEW decides what is on screen; TITLES decides what it is called. Kept apart
   because two entries can share a view and never share a heading: provisioning
   a school and reading the directory are the same table with the form open. */
type SellerView =
  | 'directory'
  | 'provision'
  | 'access'
  | 'onboarding'
  | 'plans'
  | 'ledger'
  | 'capacity'

const VIEW: Record<string, SellerView> = {
  schools: 'directory',
  add_school: 'provision',
  access: 'access',
  setup: 'onboarding',
  plans_pricing: 'plans',
  subscription_ledger: 'ledger',
  license_capacity: 'capacity',
}

const TITLES: Record<SellerView, [string, string, string]> = {
  directory: [
    'Schools',
    'Every school on this installation',
    'What each one pays, how many children it has on the roll, and how far it has got.',
  ],
  provision: [
    'Add a school',
    'Schools',
    'Create a school, its first campus and its first administrator in one step. The credentials '
      + 'are shown once, to hand over.',
  ],
  access: [
    'Access',
    'Schools',
    'Who may sign in and who may not. Suspending blocks sign-in and keeps every record; nothing '
      + 'is deleted and nothing needs restarting.',
  ],
  onboarding: [
    'Setup',
    'Schools',
    'How far each new school has got, and which step it is stuck on \u2014 so somebody can '
      + 'intervene before a stalled rollout becomes a cancellation.',
  ],
  plans: [
    'Plans & Pricing',
    'Subscriptions & Billing',
    'What a school can be sold: the student cap, the modules included, and the price.',
  ],
  ledger: [
    'Subscription Ledger',
    'Subscriptions & Billing',
    'What each school is on, what it is worth a year, and when it renews.',
  ],
  capacity: [
    'License & capacity',
    'Subscriptions & Billing',
    'Schools past the students their plan allows, and those inside the renewal window, counted '
      + 'from the live headcount rather than from what was sold.',
  ],
}

export default function Tenants() {
  const { featureSlug } = useParams()
  const view: SellerView = VIEW[featureSlug ?? ''] ?? 'directory'
  const [title, eyebrow, description] = TITLES[view]

  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [handover, setHandover] = useState<Handover | null>(null)

  const tenants = useQuery({
    queryKey: ['seller-tenants'],
    queryFn: () => api.get<List<Tenant>>('/api/v1/seller/tenants'),
  })
  const plans = useQuery({
    queryKey: ['seller-plans'],
    queryFn: () => api.get<List<Plan>>('/api/v1/seller/plans'),
  })

  const resetAdmin = useMutation({
    mutationFn: (id: string) => api.post<Handover>(`/api/v1/seller/tenants/${id}/reset-admin`),
    onSuccess: (d) => setHandover(d),
  })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.put(`/api/v1/seller/tenants/${id}/subscription`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['seller-tenants'] }),
  })

  const rows = tenants.data?.items ?? []
  /* Stalled rollouts first: the number that predicts a cancellation.

     Above the early returns, not below. Every hook has to run on every
     render, and a useSort placed after "if (isLoading) return" changes the
     hook count between the loading and loaded renders — which React cannot
     recover from. */
  const sort = useSort<Tenant>(
    rows,
    (t, k) => (t as unknown as Record<string, string | number | undefined>)[k],
    { key: 'setup_percent' },
  )

  if (tenants.isLoading) return <Loading />
  if (tenants.error) return <ErrorState error={tenants.error} />

  return (
    <>
      <PageHead
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={
          <Button
            onClick={() => {
              setHandover(null)
              setCreating((c) => !c)
            }}
          >
            {creating ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {creating ? 'Cancel' : 'New school'}
          </Button>
        }
      />
      <PageBody>
        {/* The four business numbers live on the Dashboard now.

            They were repeated above every one of these seven views, which is
            the loudest reason the views read as one page: the eye lands on the
            same row of figures each time and concludes nothing has changed.
            One place to read them, seven places that answer their own
            question. */}

        {handover && <HandoverCard h={handover} onClose={() => setHandover(null)} />}

        {/* On its own entry the form is the screen, so it is open on arrival.
            Somebody who clicked "Onboard New School" has already said what
            they want; making them press "New school" first is the menu asking
            a question and then asking it again. */}
        {(creating || view === 'provision') && (
          <ProvisionForm
            plans={plans.data?.items ?? []}
            onDone={(h) => {
              setCreating(false)
              setHandover(h)
              qc.invalidateQueries({ queryKey: ['seller-tenants'] })
            }}
            onCancel={() => setCreating(false)}
          />
        )}

        {view === 'onboarding' && <OnboardingPipeline rows={rows} />}

        {view === 'access' && (
          <AccessHub rows={rows} onSet={(id, status) => setStatus.mutate({ id, status })} busy={setStatus.isPending} />
        )}

        {view === 'capacity' && <CapacityBoard rows={rows} />}

        {view === 'ledger' && <LedgerBoard rows={rows} plans={plans.data?.items ?? []} />}

        {view === 'directory' && (
        <Card>
          <CardHeader
            title="Every school"
            description={`${rows.length} registered — plan, roll, setup and when each was last used.`}
          />
          {rows.length === 0 ? (
            <EmptyState title="No customers yet" body="Provision the first school to get started." />
          ) : (
            <Table
              head={[
                { label: 'School', key: 'name' },
                { label: 'Plan', key: 'plan_name' },
                { label: 'Students', key: 'students' },
                { label: 'Setup', key: 'setup_percent' },
                { label: 'Renews', key: 'renews_on' },
                { label: 'Last sign-in', key: 'last_sign_in' },
                '',
              ]}
              sort={sort}
            >
              {sort.sorted.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium">
                    {t.name}
                    <span className="block text-[12px] font-normal text-muted-foreground">
                      {t.district ?? t.short_name} · since {formatDate(t.created_on)}
                    </span>
                  </Td>
                  <Td>
                    {t.subscription_status ? (
                      <Badge tone={SUB_TONE[t.subscription_status] ?? 'neutral'}>
                        {t.plan_name ?? t.plan} · {t.subscription_status.replace('_', ' ')}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">no subscription</span>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {t.students}
                    {t.licensed_students != null && (
                      <span
                        className={cn(
                          'ml-1.5 text-[12px]',
                          t.over_by > 0 ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        / {t.licensed_students}
                        {t.over_by > 0 && ` · ${t.over_by} over`}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {/* The number that predicts a cancellation better than any
                        other: a school three weeks in and still at 20%. */}
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            t.setup_percent < 60 ? 'bg-warning' : 'bg-success',
                          )}
                          style={{ width: `${t.setup_percent}%` }}
                        />
                      </div>
                      <span className="text-[12px] tabular-nums text-muted-foreground">
                        {t.setup_percent}%
                      </span>
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(t.renews_on)}</Td>
                  <Td className="text-muted-foreground">
                    {t.last_sign_in ? formatDate(t.last_sign_in) : 'never'}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        title="Work inside this school to reproduce a fault"
                        onClick={() => {
                          setActingInstitution(t.id)
                          qc.invalidateQueries()
                        }}
                      >
                        Open
                      </Button>
                      <ConfirmButton
                        question={`Issue a new password for ${t.name}'s administrator?`}
                        confirmLabel="Reset"
                        disabled={resetAdmin.isPending}
                        onConfirm={() => resetAdmin.mutate(t.id)}
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                      </ConfirmButton>
                      {t.subscription_status === 'suspended' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setStatus.mutate({ id: t.id, status: 'active' })}
                        >
                          Reactivate
                        </Button>
                      ) : (
                        <ConfirmButton
                          tone="danger"
                          question={`Suspend ${t.name}? Nobody there will be able to sign in.`}
                          confirmLabel="Suspend"
                          disabled={setStatus.isPending}
                          onConfirm={() => setStatus.mutate({ id: t.id, status: 'suspended' })}
                        >
                          Suspend
                        </ConfirmButton>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {(resetAdmin.isError || setStatus.isError) && (
            <div className="border-t px-5 py-3">
              <FormNotice error={resetAdmin.error ?? setStatus.error} />
            </div>
          )}
        </Card>
        )}

        {view === 'plans' && (
        <Card>
          <CardHeader
            title="Plans"
            description="What a school can be sold: the student cap, the modules included, and the price."
          />
          <Table head={['Plan', 'Price', 'Student cap', 'Modules', 'Schools on it']}>
            {(plans.data?.items ?? []).map((p) => (
              <tr key={p.code}>
                <Td className="font-medium">{p.name}</Td>
                <Td className="tabular-nums">{formatPaise(p.price_paise)}/yr</Td>
                <Td className="tabular-nums">{p.max_students ?? 'Unlimited'}</Td>
                <Td className="text-muted-foreground">
                  {p.modules.length === 0 ? 'Every module' : p.modules.join(', ')}
                </Td>
                <Td className="tabular-nums">{p.schools}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        )}
      </PageBody>
    </>
  )
}

/**
 * The handover.
 *
 * Deliberately loud and deliberately temporary. Only the hash is stored, so
 * this panel is the single moment the password exists in readable form; saying
 * that plainly is what stops a salesperson closing it and then telephoning
 * support an hour later.
 */
function HandoverCard({ h, onClose }: { h: Handover; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = `${h.school}\nSign in at this address\nUsername: ${h.sign_in_as}\nPassword: ${h.password}`

  return (
    <Card className="border-primary/40">
      <CardHeader
        title={`Credentials for ${h.school}`}
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
            <p className="text-[14px] font-medium">{h.admin_name}</p>
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
            {h.password}
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
            {copied ? 'Copied' : 'Copy for the school'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Card>
  )
}

function ProvisionForm({
  plans,
  onDone,
  onCancel,
}: {
  plans: Plan[]
  onDone: (h: Handover) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({
    school_name: '',
    district: '',
    state: 'Telangana',
    affiliation_board: 'BSE Telangana',
    plan_code: plans[0]?.code ?? 'starter',
    admin_name: '',
    admin_username: '',
    admin_email: '',
    admin_phone: '',
    trial_days: '30',
  })
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v })

  const create = useMutation({
    mutationFn: () =>
      api.post<Handover>('/api/v1/seller/tenants', {
        ...f,
        trial_days: Number(f.trial_days) || 30,
      }),
    onSuccess: onDone,
  })

  return (
    <Card>
      <CardHeader
        title="Provision a school"
        description="Creates the school, its first campus, its administrator and the subscription in one step."
      />
      <form
        className="px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <FormGrid>
          <Field label="School name" required wide>
            <Input
              value={f.school_name}
              onChange={(x) => set('school_name', x)}
              placeholder="Bharat Public School, Warangal"
            />
          </Field>
          <Field label="District">
            <Input value={f.district} onChange={(x) => set('district', x)} />
          </Field>
          <Field label="State">
            <Input value={f.state} onChange={(x) => set('state', x)} />
          </Field>
          <Field label="Board">
            <Input value={f.affiliation_board} onChange={(x) => set('affiliation_board', x)} />
          </Field>
          <Field label="Plan">
            <Select
              value={f.plan_code}
              onChange={(x) => set('plan_code', x)}
              options={plans.map((p) => ({
                value: p.code,
                label: `${p.name} — ${formatPaise(p.price_paise)}/yr`,
              }))}
            />
          </Field>
          <Field label="Trial days" hint="Before the first invoice falls due.">
            <Input value={f.trial_days} onChange={(x) => set('trial_days', x)} />
          </Field>
        </FormGrid>

        <div className="mt-6 border-t pt-5">
          <p className="mb-1 text-[15px] font-semibold">Who receives the credentials</p>
          <p className="mb-4 text-[13px] text-muted-foreground">
            The owner, principal or whoever the school nominates. They become its first
            administrator and can create everyone else.
          </p>
          <FormGrid>
            <Field label="Full name" required>
              <Input
                value={f.admin_name}
                onChange={(x) => set('admin_name', x)}
                placeholder="Sudha Rani"
              />
            </Field>
            <Field label="Username" hint="What they type to sign in. Short is kinder.">
              <Input
                value={f.admin_username}
                onChange={(x) => set('admin_username', x)}
                placeholder="sudha"
              />
            </Field>
            <Field label="Email">
              <Input type="email" value={f.admin_email} onChange={(x) => set('admin_email', x)} />
            </Field>
            <Field label="Phone">
              <Input value={f.admin_phone} onChange={(x) => set('admin_phone', x)} />
            </Field>
          </FormGrid>
        </div>

        <FormNotice error={create.error} />
        <div className="mt-5 flex items-center gap-2">
          <Button
            type="submit"
            disabled={create.isPending || !f.school_name.trim() || !f.admin_name.trim()}
          >
            {create.isPending ? 'Provisioning…' : 'Provision and show credentials'}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

/* Where each new school has got to.

   "Onboarding Progress" opened on the same directory as everything else, so
   the one question it exists to answer — who is stuck — had to be worked out
   by reading a percentage column. A pipeline answers it by grouping: a school
   is at one stage, and the stages are in the order a school actually goes
   through them.

   The stages are read from setup_percent rather than stored, because the
   product already knows how far setup has got and a second record of the same
   fact is a second thing to be wrong. */
const STAGES: { key: string; name: string; blurb: string; from: number; to: number }[] = [
  { key: 'signed', name: 'Signed, not started', blurb: 'Provisioned and nobody has begun', from: 0, to: 1 },
  { key: 'early', name: 'Setting up', blurb: 'Classes, staff and the year', from: 1, to: 60 },
  { key: 'importing', name: 'Loading data', blurb: 'Students and timetable going in', from: 60, to: 100 },
  { key: 'live', name: 'Live', blurb: 'Set up and in use', from: 100, to: 101 },
]

function OnboardingPipeline({ rows }: { rows: Tenant[] }) {
  const active = rows.filter((t) => t.status !== 'suspended')
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      {STAGES.map((st) => {
        const inStage = active.filter(
          (t) => t.setup_percent >= st.from && t.setup_percent < st.to,
        )
        return (
          <Card key={st.key} className="flex min-w-0 flex-col">
            <CardHeader title={`${st.name} · ${inStage.length}`} description={st.blurb} />
            <ul className="divide-y">
              {inStage.map((t) => {
                /* Stuck is a matter of time, not of position. A school two
                   days into loading data is doing exactly what it should; the
                   same school three weeks later is one nobody has rung. */
                const days = Math.floor(
                  (Date.now() - Date.parse(t.created_on)) / 86_400_000,
                )
                const stuck = st.key !== 'live' && days > 21
                return (
                  <li key={t.id} className="px-4 py-2.5">
                    <div className="truncate text-[14px] font-medium">{t.name}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                      <span className="tabular-nums">{t.setup_percent}%</span>
                      <span>·</span>
                      <span className={stuck ? 'text-destructive' : undefined}>
                        {Number.isFinite(days) ? `${days} days in` : 'just now'}
                      </span>
                      {stuck && <Badge tone="danger">stuck</Badge>}
                    </div>
                  </li>
                )
              })}
              {inStage.length === 0 && (
                <li className="px-4 py-3 text-[13px] text-muted-foreground">Nobody here.</li>
              )}
            </ul>
          </Card>
        )
      })}
    </div>
  )
}

/* Who may sign in, and nothing else.

   Suspension was a button at the end of a row of six other columns, which is
   the wrong shape for the one screen whose whole subject is access: the
   question is not "tell me about this school" but "should these people be able
   to get in this morning". Suspended first, because that is the list somebody
   is here to change. */
function AccessHub({
  rows,
  onSet,
  busy,
}: {
  rows: Tenant[]
  onSet: (id: string, status: string) => void
  busy: boolean
}) {
  const order = [...rows].sort((a, b) => {
    const rank = (t: Tenant) => (t.status === 'suspended' ? 0 : t.subscription_status === 'past_due' ? 1 : 2)
    return rank(a) - rank(b) || a.name.localeCompare(b.name)
  })
  const blocked = rows.filter((t) => t.status === 'suspended').length
  return (
    <Card>
      <CardHeader
        title="Who may sign in"
        description={
          blocked
            ? `${blocked} school${blocked === 1 ? '' : 's'} blocked. Suspending keeps every record — nothing is deleted, and nothing needs restarting.`
            : 'Every school can sign in. Suspending keeps every record — nothing is deleted, and nothing needs restarting.'
        }
      />
      <Table head={['School', 'Subscription', 'Students', 'Renews', 'Access', '']}>
        {order.map((t) => (
          <tr key={t.id}>
            <Td className="whitespace-nowrap font-medium">{t.name}</Td>
            <Td>
              {t.subscription_status ? (
                <Badge tone={SUB_TONE[t.subscription_status] ?? 'neutral'}>
                  {t.plan_name ?? t.plan} · {t.subscription_status.replace('_', ' ')}
                </Badge>
              ) : (
                <span className="text-muted-foreground">no subscription</span>
              )}
            </Td>
            <Td className="num">
              {t.students}
              {t.licensed_students != null && (
                <span className="text-muted-foreground"> / {t.licensed_students}</span>
              )}
            </Td>
            <Td className="num text-muted-foreground">
              {t.renews_on ? formatDate(t.renews_on) : '—'}
            </Td>
            <Td>
              <Badge tone={t.status === 'suspended' ? 'danger' : 'success'}>
                {t.status === 'suspended' ? 'blocked' : 'can sign in'}
              </Badge>
            </Td>
            <Td>
              {t.status === 'suspended' ? (
                <Button size="sm" disabled={busy} onClick={() => onSet(t.id, 'active')}>
                  Let them back in
                </Button>
              ) : (
                <ConfirmButton
                  size="sm"
                  variant="secondary"
                  tone="danger"
                  question={`Suspend ${t.name}? Nobody there will be able to sign in. Every record is kept.`}
                  confirmLabel="Suspend"
                  onConfirm={() => onSet(t.id, 'suspended')}
                  disabled={busy}
                >
                  Suspend
                </ConfirmButton>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

/* Seats sold against seats used, and what renews soon.

   Both halves are about a contract meeting reality, which is why they are one
   screen: a school 40 over its cap and renewing in a fortnight is one
   conversation, and reading it off two screens is how it becomes two. */
function CapacityBoard({ rows }: { rows: Tenant[] }) {
  const RENEWAL_WINDOW_DAYS = 45
  const soon = rows.filter((t) => {
    if (!t.renews_on) return false
    const days = (Date.parse(t.renews_on) - Date.now()) / 86_400_000
    return days >= 0 && days <= RENEWAL_WINDOW_DAYS
  })
  const over = rows.filter((t) => t.over_by > 0)
  return (
    <>
      <Card>
        <CardHeader
          title="Past the plan"
          description="Counted from the live headcount, not from what was sold — a school that admitted forty children this morning is forty seats heavier this morning."
        />
        {over.length === 0 ? (
          <EmptyState title="Every school inside its plan" body="Nothing to renegotiate today." />
        ) : (
          <Table head={['School', 'Plan', 'Students', 'Licensed', 'Over by']}>
            {over.map((t) => (
              <tr key={t.id}>
                <Td className="whitespace-nowrap font-medium">{t.name}</Td>
                <Td>{t.plan_name ?? t.plan ?? '—'}</Td>
                <Td className="num">{t.students}</Td>
                <Td className="num">{t.licensed_students ?? '—'}</Td>
                <Td className="num">
                  <Badge tone="danger">{t.over_by} over</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Renewing soon"
          description={`Contracts due within ${RENEWAL_WINDOW_DAYS} days.`}
        />
        {soon.length === 0 ? (
          <EmptyState title="Nothing due" body={`No contract renews in the next ${RENEWAL_WINDOW_DAYS} days.`} />
        ) : (
          <Table head={['School', 'Plan', 'Renews', 'Students', 'Status']}>
            {soon.map((t) => (
              <tr key={t.id}>
                <Td className="whitespace-nowrap font-medium">{t.name}</Td>
                <Td>{t.plan_name ?? t.plan ?? '—'}</Td>
                <Td className="num">{t.renews_on ? formatDate(t.renews_on) : '—'}</Td>
                <Td className="num">{t.students}</Td>
                <Td>
                  <Badge tone={t.over_by > 0 ? 'warning' : 'neutral'}>
                    {t.over_by > 0 ? `${t.over_by} over its cap` : 'within plan'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

/* What each school is worth, and when it is next due.

   The ledger opened on the directory — the same table as four other entries,
   with the same six columns about students and setup. A ledger is not a list
   of schools; it is a list of money, and the columns that belong on it are the
   ones the directory has no room for: what the contract is worth a year, what
   that is a month, and when it comes round again.

   No payment feed yet, because there is no gateway. When one is connected this
   is where its receipts land, and the shape below is already the shape they
   would sit in. */
function LedgerBoard({ rows, plans }: { rows: Tenant[]; plans: Plan[] }) {
  const priced = rows
    .map((t) => {
      const plan = plans.find((p) => p.code === t.plan)
      const annual = t.subscription_status === 'active' && plan ? plan.price_paise : 0
      return { t, plan, annual }
    })
    .sort((a, b) => b.annual - a.annual)

  const annualTotal = priced.reduce((n, x) => n + x.annual, 0)
  const unbilled = priced.filter((x) => x.annual === 0).length

  return (
    <Card>
      <CardHeader
        title="The book"
        description={
          `${formatPaise(annualTotal)} a year across ${priced.length - unbilled} paying schools`
          + (unbilled ? ` · ${unbilled} bringing in nothing yet` : '')
        }
      />
      <Table head={['School', 'Plan', 'Status', 'A year', 'A month', 'Renews']}>
        {priced.map(({ t, plan, annual }) => (
          <tr key={t.id}>
            <Td className="whitespace-nowrap font-medium">{t.name}</Td>
            <Td className="whitespace-nowrap">{plan?.name ?? t.plan ?? '—'}</Td>
            <Td>
              {t.subscription_status ? (
                <Badge tone={SUB_TONE[t.subscription_status] ?? 'neutral'}>
                  {t.subscription_status.replace('_', ' ')}
                </Badge>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </Td>
            <Td className="num">{annual ? formatPaise(annual) : '—'}</Td>
            {/* The same contract expressed two ways, because a vendor reads
                the book monthly and sells it annually. */}
            <Td className="num text-muted-foreground">
              {annual ? formatPaise(Math.round(annual / 12)) : '—'}
            </Td>
            <Td className="num text-muted-foreground">
              {t.renews_on ? formatDate(t.renews_on) : '—'}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
