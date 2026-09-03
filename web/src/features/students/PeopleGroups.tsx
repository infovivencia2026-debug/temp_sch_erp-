import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { Plus, Trash2, Users } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Input, Select, Table, Td,
  Badge, EmptyState, ErrorState, SkeletonTable, FormNotice, FormGrid, Field,
} from '@/components/ui'

/* The school's own groupings.

   Classes, sections and houses ship with this product. The swimming squad, the
   bus that leaves at 3.15, the twelve children a trust pays for, the four
   teachers trained on the new lab do not — and each of those is a list the
   office keeps in a notebook and retypes into the message screen every time.

   TWO WAYS TO FILL ONE, because schools have two kinds of list:

     Picked by hand, where the names are the point — the six children going on
     Saturday's trip.

     Defined by a rule, where the names are a consequence — "Class 6, girls, on
     the roll" is a fact about a query, and a group re-picked by hand every
     time a child joins the class is a group that is wrong by Tuesday.

   A group can be both, and the members are the union.

   THE RULES READ THE SCHOOL'S OWN COLUMNS. Anything the importer did not
   recognise is kept on the record under the school's own heading, and every
   one of those headings can be filtered on here — so a school that imported a
   "Bus stop" column can group by bus stop without anybody adding a field to
   this product. */

interface Rule {
  field: string
  op: string
  value?: string
}

interface Group {
  id: string
  kind: 'student' | 'staff'
  name: string
  note?: string
  rules: Rule[]
  picked: number
}

interface Member {
  id: string
  name: string
  person_code: string
  ref: string
  detail: string
  picked: boolean
}

/* The operators, in the words somebody at a desk would use.

   "is_set" and "is_empty" are the two that catch what a school actually asks
   for out loud — "everyone who has a bus stop", "everyone whose blood group we
   never collected" — and both are unanswerable with equals. */
const OPS: { value: string; label: string; needsValue: boolean }[] = [
  { value: 'is', label: 'is', needsValue: true },
  { value: 'is_not', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'starts', label: 'starts with', needsValue: true },
  { value: 'is_set', label: 'has any value', needsValue: false },
  { value: 'is_empty', label: 'is empty', needsValue: false },
]

const BLANK: { name: string; note: string; rules: Rule[] } = {
  name: '',
  note: '',
  rules: [],
}

