import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Pencil, Plus, UserPlus, X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Select, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* School groups, on the seller's Schools screen.

   One organisation owning several schools ("Yajur Branch 1", "Yajur Branch
   2"). Every school keeps its own records; the group is how the seller says
   they belong together, and who the group's admins are. A group admin signs in
   at one of the schools, switches between the group's schools from the header,
   and reads the combined report at /group-report. The numbers here are read
   live from each school: roll, staff and fees collected this month. */

export interface GroupSchool {
  id: string
  name: string
  short_name: string
  status: string
  students: number
  staff: number
  collected_month_paise: number
  outstanding_paise: number
  attendance_pct?: number
  reachable: boolean
}
interface GroupAdmin {
  user_id: string
  full_name: string
  email?: string
  phone?: string
  status: string
  home_institution_id: string
  home_school: string
}
export interface SchoolGroup {
  id: string
  name: string
  created_at: string
  schools: GroupSchool[]
  totals: { students: number; staff: number; collected_month_paise: number; outstanding_paise: number }
  admins: GroupAdmin[]
}
interface GroupList extends List<SchoolGroup> { ungrouped: { id: string; name: string }[] }
interface Handover { full_name: string; sign_in_as?: string; temporary_password?: string; created: boolean; note: string }

const KEY = ['seller-school-groups']

export function SchoolGroups({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [handover, setHandover] = useState<Handover | null>(null)
  const groups = useQuery({ queryKey: KEY, queryFn: () => api.get<GroupList>('/api/v1/seller/school-groups') })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: KEY })
    qc.invalidateQueries({ queryKey: ['seller-tenants'] })
  }
  const create = useMutation({
    mutationFn: () => api.post('/api/v1/seller/school-groups', { name: name.trim() }),
    onSuccess: () => { setName(''); refresh() },
  })

  return (
    <Card>
      <CardHeader
        title="School groups"
        description="Schools owned by one organisation. Each keeps its own records; the group's admins can switch between them and see combined numbers."
        action={<Button size="sm" variant="ghost" onClick={onClose}><X className="h-3.5 w-3.5" /></Button>}
      />
      <div className="space-y-5 px-5 py-5">
        {handover && <HandoverCard h={handover} onClose={() => setHandover(null)} />}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate() }}
        >
          <div className="min-w-[14rem] flex-1">
            <Field label="New group">
              <Input value={name} onChange={setName} placeholder="Yajur Group of Schools" />
            </Field>
          </div>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            <Plus className="h-3.5 w-3.5" /> Create group
          </Button>
        </form>
        <FormNotice error={create.error} />

        {groups.isLoading ? (
          <SkeletonTable columns={4} />
        ) : groups.error ? (
          <ErrorState error={groups.error} />
        ) : (groups.data?.items ?? []).length === 0 ? (
          <EmptyState title="No groups yet" body="Create a group, then add the schools the organisation owns." />
        ) : (
          groups.data!.items.map((g) => (
            <GroupCard key={g.id} g={g} ungrouped={groups.data!.ungrouped} onChange={refresh} onHandover={setHandover} />
          ))
        )}
      </div>
    </Card>
  )
}

