import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Building2, Copy, KeyRound, Plus, TrendingUp, X } from 'lucide-react'
import { api, setActingInstitution, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
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
  tenant_directory: 'directory',
  provision_new_school: 'provision',
  tenant_access_control: 'access',
  onboarding_progress: 'onboarding',
  plans_pricing: 'plans',
  subscription_ledger: 'ledger',
  license_capacity_tracking: 'capacity',
}

const TITLES: Record<SellerView, [string, string, string]> = {
  directory: [
    'Schools',
    'Every school on this installation',
    'What each one pays, how many children it has on the roll, and how far it has got.',
  ],
  provision: [
    'Provision a school',
    'Schools',
    'Create a school, its first campus and its first administrator in one step. The credentials '
      + 'are shown once, to hand over.',
  ],
  access: [
    'Tenant Access Control',
    'Schools',
    'Who may sign in and who may not. Suspending blocks sign-in and keeps every record; nothing '
      + 'is deleted and nothing needs restarting.',
  ],
  onboarding: [
    'Onboarding Progress',
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
    'License & Capacity Tracking',
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

  const live = rows.filter((t) => t.subscription_status === 'active').length
  const trials = rows.filter((t) => t.subscription_status === 'trial').length
  const suspended = rows.filter((t) => t.status === 'suspended').length

  /* The onboarding pipeline: schools that have bought and are not yet running.
     Not the same as "stalled" — a school three days in at 40% is progressing,
     and counting it as a problem is how a vendor learns to ignore the number.
     Both are shown, because the second is the one somebody has to act on. */
  const onboarding = rows.filter(
    (t) => t.setup_percent < 100 && t.status !== 'suspended',
  ).length
  const stalled = rows.filter(
    (t) => t.setup_percent < 60 && t.status !== 'suspended',
  ).length

  /* Monthly, not annual.

     This totalled a year's subscriptions and called it "Annual value", on a
     panel whose question is what comes in this month. A plan priced per year
     is divided by twelve rather than dropped, so a mixed book of monthly and
     annual contracts adds up to one comparable figure — which is what MRR
     means and why every SaaS vendor reads it. */
  const mrrPaise = rows.reduce((n, t) => {
    if (t.subscription_status !== 'active') return n
    const p = plans.data?.items.find((x) => x.code === t.plan)
    if (!p) return n
    return n + Math.round(p.price_paise / 12)
  }, 0)

  /* Whether the thing all of them run on is well.

     There was no health number here at all: a vendor could be looking at a
     panel of green revenue while a school's sign-ins were failing. Schools
     nobody has signed into for a fortnight is the cheapest honest proxy — it
     catches an outage, a lapsed rollout and a school that has quietly stopped
     using the product, all of which the vendor wants to know about today. */
  const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000
  const quiet = rows.filter((t) => {
    if (t.status === 'suspended') return false
    if (!t.last_sign_in) return true
    const at = Date.parse(t.last_sign_in)
    return Number.isFinite(at) && Date.now() - at > FORTNIGHT_MS
  }).length

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
        <CellGrid cols={4}>
          <Stat
            label="Active school tenants"
            value={live}
            icon={Building2}
            hint={
              [
                trials ? `${trials} on trial` : '',
                suspended ? `${suspended} suspended` : '',
              ]
                .filter(Boolean)
                .join(' \u00b7 ') || `${rows.length} in total`
            }
          />
          <Stat
            label="In onboarding"
            value={onboarding}
            delta={
              stalled
                ? { value: `${stalled} stalled under 60%`, positive: false }
                : { value: 'All progressing', positive: true }
            }
          />
          <Stat
            label="Monthly recurring revenue"
            value={formatPaise(mrrPaise)}
            icon={TrendingUp}
            hint="Annual plans counted as a twelfth"
          />
          <Stat
            label="Infrastructure health"
            value={quiet ? `${quiet} quiet` : 'All active'}
            icon={Activity}
            delta={
              quiet
                ? { value: 'No sign-in in a fortnight', positive: false }
                : { value: 'Every school signed in recently', positive: true }
            }
          />
        </CellGrid>

        {handover && <HandoverCard h={handover} onClose={() => setHandover(null)} />}

        {creating && (
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

        <Card>
          <CardHeader title="Directory" description={`${rows.length} schools`} />
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

        <Card>
          <CardHeader title="Plans" description="What the schools above are sold" />
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
