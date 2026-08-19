import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Select, Button, Loading, ErrorState, FormNotice, Badge,
} from '@/components/ui'

/* Who owns each section.
 *
 * Setting a class teacher lived only in the setup wizard, on the step that
 * creates staff — which is where you do it once, on the day the school opens,
 * and nowhere near where you think about it afterwards. A class teacher leaves
 * in October and the replacement has to be made through a first-run wizard,
 * which reads as though the decision were unrepeatable.
 *
 * It belongs beside faculty allocation, because that is the screen somebody
 * opens when they are thinking about who teaches what. The two assignments are
 * genuinely different and the table says so: a class teacher marks the
 * register and sees the whole section whatever they teach; a subject teacher
 * sees the section only through their subject.
 *
 * Changing one is a normal act, not a correction. The control is the same
 * before and after, and clearing it is allowed — a section between class
 * teachers is a real state, and forcing a placeholder in is how a register
 * ends up owned by somebody who left.
 */

interface Section {
  id: string
  class_name: string
  name: string
  class_teacher?: string
  enrolled: number
}

interface Teacher {
  user_id: string
  full_name: string
  employee_code?: string
}

export default function ClassTeachers() {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState('')

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const teachers = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/timetable/teachers'),
  })

  const save = useMutation({
    mutationFn: async (rows: { section_id: string; teacher_user_id: string }[]) => {
      // One call per section: the endpoint takes a section and a teacher, and
      // inventing a bulk shape on the client would put a second contract in
      // front of the one the server actually has.
      for (const r of rows) {
        await api.post('/api/v1/setup/class-teacher', r)
      }
    },
    onSuccess: (_d, rows) => {
      qc.invalidateQueries({ queryKey: ['sections'] })
      qc.invalidateQueries({ queryKey: ['setup-status'] })
      setDraft({})
      setSaved(`${rows.length} ${rows.length === 1 ? 'section' : 'sections'} updated`)
    },
  })

  if (sections.isLoading) return <Loading />
  if (sections.error) return <ErrorState error={sections.error} />

  const rows = sections.data?.items ?? []
  const staff = teachers.data?.items ?? []
  const options = staff.map((t) => ({
    value: t.user_id,
    label: t.employee_code ? `${t.full_name} · ${t.employee_code}` : t.full_name,
  }))

  // The dropdown holds user ids; the sections list carries the teacher's name.
  // Matching on the name is what lets an unchanged row show who is in post
  // without a second request per section.
  const currentFor = (s: Section) => {
    if (s.id in draft) return draft[s.id]
    const match = staff.find((t) => t.full_name === s.class_teacher)
    return match?.user_id ?? ''
  }

  const pending = Object.entries(draft)
    .filter(([id, v]) => {
      const s = rows.find((x) => x.id === id)
      const match = staff.find((t) => t.full_name === s?.class_teacher)
      return v !== (match?.user_id ?? '')
    })
    .map(([section_id, teacher_user_id]) => ({ section_id, teacher_user_id }))

  const unowned = rows.filter((s) => !s.class_teacher).length

  return (
    <Card className="mb-5">
      <CardHeader
        title="Class teachers"
        description="One per section. A class teacher marks the daily register and sees every student in the section, whatever they teach — change it whenever somebody moves on."
        action={
          <Button
            size="sm"
            disabled={!pending.length || save.isPending}
            onClick={() => save.mutate(pending)}
          >
            {save.isPending ? 'Saving…' : pending.length ? `Save ${pending.length}` : 'Save'}
          </Button>
        }
      />

      <div className="px-5 pt-3">
        <FormNotice error={save.error} ok={saved} />
        {unowned > 0 && (
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            {unowned} {unowned === 1 ? 'section has' : 'sections have'} no class teacher — nobody
            marks that register.
          </p>
        )}
      </div>

      <Table head={['Class', 'Section', 'Students', 'Class teacher', '']} empty={!rows.length}
        emptyLabel="No sections yet — add them on the setup wizard first.">
        {rows.map((s) => (
          <tr key={s.id}>
            <Td className="font-medium">{s.class_name}</Td>
            <Td>{s.name}</Td>
            <Td className="tabular-nums">{s.enrolled}</Td>
            <Td>
              <Select
                value={currentFor(s)}
                onChange={(v) => setDraft((d) => ({ ...d, [s.id]: v }))}
                options={options}
                placeholder="Nobody"
              />
            </Td>
            <Td>
              {!s.class_teacher && !draft[s.id] && <Badge tone="warning">unowned</Badge>}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