function GroupCard({ g, ungrouped, onChange, onHandover }: {
  g: SchoolGroup
  ungrouped: { id: string; name: string }[]
  onChange: () => void
  onHandover: (h: Handover) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [adminForm, setAdminForm] = useState(false)
  const base = `/api/v1/seller/school-groups/${g.id}`

  const rename = useMutation({ mutationFn: () => api.put(base, { name: renaming }), onSuccess: () => { setRenaming(null); onChange() } })
  const remove = useMutation({ mutationFn: () => api.del(base), onSuccess: onChange })
  const addSchool = useMutation({ mutationFn: () => api.post(`${base}/schools`, { institution_id: adding }), onSuccess: () => { setAdding(''); onChange() } })
  const dropSchool = useMutation({ mutationFn: (id: string) => api.del(`${base}/schools/${id}`), onSuccess: onChange })
  const dropAdmin = useMutation({ mutationFn: (id: string) => api.del(`${base}/admins/${id}`), onSuccess: onChange })

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        {renaming !== null ? (
          <form className="flex flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate() }}>
            <Input value={renaming} onChange={setRenaming} />
            <Button size="sm" type="submit" disabled={!renaming.trim() || rename.isPending}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
          </form>
        ) : (
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">{g.name}</p>
            <p className="text-[12.5px] text-muted-foreground">
              {g.schools.length} {g.schools.length === 1 ? 'school' : 'schools'} · {g.totals.students} students ·{' '}
              {g.totals.staff} staff · {formatPaise(g.totals.collected_month_paise)} collected this month
            </p>
          </div>
        )}
        {renaming === null && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" title="Rename" onClick={() => setRenaming(g.name)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <ConfirmButton
              tone="danger"
              question={`Delete ${g.name}? The schools and their records stay; the group's admins lose access to the schools they reached through it.`}
              confirmLabel="Delete group"
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            >
              Delete
            </ConfirmButton>
          </div>
        )}
      </div>

      {g.schools.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">No schools in this group yet.</p>
      ) : (
        <Table head={['School', 'Students', 'Staff', 'Collected this month', '']}>
          {g.schools.map((s) => (
            <tr key={s.id}>
              <Td className="whitespace-nowrap font-medium">
                {s.name}
                {s.status !== 'active' && <Badge tone="danger">{s.status}</Badge>}
                {!s.reachable && <span className="block text-[12px] font-normal text-muted-foreground">database not reachable</span>}
              </Td>
              <Td className="num">{s.students}</Td>
              <Td className="num">{s.staff}</Td>
              <Td className="num">{formatPaise(s.collected_month_paise)}</Td>
              <Td className="whitespace-nowrap">
                <div className="flex justify-end">
                  <ConfirmButton
                    label="Remove from group"
                    question={`Take ${s.name} out of ${g.name}? Its records are untouched.`}
                    confirmLabel="Remove"
                    disabled={dropSchool.isPending}
                    onConfirm={() => dropSchool.mutate(s.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </ConfirmButton>
                </div>
              </Td>
            </tr>
          ))}
          <tr>
            <Td className="font-semibold">Total</Td>
            <Td className="num font-semibold">{g.totals.students}</Td>
            <Td className="num font-semibold">{g.totals.staff}</Td>
            <Td className="num font-semibold">{formatPaise(g.totals.collected_month_paise)}</Td>
            <Td />
          </tr>
        </Table>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t px-4 py-3">
        <div className="min-w-[14rem] flex-1">
          <Field label="Add a school" hint="Only schools not already in a group are listed.">
            <Select
              value={adding}
              onChange={setAdding}
              allowCustom={false}
              placeholder={ungrouped.length ? 'Pick a school' : 'Every school is in a group'}
              options={ungrouped.map((u) => ({ value: u.id, label: u.name }))}
            />
          </Field>
        </div>
        <Button size="sm" disabled={!adding || addSchool.isPending} onClick={() => addSchool.mutate()}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      <div className="border-t px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-secondary-foreground">
            Group admins
            <span className="ml-1.5 font-normal text-muted-foreground">
              switch between these schools and see the combined report
            </span>
          </p>
          <Button size="sm" variant="secondary" disabled={g.schools.length === 0} onClick={() => setAdminForm((v) => !v)}>
            {adminForm ? <X className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
            {adminForm ? 'Cancel' : 'Add admin'}
          </Button>
        </div>
        {g.admins.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {g.admins.map((a) => (
              <li key={a.user_id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13.5px]">
                <span className="min-w-0">
                  <span className="font-medium">{a.full_name}</span>
                  <span className="text-muted-foreground"> · {a.email ?? a.phone} · signs in at {a.home_school}</span>
                </span>
                <ConfirmButton
                  label="Remove admin"
                  question={`Remove ${a.full_name} as an admin of ${g.name}? They keep their account at ${a.home_school}.`}
                  confirmLabel="Remove"
                  disabled={dropAdmin.isPending}
                  onConfirm={() => dropAdmin.mutate(a.user_id)}
                >
                  <X className="h-3.5 w-3.5" />
                </ConfirmButton>
              </li>
            ))}
          </ul>
        )}
        {adminForm && (
          <AdminForm
            g={g}
            onDone={(h) => { setAdminForm(false); onChange(); if (h.temporary_password) onHandover(h) }}
          />
        )}
      </div>
      {(rename.error || remove.error || addSchool.error || dropSchool.error || dropAdmin.error) && (
        <div className="border-t px-4 py-3">
          <FormNotice error={rename.error ?? remove.error ?? addSchool.error ?? dropSchool.error ?? dropAdmin.error} />
        </div>
      )}
    </div>
  )
}

function AdminForm({ g, onDone }: { g: SchoolGroup; onDone: (h: Handover) => void }) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '', home: g.schools[0]?.id ?? '' })
  const save = useMutation({
    mutationFn: () => api.post<Handover>(`/api/v1/seller/school-groups/${g.id}/admins`, {
      full_name: f.full_name.trim(), email: f.email.trim() || undefined, phone: f.phone.trim() || undefined,
      home_institution_id: f.home,
    }),
    onSuccess: onDone,
  })
  const ready = f.full_name.trim() !== '' && (f.email.trim() !== '' || f.phone.trim() !== '') && f.home !== ''
  return (
    <form className="mt-3 rounded-md border px-4 py-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <FormGrid>
        <Field label="Full name" required>
          <Input value={f.full_name} onChange={(v) => setF({ ...f, full_name: v })} placeholder="Priya Nair" />
        </Field>
        <Field label="Signs in at" hint="Their home school. An existing account there is reused.">
          <Select
            value={f.home}
            onChange={(v) => setF({ ...f, home: v })}
            allowCustom={false}
            options={g.schools.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Email" hint="Email or phone is required.">
          <Input type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
        </Field>
      </FormGrid>
      <FormNotice error={save.error} />
      <div className="mt-4">
        <Button type="submit" disabled={!ready || save.isPending}>{save.isPending ? 'Adding…' : 'Add admin'}</Button>
      </div>
    </form>
  )
}

function HandoverCard({ h, onClose }: { h: Handover; onClose: () => void }) {
  const text = `${h.full_name}\nSign in as: ${h.sign_in_as}\nOne-time password: ${h.temporary_password}`
  return (
    <div className="rounded-lg border border-warning/50 bg-warning/5 px-4 py-4">
      <p className="text-[14px] font-semibold">Group admin created · {h.full_name}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">{h.note}</p>
      <p className="mt-3 text-[13px]">Signs in as <span className="font-mono">{h.sign_in_as}</span></p>
      <p className="mt-1 rounded-md border bg-muted px-3 py-2 font-mono text-[17px] tracking-wider">{h.temporary_password}</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(text)}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </div>
  )
}

