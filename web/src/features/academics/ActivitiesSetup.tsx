import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, FormGrid, Field as FormField,
  Select, FormNotice, Table, Td, Badge, Button, Input, Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatPaise } from '@/lib/utils'

/* The clubs a school actually runs.

   Defined once here, enrolled into from each child's record. The alternative —
   typing the club's name on every child — is how a school ends up with
   "Robotics", "robotics club" and "Robotics Club" as three activities, none of
   which can be counted or billed together.

   THE PRICE LIVES HERE, and moving it is one row. What each child owes was
   copied onto their enrolment when they joined, so raising the fee in April
   cannot re-bill the families who signed up in June. */

interface Activity {
  id: string
  name: string
  category: string
  schedule?: string
  venue?: string
  coordinator?: string
  fee_paise: number
  capacity: number
  enrolled: number
  is_active: boolean
  notes?: string
}

/* Suggestions, not a fixed list. A school that runs a Vedic maths class should
   not have to file it under "Sports" because the dropdown left no room. */
const CATEGORIES = [
  'Academic Club', 'Sports', 'Music', 'Dance', 'Art and Craft',
  'Coaching', 'Language', 'Community Service', 'Club',
]

export default function ActivitiesSetup() {
  const qc = useQueryClient()
  const can = useCan()
  const mayWrite = can('academics.academics.write') || can('academics.timetable.write')

  const [editing, setEditing] = useState<Activity | null>(null)
  const [adding, setAdding] = useState(false)

  const list = useQuery({
    queryKey: ['academics', 'activities'],
    queryFn: () => api.get<List<Activity>>('/api/v1/academics/activities'),
  })

  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      api.post('/api/v1/academics/activities', v),
    onSuccess: () => {
      setEditing(null)
      setAdding(false)
      qc.invalidateQueries({ queryKey: ['academics', 'activities'] })
    },
  })

  const rows = list.data?.items ?? []
  const running = rows.filter((a) => a.is_active)

  return (
    <>
      <PageHead
        eyebrow="Academics"
        title="Activities and electives"
        description="Clubs, coaching and electives the school runs. Children are enrolled from their own record, and a paid activity raises a bill the family can pay in the app."
        actions={mayWrite && (
          <Button variant={adding ? 'secondary' : 'primary'}
            onClick={() => { setAdding(!adding); setEditing(null) }}>
            {adding ? 'Close' : 'Add an activity'}
          </Button>
        )}
      />
      <PageBody>
        {(adding || editing) && mayWrite && (
          <Card>
            <CardHeader
              title={editing ? `Edit ${editing.name}` : 'A new activity'}
              description={editing
                ? 'Changing the fee changes it for children who join from now. Everybody already enrolled keeps the figure they signed up at.'
                : undefined}
            />
            <div className="p-4">
              <ActivityForm
                activity={editing ?? undefined}
                saving={save.isPending}
                error={save.error}
                onCancel={() => { setEditing(null); setAdding(false) }}
                onSave={(v) => save.mutate(editing ? { ...v, id: editing.id } : v)}
              />
            </div>
          </Card>
        )}

        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
          <Card>
            <CardHeader
              title={running.length
                ? `${running.length} running`
                : 'Nothing set up yet'}
              description="Wound-up activities stay on the list so their enrolments and the fees raised against them keep reading."
            />
            <Table
              head={['Activity', 'Category', 'When', 'Fee', 'Enrolled', '']}
              empty={!rows.length}
              emptyLabel="No activities yet. Add the clubs and coaching this school runs."
            >
              {rows.map((a) => (
                <tr key={a.id} className={a.is_active ? undefined : 'opacity-60'}>
                  <Td className="font-medium">
                    {a.name}
                    {!a.is_active && <Badge tone="neutral">wound up</Badge>}
                    {a.coordinator && (
                      <span className="block text-[12px] font-normal text-muted-foreground">
                        {a.coordinator}
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{a.category}</Td>
                  <Td className="text-muted-foreground">
                    {a.schedule || '—'}
                    {a.venue && (
                      <span className="block text-[12px]">{a.venue}</span>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {a.fee_paise > 0 ? formatPaise(a.fee_paise) : 'free'}
                  </Td>
                  <Td className="tabular-nums">
                    {a.enrolled}
                    {/* A capacity of nought means no limit, which is the
                        common case — so it prints nothing rather than "/0". */}
                    {a.capacity > 0 && (
                      <span className={a.enrolled >= a.capacity ? 'text-warning' : 'text-muted-foreground'}>
                        {' '}of {a.capacity}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {mayWrite && (
                      <Button size="sm" variant="secondary"
                        onClick={() => { setEditing(a); setAdding(false) }}>
                        Edit
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}

function ActivityForm({ activity, saving, error, onSave, onCancel }: {
  activity?: Activity
  saving: boolean
  error: unknown
  onSave: (v: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({
    name: activity?.name ?? '',
    category: activity?.category ?? 'Club',
    schedule: activity?.schedule ?? '',
    venue: activity?.venue ?? '',
    // Rupees on the screen, paise in the database. A form that asks for paise
    // is a form where somebody eventually charges twenty-five rupees.
    fee: activity ? String(activity.fee_paise / 100) : '',
    capacity: activity ? String(activity.capacity) : '',
    notes: activity?.notes ?? '',
  })
  const [active, setActive] = useState(activity?.is_active ?? true)
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })

  return (
    <>
      <FormNotice error={error} />
      <FormGrid>
        <FormField label="Name" required>
          <Input value={f.name} onChange={set('name')} placeholder="Robotics Club" />
        </FormField>
        <FormField label="Category" required>
          <Select value={CATEGORIES.includes(f.category) ? f.category : ''}
            onChange={set('category')} placeholder="Choose, or type your own beside it"
            options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
        </FormField>
        <FormField label="Or another category">
          <Input value={f.category} onChange={set('category')} />
        </FormField>
        <FormField label="When it meets" hint="In words — Wed 3-4 PM, Mon/Thu 4-5 PM">
          <Input value={f.schedule} onChange={set('schedule')} placeholder="Wed 3-4 PM" />
        </FormField>
        <FormField label="Where">
          <Input value={f.venue} onChange={set('venue')} placeholder="Science lab 2" />
        </FormField>
        <FormField label="Fee (₹)" hint="Leave blank or nought for a free club">
          <Input type="number" value={f.fee} onChange={set('fee')} placeholder="0" />
        </FormField>
        <FormField label="Places" hint="Blank or nought means no limit">
          <Input type="number" value={f.capacity} onChange={set('capacity')} />
        </FormField>
      </FormGrid>
      <FormField label="Notes">
        <Input value={f.notes} onChange={set('notes')} />
      </FormField>
      <div className="mt-3">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={active}
            onChange={(e) => setActive(e.target.checked)} />
          {/* Wound up rather than deleted: the enrolments and the fees raised
              against it have to keep reading. */}
          Still running — untick to wind it up without losing its history
        </label>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button
          disabled={saving || !f.name.trim()}
          onClick={() => onSave({
            name: f.name,
            category: f.category,
            schedule: f.schedule,
            venue: f.venue,
            fee: Number(f.fee) || 0,
            capacity: Number(f.capacity) || 0,
            is_active: active,
            notes: f.notes,
          })}
        >
          {saving ? 'Saving…' : activity ? 'Save changes' : 'Add it'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </>
  )
}
