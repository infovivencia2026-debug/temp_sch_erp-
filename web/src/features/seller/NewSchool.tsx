import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  Badge, Button, Card, CardHeader, Field, FormGrid, FormNotice, Input, Select,
} from '@/components/ui'
import { cn, formatPaise } from '@/lib/utils'

/* Seller → Schools → New school.

   One form, one click. The Worker accepts the request, reserves the address
   and queues the work (worker/src/services/provision.ts); this screen polls
   the request through its stages and, when the school is ready, shows the
   administrator's one-time password. The password comes back once, in the
   answer to the POST, and is held only in this component's memory. */

export interface ProvisionStatus {
  id: string
  slug: string
  country: string
  name: string
  short_name: string
  plan_code: string | null
  admin_name: string
  sign_in_as: string | null
  institution_id: string
  stage: 'queued' | 'creating_database' | 'applying_schema' | 'seeding' | 'attaching' | 'ready' | 'failed'
  failed_stage: string | null
  error: string | null
  schema_done: number
  schema_total: number
  attempts: number
  binding_live: boolean
  sign_in_path: string
  created_at: string
}

interface Created extends ProvisionStatus { password: string; note: string }

interface PlanOption { code: string; name: string; price_paise: number }

const STEPS: { key: string; label: string }[] = [
  { key: 'creating_database', label: 'Creating database' },
  { key: 'applying_schema', label: 'Applying schema' },
  { key: 'seeding', label: 'Seeding roles and administrator' },
  { key: 'attaching', label: 'Attaching to the platform' },
  { key: 'ready', label: 'Ready' },
]

const slugOf = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')

