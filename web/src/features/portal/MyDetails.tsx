import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Input, Field, Select, Badge,
  ErrorState, EmptyState, FormNotice,
} from '@/components/ui'
import { Freshness, ScreenSkeleton } from './screen-state'
import { useChildren, childOptions, readyFor } from './use-children'

/* Update my details.
 *
 * The school's record of the family, as the office sees it on Student 360,
 * with the parts the family owns left open to edit: the home address, the
 * child's blood group, and each parent's own name, phone, email and
 * occupation. It saves to the same rows the office reads, so the correction
 * is on Student 360 the moment it is made — and the next absentee call or fee
 * reminder goes to the number that actually rings.
 *
 * The child's name, date of birth, admission number and class are shown and
 * not editable: a parent spots the mistake here and the office fixes it. */

interface Guardian {
  id: string
  full_name: string
  relation: string
  phone: string
  email?: string | null
  occupation?: string | null
  is_primary: boolean
  is_emergency: boolean
  mine: boolean
}

interface Details {
  student_id: string
  full_name: string
  admission_no: string
  class_name?: string | null
  section_name?: string | null
  date_of_birth?: string | null
  gender?: string | null
  blood_group?: string | null
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  pincode?: string | null
  guardians: Guardian[]
}

interface Draft {
  blood_group: string
  address_line1: string
  address_line2: string
  city: string
  state: string
  pincode: string
  guardians: { id: string; full_name: string; phone: string; email: string; occupation: string }[]
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((v) => ({ value: v, label: v }))

function toDraft(d: Details): Draft {
  return {
    blood_group: d.blood_group ?? '',
    address_line1: d.address_line1 ?? '',
    address_line2: d.address_line2 ?? '',
    city: d.city ?? '',
    state: d.state ?? '',
    pincode: d.pincode ?? '',
    guardians: d.guardians.map((g) => ({
      id: g.id,
      full_name: g.full_name,
      phone: g.phone,
      email: g.email ?? '',
      occupation: g.occupation ?? '',
    })),
  }
}

function relationLabel(r: string) {
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Guardian'
}

export default function MyDetails() {
  const qc = useQueryClient()
  const { children: kids, query: kidsQuery, studentId, setChosen } = useChildren()
  const ready = readyFor(kids, studentId)

  const details = useQuery({
    queryKey: ['family-details', studentId],
    queryFn: () => api.get<Details>(`/api/v1/portal/family-details?student_id=${studentId}`),
    enabled: ready && !!studentId,
  })

  const [draft, setDraft] = useState<Draft | null>(null)
  // A fresh record (child switched, or a save came back) becomes the new
  // baseline; edits in progress on another child are not carried over.
  useEffect(() => {
    if (details.data) setDraft(toDraft(details.data))
  }, [details.data])

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.put<{ ok: boolean }>('/api/v1/portal/family-details', { student_id: studentId, ...d }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['family-details', studentId] })
      qc.invalidateQueries({ queryKey: ['my-students'] })
    },
  })

  const d = details.data
  const dirty = !!d && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(d))

  const setField = (patch: Partial<Draft>) => setDraft((p) => (p ? { ...p, ...patch } : p))
  const setGuardian = (i: number, patch: Partial<Draft['guardians'][number]>) =>
    setDraft((p) =>
      p ? { ...p, guardians: p.guardians.map((g, j) => (j === i ? { ...g, ...patch } : g)) } : p,
    )

  return (
    <>
      <PageHead
        eyebrow="Profile"
        title="Update my details"
        actions={
          kids.length > 1 && (
            <Select value={studentId} onChange={setChosen} placeholder="Which child?" options={childOptions(kids)} />
          )
        }
      />
      <Freshness query={details} />
      <PageBody>
        {kidsQuery.isLoading ? (
          <ScreenSkeleton rows={6} label="Loading your children" />
        ) : kidsQuery.error ? (
          <ErrorState error={kidsQuery.error} />
        ) : kids.length === 0 ? (
          <EmptyState title="No child is linked to this account yet." />
        ) : !ready ? (
          <EmptyState title="Choose a child above." />
        ) : details.isLoading || !d || !draft ? (
          <ScreenSkeleton rows={8} label="Loading the record" />
        ) : details.error ? (
          <ErrorState error={details.error} />
        ) : (
          <>
            <Card>
              <CardHeader
                title={d.full_name}
                description="What the school holds. Name, date of birth, admission number and class change through the office."
              />
              <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
                <Ro label="Admission no." value={d.admission_no} mono />
                <Ro label="Class" value={d.class_name ? `${d.class_name} ${d.section_name ?? ''}`.trim() : '-'} />
                <Ro label="Date of birth" value={d.date_of_birth ?? '-'} />
                <Ro label="Gender" value={d.gender ? relationLabel(d.gender) : '-'} />
              </dl>
            </Card>

            <Card>
              <CardHeader title="Home" description="Where the child lives. Used for the bus stop, the post and the emergency card." />
              <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
                <Field label="Blood group">
                  <Select value={draft.blood_group} onChange={(v) => setField({ blood_group: v })} placeholder="Not recorded" options={BLOOD_GROUPS} />
                </Field>
                <div className="hidden sm:block" />
                <Field label="Address line 1" wide>
                  <Input value={draft.address_line1} onChange={(v) => setField({ address_line1: v })} placeholder="House no., street" />
                </Field>
                <Field label="Address line 2" wide>
                  <Input value={draft.address_line2} onChange={(v) => setField({ address_line2: v })} placeholder="Area, landmark" />
                </Field>
                <Field label="City / town">
                  <Input value={draft.city} onChange={(v) => setField({ city: v })} />
                </Field>
                <Field label="State">
                  <Input value={draft.state} onChange={(v) => setField({ state: v })} />
                </Field>
                <Field label="PIN code">
                  <Input value={draft.pincode} onChange={(v) => setField({ pincode: v })} />
                </Field>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Parents & guardians"
                description="The phone here is where the school's calls and alerts go. Keep it the number that rings."
              />
              <div className="divide-y">
                {d.guardians.length === 0 && (
                  <p className="px-5 py-4 text-[13px] text-muted-foreground">
                    No guardian is on record for this child. Ask the office to add one.
                  </p>
                )}
                {d.guardians.map((g, i) => (
                  <div key={g.id} className="px-5 py-4">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-medium">{relationLabel(g.relation)}</span>
                      {g.mine && <Badge tone="info">you</Badge>}
                      {g.is_primary && <Badge>primary contact</Badge>}
                      {g.is_emergency && <Badge tone="warning">emergency contact</Badge>}
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Full name" required>
                        <Input value={draft.guardians[i]?.full_name ?? ''} onChange={(v) => setGuardian(i, { full_name: v })} />
                      </Field>
                      <Field label="Mobile number" required>
                        <Input type="tel" value={draft.guardians[i]?.phone ?? ''} onChange={(v) => setGuardian(i, { phone: v })} />
                      </Field>
                      <Field label="Email">
                        <Input type="email" value={draft.guardians[i]?.email ?? ''} onChange={(v) => setGuardian(i, { email: v })} />
                      </Field>
                      <Field label="Occupation">
                        <Input value={draft.guardians[i]?.occupation ?? ''} onChange={(v) => setGuardian(i, { occupation: v })} />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => draft && save.mutate(draft)} disabled={!dirty || save.isPending} pending={save.isPending}>
                Save changes
              </Button>
              {dirty && (
                <Button variant="secondary" onClick={() => setDraft(toDraft(d))} disabled={save.isPending}>
                  Discard
                </Button>
              )}
              {save.isSuccess && !dirty && <FormNotice ok="Saved. The office sees this on Student 360 now." />}
              {save.isError && <FormNotice error={save.error} />}
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}

function Ro({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono' : ''}>{value}</dd>
    </div>
  )
}