export default function PeopleGroups() {
  const { featureSlug } = useParams()
  // One screen, two catalogue entries. The staff one is the same thing over a
  // different set of people, and two copies would drift within a month.
  const kind: 'student' | 'staff' = featureSlug?.startsWith('staff') ? 'staff' : 'student'
  const noun = kind === 'staff' ? 'staff' : 'children'

  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(BLANK)
  const [showing, setShowing] = useState<string | null>(null)

  const groups = useQuery({
    queryKey: ['people-groups', kind],
    queryFn: () => api.get<{ items: Group[] }>(`/api/v1/people/groups?kind=${kind}`),
  })
  const fields = useQuery({
    queryKey: ['people-group-fields', kind],
    queryFn: () =>
      api.get<{ fields: string[]; custom_fields: string[] }>(
        `/api/v1/people/group-fields?kind=${kind}`,
      ),
    staleTime: 5 * 60 * 1000,
  })
  const members = useQuery({
    queryKey: ['people-group-members', showing],
    queryFn: () => api.get<{ items: Member[]; count: number }>(`/api/v1/people/groups/${showing}/members`),
    enabled: !!showing,
  })

  const fieldOptions = useMemo(() => {
    const known = (fields.data?.fields ?? []).map((f) => ({
      value: f,
      label: f.replace(/_/g, ' '),
    }))
    // The school's own, marked as theirs: "Bus stop" beside "class" with no
    // sign of where it came from reads as a field we forgot to document.
    const custom = (fields.data?.custom_fields ?? []).map((f) => ({
      value: `custom:${f}`,
      label: `${f} (your column)`,
    }))
    return [...known.sort((a, b) => a.label.localeCompare(b.label)), ...custom]
  }, [fields.data])

  const save = useMutation({
    mutationFn: () => {
      const body = { kind, name: form.name.trim(), note: form.note, rules: form.rules }
      return editing
        ? api.put(`/api/v1/people/groups/${editing}`, body)
        : api.post('/api/v1/people/groups', body)
    },
    onSuccess: () => {
      setOpen(false)
      setEditing(null)
      setForm(BLANK)
      qc.invalidateQueries({ queryKey: ['people-groups', kind] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/people/groups/${id}`),
    onSuccess: () => {
      setShowing(null)
      qc.invalidateQueries({ queryKey: ['people-groups', kind] })
    },
  })

  const setRule = (i: number, patch: Partial<Rule>) =>
    setForm((f) => ({
      ...f,
      rules: f.rules.map((r, n) => (n === i ? { ...r, ...patch } : r)),
    }))

  const rows = groups.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow={kind === 'staff' ? 'Staff' : 'Students'}
        title={kind === 'staff' ? 'Staff groups & lists' : 'Groups & lists'}
        description={`Your own groupings of ${noun} — picked by hand, or kept right by a rule.`}
        actions={
          <Button
            onClick={() => {
              if (open) { setOpen(false); setEditing(null); setForm(BLANK) }
              else { save.reset(); setForm(BLANK); setEditing(null); setOpen(true) }
            }}
          >
            {open ? 'Close' : 'New group'}
          </Button>
        }
      />
      <PageBody>
        {open && (
          <Card className="mb-4">
            <CardHeader
              title={editing ? 'Edit this group' : 'A new group'}
              description="Give it a name. Add rules if the group should keep itself right; leave them off and add people by hand instead."
            />
            <div className="space-y-4 p-4">
              <FormGrid>
                <Field label="Name" required>
                  <Input
                    value={form.name}
                    onChange={(v) => setForm({ ...form, name: v })}
                    placeholder={kind === 'staff' ? 'Exam duty 2026' : 'Swimming squad'}
                  />
                </Field>
                <Field label="Note" hint="What this group is for, for whoever opens it next term.">
                  <Input value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
                </Field>
              </FormGrid>

              <div>
                <p className="text-[13px] font-medium">Rules</p>
                <p className="mb-2 text-[13px] text-muted-foreground">
                  Everyone matching <strong>all</strong> of these is in the group, and stays in
                  it as the records change. Your own imported columns are here too.
                </p>
                <div className="space-y-2">
                  {form.rules.map((rule, i) => {
                    const op = OPS.find((o) => o.value === rule.op)
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <div className="w-52">
                          <Select
                            value={rule.field}
                            onChange={(v) => setRule(i, { field: v })}
                            placeholder="Choose a field"
                            options={fieldOptions}
                          />
                        </div>
                        <div className="w-40">
                          <Select
                            value={rule.op}
                            onChange={(v) => setRule(i, { op: v })}
                            options={OPS.map((o) => ({ value: o.value, label: o.label }))}
                          />
                        </div>
                        {op?.needsValue !== false && (
                          <div className="w-48">
                            <Input
                              value={rule.value ?? ''}
                              onChange={(v) => setRule(i, { value: v })}
                              placeholder="Value"
                            />
                          </div>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setForm((f) => ({ ...f, rules: f.rules.filter((_, n) => n !== i) }))
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setForm((f) => ({ ...f, rules: [...f.rules, { field: '', op: 'is', value: '' }] }))
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add a rule
                  </Button>
                </div>
              </div>

              <FormNotice error={save.error} />
              <div className="flex items-center gap-3">
                <Button
                  disabled={save.isPending || form.name.trim() === ''}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create the group'}
                </Button>
                <Button variant="ghost" onClick={() => { setOpen(false); setEditing(null) }}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        )}

        <Card>
          {groups.isLoading ? (
            <SkeletonTable columns={5} />
          ) : groups.error ? (
            <ErrorState error={groups.error} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No groups yet"
              body={`Make one for a list this school keeps outside the system — the ${
                kind === 'staff' ? 'exam duty roster' : 'swimming squad or the 3.15 bus'
              }.`}
            />
          ) : (
            <Table
              head={[
                { label: 'Group' },
                { label: 'How it is filled' },
                { label: 'Added by hand' },
                { label: '' },
              ]}
            >
              {rows.map((g) => (
                <tr key={g.id}>
                  <Td className="font-medium">
                    {g.name}
                    {g.note && (
                      <div className="text-[12px] font-normal text-muted-foreground">{g.note}</div>
                    )}
                  </Td>
                  <Td>
                    {g.rules.length === 0 ? (
                      <Badge tone="neutral">By hand</Badge>
                    ) : (
                      <span className="text-[13px] text-muted-foreground">
                        {g.rules
                          .map((r) => `${r.field.replace('custom:', '')} ${
                            OPS.find((o) => o.value === r.op)?.label ?? r.op
                          } ${r.value ?? ''}`.trim())
                          .join(' · ')}
                      </span>
                    )}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{g.picked}</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowing(showing === g.id ? null : g.id)}
                      >
                        <Users className="h-3.5 w-3.5" />
                        {showing === g.id ? 'Hide' : 'Who is in it'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(g.id)
                          setForm({ name: g.name, note: g.note ?? '', rules: g.rules })
                          setOpen(true)
                          save.reset()
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove.mutate(g.id)}>
                        Delete
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {showing && (
          <Card className="mt-4">
            <CardHeader
              title="Who is in this group"
              description={
                members.data
                  ? `${members.data.count} ${noun}, as the records stand today.`
                  : 'Counting…'
              }
            />
            {members.isLoading ? (
              <SkeletonTable columns={4} />
            ) : members.error ? (
              <ErrorState error={members.error} />
            ) : (members.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                title="Nobody matches yet"
                body="Either the rules are narrower than the roll, or nobody has been added by hand."
              />
            ) : (
              <Table head={[{ label: 'Name' }, { label: 'Code' }, { label: '' }, { label: 'How' }]}>
                {(members.data?.items ?? []).map((m) => (
                  <tr key={m.id}>
                    <Td className="font-medium">{m.name}</Td>
                    <Td className="font-mono text-[13px]">{m.person_code}</Td>
                    <Td className="text-muted-foreground">{m.detail || m.ref}</Td>
                    <Td>
                      {m.picked ? (
                        <Badge tone="neutral">Added by hand</Badge>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">By rule</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </PageBody>
    </>
  )
}