function useDebounced<T>(v: T, ms = 350): T {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function NewSchool({ plans, onClose }: { plans: PlanOption[]; onClose: () => void }) {
  const qc = useQueryClient()
  // The request being watched, and its password when this session created it.
  const [watching, setWatching] = useState<{ id: string; password?: string; note?: string } | null>(null)

  if (watching) {
    return (
      <NewSchoolProgress
        id={watching.id}
        password={watching.password}
        note={watching.note}
        onClose={() => {
          qc.invalidateQueries({ queryKey: ['seller-tenants'] })
          qc.invalidateQueries({ queryKey: ['seller-provisioning'] })
          setWatching(null)
          onClose()
        }}
        onAnother={() => setWatching(null)}
      />
    )
  }
  return (
    <>
      <Unfinished onOpen={(id) => setWatching({ id })} />
      <NewSchoolForm
        plans={plans}
        onCreated={(c) => {
          qc.invalidateQueries({ queryKey: ['seller-provisioning'] })
          setWatching({ id: c.id, password: c.password, note: c.note })
        }}
        onCancel={onClose}
      />
    </>
  )
}

/** Requests still running or failed, so a closed tab does not lose them. */
function Unfinished({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['seller-provisioning'],
    queryFn: () => api.get<List<ProvisionStatus>>('/api/v1/seller/provisioning'),
    refetchInterval: 5000,
  })
  const rows = (q.data?.items ?? []).filter((r) => r.stage !== 'ready')
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader title="Schools being created" description="Open one to follow it, retry it or discard it." />
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{r.name}</span>
            <span className="font-mono text-[12px] text-muted-foreground">/{r.country}/{r.slug}</span>
            <Badge tone={r.stage === 'failed' ? 'danger' : 'info'}>
              {r.stage === 'failed' ? 'Failed' : STEPS.find((s) => s.key === r.stage)?.label ?? 'Queued'}
            </Badge>
            <Button size="sm" variant="secondary" onClick={() => onOpen(r.id)}>Open</Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function NewSchoolForm({
  plans,
  onCreated,
  onCancel,
}: {
  plans: PlanOption[]
  onCreated: (c: Created) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({
    school_name: '',
    short_name: '',
    slug: '',
    plan_code: plans[0]?.code ?? '',
    trial_days: '30',
    district: '',
    state: 'Telangana',
    affiliation_board: '',
    admin_name: '',
    admin_email: '',
    admin_phone: '',
    admin_username: '',
  })
  const [slugEdited, setSlugEdited] = useState(false)
  const [brandOpen, setBrandOpen] = useState(false)
  const [brand, setBrand] = useState({ primary_color: '', accent_color: '', tagline: '', support_email: '', support_phone: '' })
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }))

  useEffect(() => {
    if (!f.plan_code && plans[0]) set('plan_code', plans[0].code)
  }, [plans, f.plan_code])

  const slug = slugEdited ? f.slug : slugOf(f.school_name)
  const debouncedSlug = useDebounced(slug)
  const check = useQuery({
    queryKey: ['seller-provisioning-slug', debouncedSlug],
    queryFn: () =>
      api.get<{ slug: string; available: boolean; reason: string | null }>(
        `/api/v1/seller/provisioning/slug?slug=${encodeURIComponent(debouncedSlug)}`,
      ),
    enabled: debouncedSlug !== '',
  })

  const create = useMutation({
    mutationFn: () =>
      api.post<Created>('/api/v1/seller/provisioning', {
        ...f,
        slug,
        trial_days: Number(f.trial_days) || 30,
        branding: Object.fromEntries(Object.entries(brand).filter(([, v]) => v.trim() !== '')),
      }),
    onSuccess: onCreated,
  })

  const slugBad = check.data && check.data.slug === slug && !check.data.available
  const canSubmit =
    !create.isPending && f.school_name.trim() !== '' && f.admin_name.trim() !== '' && slug !== '' && !slugBad &&
    (f.admin_email.trim() !== '' || f.admin_phone.trim() !== '' || f.admin_username.trim() !== '')

  return (
    <Card>
      <CardHeader
        title="New school"
        description="Creates the school's own database, its roles, first campus, administrator and subscription. Takes about a minute; you can watch it here."
      />
      <form
        className="px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit) create.mutate()
        }}
      >
        <FormGrid>
          <Field label="School name" required wide>
            <Input value={f.school_name} onChange={(x) => set('school_name', x)} placeholder="Bharat Public School, Warangal" />
          </Field>
          <Field label="Short name" hint="Initials are used when left empty.">
            <Input value={f.short_name} onChange={(x) => set('short_name', x)} placeholder="BPS" />
          </Field>
          <Field
            label="Address (slug)"
            hint={
              slugBad
                ? check.data!.reason ?? 'Not available'
                : slug
                  ? `Sign-in page: /in/${slug}${check.data?.available && check.data.slug === slug ? ' · available' : ''}`
                  : 'Lowercase letters, digits and hyphens.'
            }
          >
            <Input
              value={slug}
              onChange={(x) => {
                setSlugEdited(true)
                set('slug', x.toLowerCase().replace(/[^a-z0-9-]/g, ''))
              }}
              placeholder="bharat-public-school"
              className={cn(slugBad && 'border-destructive')}
            />
          </Field>
          <Field label="Plan">
            <Select
              value={f.plan_code}
              onChange={(x) => set('plan_code', x)}
              options={plans.map((p) => ({ value: p.code, label: `${p.name} · ${formatPaise(p.price_paise)}/yr` }))}
            />
          </Field>
          <Field label="Trial days" hint="Before the first invoice falls due.">
            <Input value={f.trial_days} onChange={(x) => set('trial_days', x.replace(/\D/g, ''))} />
          </Field>
          <Field label="District">
            <Input value={f.district} onChange={(x) => set('district', x)} />
          </Field>
          <Field label="State">
            <Input value={f.state} onChange={(x) => set('state', x)} />
          </Field>
          <Field label="Board">
            <Input value={f.affiliation_board} onChange={(x) => set('affiliation_board', x)} placeholder="CBSE" />
          </Field>
        </FormGrid>

        <div className="mt-6 border-t pt-5">
          <p className="mb-1 text-[15px] font-semibold">First administrator</p>
          <p className="mb-4 text-[13px] text-muted-foreground">
            The owner or principal. Give at least one of email, phone or username: it is what they sign in with.
          </p>
          <FormGrid>
            <Field label="Full name" required>
              <Input value={f.admin_name} onChange={(x) => set('admin_name', x)} placeholder="Sudha Rani" />
            </Field>
            <Field label="Email">
              <Input type="email" value={f.admin_email} onChange={(x) => set('admin_email', x)} />
            </Field>
            <Field label="Phone">
              <Input value={f.admin_phone} onChange={(x) => set('admin_phone', x)} />
            </Field>
            <Field label="Username" hint="Optional. Short is kinder.">
              <Input value={f.admin_username} onChange={(x) => set('admin_username', x)} placeholder="sudha" />
            </Field>
          </FormGrid>
        </div>

        <div className="mt-6 border-t pt-5">
          <button
            type="button"
            className="text-[14px] font-semibold text-primary hover:underline"
            onClick={() => setBrandOpen((o) => !o)}
          >
            {brandOpen ? 'Hide branding' : 'Branding (optional)'}
          </button>
          {brandOpen && (
            <div className="mt-4">
              <FormGrid>
                <Field label="Primary colour" hint="#1e40af">
                  <Input value={brand.primary_color} onChange={(x) => setBrand({ ...brand, primary_color: x })} placeholder="#1e40af" />
                </Field>
                <Field label="Accent colour">
                  <Input value={brand.accent_color} onChange={(x) => setBrand({ ...brand, accent_color: x })} placeholder="#f59e0b" />
                </Field>
                <Field label="Tagline" wide>
                  <Input value={brand.tagline} onChange={(x) => setBrand({ ...brand, tagline: x })} />
                </Field>
                <Field label="Support email">
                  <Input type="email" value={brand.support_email} onChange={(x) => setBrand({ ...brand, support_email: x })} />
                </Field>
                <Field label="Support phone">
                  <Input value={brand.support_phone} onChange={(x) => setBrand({ ...brand, support_phone: x })} />
                </Field>
              </FormGrid>
              <p className="mt-2 text-[12px] text-muted-foreground">The logo and the rest are set later in Branding.</p>
            </div>
          )}
        </div>

        <FormNotice error={create.error} />
        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={!canSubmit} pending={create.isPending}>
            Create school
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

export function NewSchoolProgress({
  id,
  password,
  note,
  onClose,
  onAnother,
}: {
  id: string
  password?: string
  note?: string
  onClose: () => void
  onAnother: () => void
}) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const q = useQuery({
    queryKey: ['seller-provisioning', id],
    queryFn: () => api.get<ProvisionStatus>(`/api/v1/seller/provisioning/${id}`),
    refetchInterval: (query) => {
      const s = query.state.data?.stage
      return s === 'ready' || s === 'failed' ? false : 1500
    },
  })
  const retry = useMutation({
    mutationFn: () => api.post<ProvisionStatus>(`/api/v1/seller/provisioning/${id}/retry`),
    onSuccess: (d) => qc.setQueryData(['seller-provisioning', id], d),
  })
  const discard = useMutation({
    mutationFn: () => api.del(`/api/v1/seller/provisioning/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['seller-provisioning'] })
      onAnother()
    },
  })
  const s = q.data
  const ready = s?.stage === 'ready'

  useEffect(() => {
    if (ready) qc.invalidateQueries({ queryKey: ['seller-tenants'] })
  }, [ready, qc])

  const current = s ? (s.stage === 'failed' ? s.failed_stage ?? '' : s.stage) : 'queued'
  const idx = STEPS.findIndex((x) => x.key === current)
  const signInUrl = s ? `${window.location.origin}${s.sign_in_path}` : ''

  return (
    <Card className={cn(ready && 'border-primary/40')}>
      <CardHeader
        title={s ? (ready ? `${s.name} is ready` : `Creating ${s.name}`) : 'Creating the school'}
        description={s ? `/${s.country}/${s.slug}` : undefined}
        action={
          <Button variant="ghost" size="sm" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <div className="px-5 py-5">
        <ol className="space-y-2.5">
          {STEPS.map((step, i) => {
            const failedHere = s?.stage === 'failed' && i === idx
            const done = ready || (idx >= 0 && i < idx)
            const active = !ready && !failedHere && i === idx
            return (
              <li key={step.key} className="flex items-center gap-2.5 text-[14px]">
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    done && 'border-success bg-success text-white',
                    failedHere && 'border-destructive bg-destructive text-white',
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : failedHere ? <X className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                </span>
                <span className={cn(!done && !active && !failedHere && 'text-muted-foreground', failedHere && 'text-destructive')}>
                  {step.label}
                  {step.key === 'applying_schema' && s && s.schema_total > 0 && (active || failedHere) && (
                    <span className="ml-1.5 text-muted-foreground">
                      {s.schema_done}/{s.schema_total}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>

        <FormNotice error={q.error ?? retry.error ?? discard.error} />

        {s?.stage === 'failed' && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
            <p className="text-[13px] font-medium text-destructive">Failed while {STEPS[idx]?.label.toLowerCase() ?? s.failed_stage}</p>
            <p className="mt-1 break-words font-mono text-[12px]">{s.error}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => retry.mutate()} pending={retry.isPending}>
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => discard.mutate()} pending={discard.isPending}>
                <Trash2 className="h-3.5 w-3.5" />
                Discard
              </Button>
            </div>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Retry resumes where it stopped. Discard releases the address and deletes the half-made database.
            </p>
          </div>
        )}

        {ready && s && (
          <div className="mt-6 border-t pt-5">
            <FormGrid>
              <Field label="Hand to">
                <p className="text-[14px] font-medium">{s.admin_name}</p>
              </Field>
              <Field label="They sign in as">
                <p className="font-mono text-[15px]">{s.sign_in_as}</p>
              </Field>
            </FormGrid>
            {password ? (
              <div className="mt-4">
                <p className="mb-1.5 text-[13px] font-medium text-secondary-foreground">One-time password</p>
                <p className="rounded-md border bg-muted px-3 py-2.5 font-mono text-[18px] tracking-wider">{password}</p>
                {note && <p className="mt-2 text-[12px] text-muted-foreground">{note}</p>}
              </div>
            ) : (
              <p className="mt-4 text-[13px] text-muted-foreground">
                The one-time password was shown to whoever created this school. Use Reset administrator on the school's row for a new one.
              </p>
            )}
            {!s.binding_live && (
              <p className="mt-3 text-[12px] text-muted-foreground">
                Served through the Cloudflare D1 API until the next deploy attaches it (scripts/provision-school.sh --attach).
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {password && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigator.clipboard?.writeText(
                      `${s.name}\nSign in at ${signInUrl}\nUsername: ${s.sign_in_as}\nPassword: ${password}`,
                    )
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied ? 'Copied' : 'Copy for the school'}
                </Button>
              )}
              <a
                href={s.sign_in_path}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Sign-in page
              </a>
              <Button variant="ghost" onClick={onAnother}>
                Create another
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
