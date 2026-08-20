import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Wand2 } from 'lucide-react'
import BulkImport from '@/components/BulkImport'
import RoleSelect from '@/components/RoleSelect'
import AdmitStudent from './AdmitStudent'
import { api, type AcademicYear, type Klass, type List, type Section, type Subject } from '@/lib/api'
import { Button, Field, FormGrid, FormNotice, Input, Select, Badge } from '@/components/ui'
import { cn } from '@/lib/utils'

/* The forms behind each wizard step.

   Two rules run through all of them.

   First, every panel shows what already exists. A form with no context makes
   an admin wonder whether their last click worked, and the commonest setup
   error is entering the same class twice under two spellings.

   Second, every panel that can offer a sensible starting point does. A
   Telangana high school's subject list, a 10-point CCE grading scale and an
   eight-period day are the same in almost every school; making someone type
   them in one at a time is data entry dressed up as configuration. The preset
   fills the form — it never saves behind the user's back. */

export interface PanelProps {
  onDone: () => void
}

// --- shared -----------------------------------------------------------------

/** A save button wired to a mutation, with the server's error shown inline. */
function useSave<T>(fn: (v: T) => Promise<unknown>, onDone: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries()
      onDone()
    },
  })
}

function Existing({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-5 border-t pt-4">
      <p className="eyebrow mb-2">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-2 py-0.5 text-[13px]',
        muted && 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

/** The "fill this in for me" affordance, kept visually distinct from a save. */
function Preset({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1 text-[13px] text-muted-foreground transition-colors duration-150 hover:border-solid hover:text-foreground"
    >
      <Wand2 className="h-3 w-3" />
      {children}
    </button>
  )
}

function SaveRow({
  pending,
  error,
  label = 'Save and continue',
  children,
}: {
  pending: boolean
  error: unknown
  label?: string
  children?: ReactNode
}) {
  return (
    <>
      <FormNotice error={error} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : label}
        </Button>
        {children}
      </div>
    </>
  )
}

const rupeesToPaise = (r: string) => Math.round(parseFloat(r || '0') * 100)

// --- 1. school profile ------------------------------------------------------

interface Opt {
  value: string
  label: string
}
interface Options {
  management_types: Opt[]
  school_categories: Opt[]
  affiliation_boards: Opt[]
  telangana_districts: string[]
}
interface Profile {
  name: string
  short_name: string
  udise_code?: string
  affiliation_board?: string
  affiliation_no?: string
  state?: string
  district?: string
  mandal?: string
  village_or_ward?: string
  school_category?: string
  management_type?: string
  child_info_code?: string
  mid_day_meal: boolean
}

function ProfilePanel({ onDone }: PanelProps) {
  const { data: opts } = useQuery({
    queryKey: ['inst-options'],
    queryFn: () => api.get<Options>('/api/v1/setup/institution/options'),
  })
  const { data: cur } = useQuery({
    queryKey: ['institution'],
    queryFn: () => api.get<Profile>('/api/v1/setup/institution'),
  })
  const [f, setF] = useState<Partial<Profile> | null>(null)
  const v = f ?? cur ?? {}
  const set = (k: keyof Profile, val: string | boolean) =>
    setF({ ...(f ?? cur ?? {}), [k]: val } as Partial<Profile>)

  const save = useSave((body: Partial<Profile>) => api.put('/api/v1/setup/institution', body), onDone)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ ...(cur ?? {}), ...(f ?? {}) })
      }}
    >
      <FormGrid>
        <Field label="School name" required wide hint="As it should print on a receipt or a TC.">
          <Input value={v.name ?? ''} onChange={(x) => set('name', x)} placeholder="Vivencia High School, Kompally" />
        </Field>
        <Field label="Board" required hint="Not listed? Add your own at the bottom of the list.">
          <Select
            kind="affiliation_board"
            addLabel="Add another board"
            value={v.affiliation_board ?? ''}
            onChange={(x) => set('affiliation_board', x)}
            placeholder="Choose a board"
            options={(opts?.affiliation_boards ?? []).map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
        <Field label="Affiliation number" hint="Leave blank if the application is still pending.">
          <Input value={v.affiliation_no ?? ''} onChange={(x) => set('affiliation_no', x)} />
        </Field>
        <Field label="State" required>
          <Input value={v.state ?? ''} onChange={(x) => set('state', x)} placeholder="Telangana" />
        </Field>
        <Field label="District" required hint="Type any district; Telangana's are suggested.">
          <>
            <Input
              value={v.district ?? ''}
              onChange={(x) => set('district', x)}
              className="w-full"
              list="districts"
              placeholder="Medchal-Malkajgiri"
            />
            <datalist id="districts">
              {(opts?.telangana_districts ?? []).map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </>
        </Field>
        <Field label="Mandal">
          <Input value={v.mandal ?? ''} onChange={(x) => set('mandal', x)} placeholder="Quthbullapur" />
        </Field>
        <Field label="Village or ward">
          <Input value={v.village_or_ward ?? ''} onChange={(x) => set('village_or_ward', x)} />
        </Field>
        <Field label="School category">
          <Select
            kind="school_category"
            addLabel="Add another category"
            value={v.school_category ?? ''}
            onChange={(x) => set('school_category', x)}
            placeholder="Choose"
            options={opts?.school_categories ?? []}
          />
        </Field>
        <Field label="Management">
          <Select
            kind="management_type"
            addLabel="Add another management type"
            value={v.management_type ?? ''}
            onChange={(x) => set('management_type', x)}
            placeholder="Choose"
            options={opts?.management_types ?? []}
          />
        </Field>
        <Field label="UDISE+ code" hint="Eleven digits. Needed before the annual return.">
          <Input value={v.udise_code ?? ''} onChange={(x) => set('udise_code', x)} placeholder="36051200145" />
        </Field>
        <Field label="Child Info ID" hint="Telangana's own school code, if you have one.">
          <Input value={v.child_info_code ?? ''} onChange={(x) => set('child_info_code', x)} />
        </Field>
        <Field label="Mid-day meal">
          <Select
            value={v.mid_day_meal ? 'yes' : 'no'}
            onChange={(x) => set('mid_day_meal', x === 'yes')}
            options={[
              { value: 'no', label: 'Not served' },
              { value: 'yes', label: 'Served — keep the MDM register' },
            ]}
          />
        </Field>
      </FormGrid>
      <SaveRow pending={save.isPending} error={save.error} />
    </form>
  )
}

// --- 2. campus --------------------------------------------------------------

interface Campus {
  id: string
  name: string
  code: string
  city?: string
  state?: string
  pincode?: string
  phone?: string
  students: number
}

function CampusPanel({ onDone }: PanelProps) {
  const { data } = useQuery({
    queryKey: ['campuses'],
    queryFn: () => api.get<List<Campus>>('/api/v1/setup/campuses'),
  })
  const list = data?.items ?? []
  const [editing, setEditing] = useState<string | null>(null)
  const target = list.find((c) => c.id === editing) ?? list[0]
  const [f, setF] = useState<Record<string, string> | null>(null)
  const v = f ?? {
    name: target?.name ?? '',
    code: target?.code ?? '',
    city: target?.city ?? '',
    state: target?.state ?? '',
    pincode: target?.pincode ?? '',
    phone: target?.phone ?? '',
  }
  const set = (k: string, val: string) => setF({ ...v, [k]: val })

  const save = useSave(
    (body: Record<string, string>) =>
      target ? api.put(`/api/v1/setup/campuses/${target.id}`, body) : api.post('/api/v1/setup/campuses', body),
    () => {
      setF(null)
      onDone()
    },
  )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(v)
      }}
    >
      <p className="mb-4 text-[14px] text-muted-foreground">
        {target
          ? 'A campus was created for you so the first academic year had somewhere to sit. Give it the real name and address — a transfer certificate prints it.'
          : 'Most schools have one. Add a second only if it has its own building and its own students.'}
      </p>
      <FormGrid>
        <Field label="Campus name" required>
          <Input value={v.name} onChange={(x) => set('name', x)} placeholder="Kompally Campus" />
        </Field>
        <Field label="Short code" hint="Left blank, it is built from the name.">
          <Input value={v.code} onChange={(x) => set('code', x)} placeholder="KMP" />
        </Field>
        <Field label="Address" wide>
          <Input value={v.address_line1 ?? ''} onChange={(x) => set('address_line1', x)} />
        </Field>
        <Field label="City">
          <Input value={v.city} onChange={(x) => set('city', x)} />
        </Field>
        <Field label="State">
          <Input value={v.state} onChange={(x) => set('state', x)} />
        </Field>
        <Field label="PIN code">
          <Input value={v.pincode} onChange={(x) => set('pincode', x)} />
        </Field>
        <Field label="Phone">
          <Input value={v.phone} onChange={(x) => set('phone', x)} />
        </Field>
      </FormGrid>
      <SaveRow pending={save.isPending} error={save.error} label={target ? 'Save campus' : 'Add campus'}>
        {target && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing('new')
              setF({ name: '', code: '', city: '', state: '', pincode: '', phone: '' })
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add another campus
          </Button>
        )}
      </SaveRow>
      {list.length > 0 && (
        <Existing label="Campuses">
          {list.map((c) => (
            <Chip key={c.id}>
              {c.name} · {c.students} students
            </Chip>
          ))}
        </Existing>
      )}
    </form>
  )
}

// --- 3. academic year -------------------------------------------------------

function YearPanel({ onDone }: PanelProps) {
  const { data } = useQuery({
    queryKey: ['years'],
    queryFn: () => api.get<List<AcademicYear>>('/api/v1/academics/years'),
  })
  const [f, setF] = useState({ name: '', starts_on: '', ends_on: '', is_current: true })
  const save = useSave((body: typeof f) => api.post('/api/v1/setup/academic-years', body), onDone)

  // June to April is the Telangana school year; the financial year that fees
  // are reported against is April to March, which is why the two are not
  // derived from one another anywhere in this system.
  const suggest = () => {
    const now = new Date()
    const y = now.getMonth() >= 4 ? now.getFullYear() : now.getFullYear() - 1
    setF({
      name: `${y}-${String((y + 1) % 100).padStart(2, '0')}`,
      starts_on: `${y}-06-01`,
      ends_on: `${y + 1}-04-30`,
      is_current: true,
    })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(f)
      }}
    >
      <div className="mb-4">
        <Preset onClick={suggest}>Use this year, June to April</Preset>
      </div>
      <FormGrid>
        <Field label="Name" required hint="How staff refer to it: 2026-27.">
          <Input value={f.name} onChange={(x) => setF({ ...f, name: x })} placeholder="2026-27" />
        </Field>
        <Field label="Current year">
          <Select
            value={f.is_current ? 'yes' : 'no'}
            onChange={(x) => setF({ ...f, is_current: x === 'yes' })}
            options={[
              { value: 'yes', label: 'Yes — this is the running year' },
              { value: 'no', label: 'No — a past or future year' },
            ]}
          />
        </Field>
        <Field label="Starts on" required>
          <Input type="date" value={f.starts_on} onChange={(x) => setF({ ...f, starts_on: x })} />
        </Field>
        <Field label="Ends on" required>
          <Input type="date" value={f.ends_on} onChange={(x) => setF({ ...f, ends_on: x })} />
        </Field>
      </FormGrid>
      <SaveRow pending={save.isPending} error={save.error} />
      {(data?.items.length ?? 0) > 0 && (
        <Existing label="Years">
          {data!.items.map((y) => (
            <Chip key={y.id} muted={!y.is_current}>
              {y.name}
              {y.is_current && ' · current'}
            </Chip>
          ))}
        </Existing>
      )}
    </form>
  )
}

// --- 4. classes -------------------------------------------------------------

function ClassesPanel({ onDone }: PanelProps) {
  const { data } = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const existing = data?.items ?? []
  const [rows, setRows] = useState<{ name: string; level: string }[]>([{ name: '', level: '' }])

  const save = useSave(async (list: { name: string; level: string }[]) => {
    // Sequential rather than parallel: `level` orders the school and a burst
    // of concurrent inserts makes a duplicate level harder to attribute.
    for (const r of list) {
      if (!r.name.trim()) continue
      await api.post('/api/v1/setup/classes', { name: r.name.trim(), level: Number(r.level) || 0 })
    }
  }, onDone)

  const preset = (from: number, to: number, label: (n: number) => string) =>
    setRows(
      Array.from({ length: to - from + 1 }, (_, i) => ({
        name: label(from + i),
        level: String(from + i),
      })),
    )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(rows)
      }}
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <Preset onClick={() => preset(1, 10, (n) => `Class ${n}`)}>Classes 1–10</Preset>
        <Preset onClick={() => preset(6, 10, (n) => `Class ${n}`)}>High school, 6–10</Preset>
        <Preset
          onClick={() =>
            setRows([
              { name: 'Nursery', level: '-2' },
              { name: 'LKG', level: '-1' },
              { name: 'UKG', level: '0' },
              ...Array.from({ length: 5 }, (_, i) => ({ name: `Class ${i + 1}`, level: String(i + 1) })),
            ])
          }
        >
          Pre-primary and 1–5
        </Preset>
      </div>

      <p className="mb-3 text-[14px] text-muted-foreground">
        Level orders the school — it is what sorts Class 10 below Class 9 in every report, and what
        promotion moves a student along.
      </p>

      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <Input
              value={r.name}
              onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, name: x } : v)))}
              placeholder="Class 6"
            />
            <Input
              value={r.level}
              onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, level: x } : v)))}
              placeholder="Level"
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setRows([...rows, { name: '', level: '' }])}
        className="mt-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        Another class
      </button>

      <SaveRow
        pending={save.isPending}
        error={save.error}
        label={`Add ${rows.filter((r) => r.name.trim()).length || ''} ${
          rows.filter((r) => r.name.trim()).length === 1 ? 'class' : 'classes'
        }`}
      />
      {existing.length > 0 && (
        <Existing label="Classes">
          {existing.map((c) => (
            <Chip key={c.id}>{c.name}</Chip>
          ))}
        </Existing>
      )}
          <div className="mt-5 border-t pt-5">
        <BulkImport
          entity="classes"
          title="Or add every class from a sheet"
          hint="Two columns: name and level. Level is what orders them — Grade 6 is level 6."
          onDone={onDone}
        />
      </div>
</form>
  )
}

// --- 5. sections ------------------------------------------------------------

function SectionsPanel({ onDone }: PanelProps) {
  const { data: classes } = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const { data: sections } = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const [names, setNames] = useState('A')
  const [capacity, setCapacity] = useState('40')
  const [scope, setScope] = useState('all')
  /* Which class's sections are listed below.
   *
   * Separate from "Apply to" on purpose: one decides what you are about to
   * create, the other what you are looking at. A school with ten classes and
   * four sections each was shown forty chips in one row and had to read the
   * prefix on every one of them to find 8-C. */
  const [filter, setFilter] = useState('all')

  const save = useSave(async () => {
    const letters = names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const targets = scope === 'all' ? (classes?.items ?? []) : (classes?.items ?? []).filter((c) => c.id === scope)
    for (const c of targets) {
      for (const n of letters) {
        await api.post('/api/v1/setup/sections', {
          class_id: c.id,
          name: n,
          capacity: Number(capacity) || 40,
        })
      }
    }
  }, onDone)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined as never)
      }}
    >
      <p className="mb-4 text-[14px] text-muted-foreground">
        Adding a section to every class at once is the usual case. Come back for the extra section a
        single crowded class needs.
      </p>
      <FormGrid>
        <Field label="Apply to">
          <Select
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: `Every class (${classes?.items.length ?? 0})` },
              ...(classes?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </Field>
        <Field label="Section names" required hint="Comma separated: A, B, C.">
          <Input value={names} onChange={setNames} placeholder="A, B" />
        </Field>
        <Field label="Capacity" hint="Used to warn the office before a section is over-filled.">
          <Input value={capacity} onChange={setCapacity} />
        </Field>
      </FormGrid>
      <SaveRow pending={save.isPending} error={save.error} label="Create sections" />
      {(sections?.items.length ?? 0) > 0 && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-muted-foreground">Show sections in</span>
            <Select
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `Every class (${sections?.items.length ?? 0} sections)` },
                ...(classes?.items ?? []).map((c) => ({
                  value: c.id,
                  label: `${c.name} (${
                    (sections?.items ?? []).filter((x) => x.class_id === c.id).length
                  })`,
                })),
              ]}
            />
          </div>
          <Existing label="Sections">
            {sections!.items
              .filter((s) => filter === 'all' || s.class_id === filter)
              .map((s) => (
                <Chip key={s.id}>
                  {s.class_name}-{s.name} · {s.enrolled}/{s.capacity}
                </Chip>
              ))}
          </Existing>
        </>
      )}
          <div className="mt-5 border-t pt-5">
        <BulkImport
          entity="sections"
          title="Or add sections from a sheet"
          hint="Class, name, capacity. The class must exist already and is matched by its name."
          onDone={onDone}
        />
      </div>
</form>
  )
}

// --- 6. subjects ------------------------------------------------------------

// The state syllabus subject list, with the codes schools already use on a
// report card. Co-scholastic subjects are marked as such because CCE grades
// them on a scale rather than out of marks.
const TELANGANA_SUBJECTS: { name: string; code: string; scholastic: boolean }[] = [
  { name: 'Telugu', code: 'TEL', scholastic: true },
  { name: 'Hindi', code: 'HIN', scholastic: true },
  { name: 'English', code: 'ENG', scholastic: true },
  { name: 'Mathematics', code: 'MATH', scholastic: true },
  { name: 'General Science', code: 'GSCI', scholastic: true },
  { name: 'Social Studies', code: 'SOC', scholastic: true },
  { name: 'Physical Science', code: 'PSCI', scholastic: true },
  { name: 'Biological Science', code: 'BSCI', scholastic: true },
  { name: 'Computer Science', code: 'CS', scholastic: true },
  { name: 'Physical Education', code: 'PE', scholastic: false },
  { name: 'Art & Culture', code: 'ART', scholastic: false },
  { name: 'Work & Computer Education', code: 'WCE', scholastic: false },
  { name: 'Value Education & Life Skills', code: 'VEL', scholastic: false },
]

function SubjectsPanel({ onDone }: PanelProps) {
  const { data } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<List<Subject>>('/api/v1/academics/subjects'),
  })
  const have = new Set((data?.items ?? []).map((s) => s.code))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState({ name: '', code: '' })

  const save = useSave(async () => {
    for (const s of TELANGANA_SUBJECTS.filter((s) => picked.has(s.code))) {
      await api.post('/api/v1/setup/subjects', { name: s.name, code: s.code, is_scholastic: s.scholastic })
    }
    if (custom.name.trim()) {
      await api.post('/api/v1/setup/subjects', {
        name: custom.name.trim(),
        code: (custom.code || custom.name.slice(0, 4)).toUpperCase(),
      })
    }
  }, onDone)

  const toggle = (code: string) => {
    const next = new Set(picked)
    next.has(code) ? next.delete(code) : next.add(code)
    setPicked(next)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined as never)
      }}
    >
      <div className="mb-4">
        <Preset onClick={() => setPicked(new Set(TELANGANA_SUBJECTS.filter((s) => !have.has(s.code)).map((s) => s.code)))}>
          Select the whole state syllabus
        </Preset>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {TELANGANA_SUBJECTS.map((s) => {
          const already = have.has(s.code)
          return (
            <button
              key={s.code}
              type="button"
              disabled={already}
              onClick={() => toggle(s.code)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
                already && 'cursor-default border-dashed text-muted-foreground',
                !already && picked.has(s.code) && 'border-primary bg-primary text-primary-foreground',
                !already && !picked.has(s.code) && 'hover:bg-accent',
              )}
            >
              {s.name}
              {already && ' ✓'}
              {!s.scholastic && !already && <span className="ml-1 opacity-60">co-sch.</span>}
            </button>
          )
        })}
      </div>

      <div className="mt-5 border-t pt-4">
        <p className="eyebrow mb-2">Something else</p>
        <FormGrid>
          <Field label="Subject name">
            <Input value={custom.name} onChange={(x) => setCustom({ ...custom, name: x })} placeholder="Sanskrit" />
          </Field>
          <Field label="Code">
            <Input value={custom.code} onChange={(x) => setCustom({ ...custom, code: x })} placeholder="SAN" />
          </Field>
        </FormGrid>
      </div>

      <SaveRow
        pending={save.isPending}
        error={save.error}
        label={`Add ${picked.size + (custom.name.trim() ? 1 : 0) || ''} subjects`}
      />

      <div className="mt-5 border-t pt-5">
        <BulkImport
          entity="subjects"
          title="Or add every subject from a sheet"
          hint="Name and code. The code is what a report card prints, and it is what a second upload matches on — so a corrected sheet edits rather than doubles."
          onDone={onDone}
        />
      </div>
    </form>
  )
}

// --- 7. class-subject mapping ----------------------------------------------

function ClassSubjectsPanel({ onDone }: PanelProps) {
  const { data: classes } = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<List<Subject>>('/api/v1/academics/subjects'),
  })
  const [classID, setClassID] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [applyAll, setApplyAll] = useState(false)
  // Narrows the subject buttons below. A school running the full state list
  // has thirteen of them and is usually looking for one.
  const [find, setFind] = useState('')

  /* What this class already studies.
   *
   * The panel opened with nothing selected and saving replaces the class's
   * list with exactly what is ticked -- so choosing a class that already had
   * six subjects, changing nothing, and pressing Save removed all six. The
   * sentence under the buttons said so and was easy to read as a description
   * of adding rather than of replacing.
   *
   * Loading the current set makes the screen mean what it says: it opens
   * showing the truth, and Save writes back what you can see. */
  const current = useQuery({
    queryKey: ['class-subjects', classID],
    queryFn: () =>
      api.get<List<{ subject_id: string }>>(
        `/api/v1/setup/class-subjects?class_id=${classID}`,
      ),
    enabled: !!classID,
  })

  useEffect(() => {
    if (!classID) return
    setPicked(new Set((current.data?.items ?? []).map((x) => x.subject_id)))
  }, [classID, current.data])

  const save = useSave(async () => {
    const ids = [...picked]
    const targets = applyAll ? (classes?.items ?? []).map((c) => c.id) : [classID]
    for (const cid of targets) {
      if (!cid) continue
      await api.put('/api/v1/setup/class-subjects', { class_id: cid, subject_ids: ids })
    }
  }, onDone)

  const toggle = (id: string) => {
    const next = new Set(picked)
    next.has(id) ? next.delete(id) : next.add(id)
    setPicked(next)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined as never)
      }}
    >
      <p className="mb-4 text-[14px] text-muted-foreground">
        This is what makes a subject appear on a class's timetable, gradebook and report card. A
        teacher cannot be assigned to a subject the class does not study.
      </p>
      <FormGrid>
        <Field label="Class" required>
          <Select
            value={classID}
            onChange={setClassID}
            placeholder="Choose a class"
            options={(classes?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="Scope">
          <Select
            value={applyAll ? 'all' : 'one'}
            onChange={(x) => setApplyAll(x === 'all')}
            options={[
              { value: 'one', label: 'Only the class above' },
              { value: 'all', label: 'Give every class this same set' },
            ]}
          />
        </Field>
      </FormGrid>

      <div className="mb-2 mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">
          Subjects this class studies
          {classID && (
            <span className="ml-1.5 normal-case text-muted-foreground">
              {picked.size} of {subjects?.items.length ?? 0} selected
            </span>
          )}
        </p>
        {(subjects?.items.length ?? 0) > 8 && (
          <Input value={find} onChange={setFind} placeholder="Find a subject" className="w-48" />
        )}
      </div>
      {classID && current.isLoading && (
        <p className="text-[13px] text-muted-foreground">Reading what this class already studies…</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {(subjects?.items ?? [])
          .filter((s) => !find.trim() || s.name.toLowerCase().includes(find.trim().toLowerCase()))
          .map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => toggle(s.id)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
              picked.has(s.id) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
            )}
          >
            {s.name}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">
        {classID
          ? 'This is what the class studies now. Saving writes back exactly what is selected — untick one and it is removed.'
          : 'Choose a class above and its current subjects appear ticked.'}
      </p>
      <SaveRow pending={save.isPending} error={save.error} label="Save mapping" />
      <div className="mt-5 border-t pt-5">
        <BulkImport
          entity="class_subjects"
          title="Or map every class from a sheet"
          hint="Class, subject code, max marks and — in the same row — the teacher's email. Naming a teacher here assigns them to every section of that class, so there is no second pass to do it."
          onDone={onDone}
        />
      </div>
    </form>
  )
}

// --- 8. periods -------------------------------------------------------------

function PeriodsPanel({ onDone }: PanelProps) {
  type P = { name: string; sequence: number; starts_at: string; ends_at: string; is_break: boolean }
  const { data } = useQuery({
    queryKey: ['periods'],
    queryFn: () => api.get<List<P & { id: string }>>('/api/v1/timetable/periods'),
  })
  const [rows, setRows] = useState<P[]>([])
  const save = useSave((periods: P[]) => api.put('/api/v1/setup/periods', { periods }), onDone)

  const standard = () => {
    const start = 9 * 60 // 09:00, the usual first bell
    const plan: [string, number, boolean][] = [
      ['Period 1', 45, false],
      ['Period 2', 45, false],
      ['Short break', 15, true],
      ['Period 3', 45, false],
      ['Period 4', 45, false],
      ['Lunch', 40, true],
      ['Period 5', 45, false],
      ['Period 6', 45, false],
      ['Period 7', 45, false],
    ]
    let t = start
    setRows(
      plan.map(([name, mins, isBreak], i) => {
        const from = t
        t += mins
        const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
        return { name, sequence: i + 1, starts_at: hhmm(from), ends_at: hhmm(t), is_break: isBreak }
      }),
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(rows)
      }}
    >
      <div className="mb-4">
        <Preset onClick={standard}>A seven-period day from 09:00</Preset>
      </div>
      <p className="mb-3 text-[14px] text-muted-foreground">
        Breaks are listed too. The timetable needs them to know a teacher is free, and attendance
        needs them to know a period was not taught.
      </p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_6rem_6rem_5rem] items-center gap-2">
            <Input value={r.name} onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, name: x } : v)))} />
            <Input type="time" value={r.starts_at} onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, starts_at: x } : v)))} />
            <Input type="time" value={r.ends_at} onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, ends_at: x } : v)))} />
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <input
                type="checkbox"
                checked={r.is_break}
                onChange={(e) => setRows(rows.map((v, j) => (i === j ? { ...v, is_break: e.target.checked } : v)))}
              />
              break
            </label>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() =>
          setRows([...rows, { name: `Period ${rows.length + 1}`, sequence: rows.length + 1, starts_at: '', ends_at: '', is_break: false }])
        }
        className="mt-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        Another period
      </button>
      <SaveRow pending={save.isPending} error={save.error} label="Save the school day" />
      {(data?.items.length ?? 0) > 0 && (
        <Existing label="Current day">
          {data!.items.map((p) => (
            <Chip key={p.id} muted={p.is_break}>
              {p.name} {p.starts_at?.slice(0, 5)}
            </Chip>
          ))}
        </Existing>
      )}
    </form>
  )
}

// --- 9. staff ---------------------------------------------------------------

function StaffPanel({ onDone }: PanelProps) {
  const { data: teachers } = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.get<List<{ user_id: string; full_name: string; employee_code: string }>>('/api/v1/timetable/teachers'),
  })
  const [f, setF] = useState({
    employee_code: '',
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    role_key: 'faculty',
    create_login: true,
  })
  const save = useSave(async (body: typeof f) => api.post('/api/v1/setup/employees', body), () => {
    setF({ ...f, employee_code: '', first_name: '', last_name: '', email: '', phone: '' })
    onDone()
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(f)
      }}
    >
      <p className="mb-4 text-[14px] text-muted-foreground">
        A login created here can see nothing until the person is made class teacher of a section or
        given a subject in one. That is deliberate — a teacher's reach comes from their assignments,
        not from their role.
      </p>
      <FormGrid>
        <Field label="Employee code" required hint="Whatever your registers already use.">
          <Input value={f.employee_code} onChange={(x) => setF({ ...f, employee_code: x })} placeholder="T-014" />
        </Field>
        <Field label="Role" hint="Every role your school has, including any you have created.">
          <RoleSelect value={f.role_key} onChange={(x) => setF({ ...f, role_key: x })} />
        </Field>
        <Field label="First name" required>
          <Input value={f.first_name} onChange={(x) => setF({ ...f, first_name: x })} />
        </Field>
        <Field label="Last name">
          <Input value={f.last_name} onChange={(x) => setF({ ...f, last_name: x })} />
        </Field>
        <Field label="Email" hint="Used to sign in. Leave blank for staff who will not.">
          <Input type="email" value={f.email} onChange={(x) => setF({ ...f, email: x })} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(x) => setF({ ...f, phone: x })} />
        </Field>
      </FormGrid>
      <SaveRow pending={save.isPending} error={save.error} label="Add staff member" />
      {(teachers?.items.length ?? 0) > 0 && (
        <Existing label="Teaching staff">
          {teachers!.items.map((t) => (
            <Chip key={t.user_id}>{t.full_name}</Chip>
          ))}
        </Existing>
      )}
      <Assignments onDone={onDone} />
          <div className="mt-5 border-t pt-5">
        <BulkImport
          entity="staff"
          title="Or add all your staff from a sheet"
          hint="Employee code and first name are required. Give an email and a role and they get a login too. Adding staff does not assign them — that is the section form above, or the sheet below."
          onDone={onDone}
        />
      </div>
      <div className="mt-5 border-t pt-5">
        <BulkImport
          entity="class_subjects"
          title="Or assign every subject teacher from a sheet"
          hint="Class, subject code, max marks and the teacher's email. The teacher is attached to that subject in every section of the class, which is what finishes this step for a whole school at once."
          onDone={onDone}
        />
      </div>
</form>
  )
}

/**
 * The half of "add staff" that actually grants access.
 *
 * Until a teacher is class teacher of a section or holds a subject in one,
 * internal/scope resolves their student set to empty and every screen they
 * open is blank. The checklist counts this step, not the count of logins —
 * so the form that satisfies it has to be here, next to the one that creates
 * the account.
 */
function Assignments({ onDone }: PanelProps) {
  const { data: sections } = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const { data: teachers } = useQuery({
    queryKey: ['teachers'],
    queryFn: () =>
      api.get<List<{ user_id: string; full_name: string }>>('/api/v1/timetable/teachers'),
  })
  const [sectionID, setSectionID] = useState('')
  const section = sections?.items.find((s) => s.id === sectionID)
  // What the step is actually measured on, shown where somebody can see it.
  const assignedSections = (sections?.items ?? []).filter((x) => x.class_teacher).length
  const { data: subjects } = useQuery({
    queryKey: ['class-subjects', section?.class_id],
    queryFn: () =>
      api.get<List<{ id: string; subject_name: string; a_teacher?: string }>>(
        `/api/v1/setup/class-subjects?class_id=${section!.class_id}`,
      ),
    enabled: !!section,
  })
  const [classTeacher, setClassTeacher] = useState('')
  const [subjectTeachers, setSubjectTeachers] = useState<Record<string, string>>({})

  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: async () => {
      if (classTeacher) {
        await api.post('/api/v1/setup/class-teacher', {
          section_id: sectionID,
          teacher_user_id: classTeacher,
        })
      }
      for (const [csID, uid] of Object.entries(subjectTeachers)) {
        if (!uid) continue
        await api.post('/api/v1/setup/assign-teacher', {
          section_id: sectionID,
          class_subject_id: csID,
          teacher_user_id: uid,
        })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries()
      setSubjectTeachers({})
      onDone()
    },
  })

  const options = (teachers?.items ?? []).map((t) => ({ value: t.user_id, label: t.full_name }))

  return (
    <div className="mt-6 border-t pt-5">
      <p className="eyebrow mb-1">Assign them to a section</p>
      <p className="mb-3 text-[14px] text-muted-foreground">
        This is the step that grants access. Pick a section, name its class teacher, and put a
        teacher against each subject.
      </p>

      {/* Why the step still says "not done yet" after a successful staff
          import.

          This step counts teachers who are *assigned*, not teachers who exist,
          and the panel offered a staff importer whose success moved that
          number not at all. Somebody uploads ten staff, sees "10 added", and
          then reads "Not done yet" with nothing on the page connecting the
          two. Saying it plainly costs one line. */}
      <div className="mb-4 rounded-md border bg-muted/40 px-3 py-2.5 text-[13px]">
        <b>{assignedSections} of {sections?.items.length ?? 0}</b> sections have a class
        teacher.
        {assignedSections === 0 && (teachers?.items.length ?? 0) > 0 && (
          <>
            {' '}You have <b>{teachers!.items.length}</b> staff on the roll and none of them
            assigned yet — adding staff does not finish this step, assigning them does.
          </>
        )}
        {(teachers?.items.length ?? 0) === 0 && ' Add your staff first, below.'}
      </div>

      <Field label="Section">
        <Select
          value={sectionID}
          onChange={(x) => {
            setSectionID(x)
            setClassTeacher('')
            setSubjectTeachers({})
          }}
          placeholder="Choose a section"
          options={(sections?.items ?? []).map((s) => ({
            value: s.id,
            label: `${s.class_name}-${s.name}${s.class_teacher ? ` · ${s.class_teacher}` : ' · no class teacher'}`,
          }))}
        />
      </Field>

      {section && (
        <>
          <div className="mt-4">
            <Field
              label="Class teacher"
              hint="Marks the daily register and sees the whole section."
            >
              <Select
                value={classTeacher}
                onChange={setClassTeacher}
                placeholder={section.class_teacher ?? 'Nobody yet'}
                options={options}
              />
            </Field>
          </div>

          <p className="eyebrow mb-2 mt-4">Subject teachers</p>
          <div className="space-y-2">
            {(subjects?.items ?? []).map((cs) => (
              <div key={cs.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                <span className="text-[14px]">{cs.subject_name}</span>
                <Select
                  value={subjectTeachers[cs.id] ?? ''}
                  onChange={(x) => setSubjectTeachers({ ...subjectTeachers, [cs.id]: x })}
                  placeholder={cs.a_teacher ?? 'Unassigned'}
                  options={options}
                />
              </div>
            ))}
            {subjects?.items.length === 0 && (
              <p className="text-[14px] text-muted-foreground">
                This class has no subjects mapped yet — go back to that step first.
              </p>
            )}
          </div>

          <FormNotice error={save.error} />
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !sectionID}
          >
            {save.isPending ? 'Assigning…' : 'Save assignments'}
          </Button>
        </>
      )}
    </div>
  )
}

// --- 10. students -----------------------------------------------------------

function StudentsPanel({ onDone }: PanelProps) {
  /* Both cards used to be plain links to routes this account cannot reach:
     one to a section slug that does not exist (students_admissions), the other
     into /super_admin, which is not in a principal's catalogue at all. A
     principal clicking either was bounced back to their dashboard, which reads
     as "adding students is broken" rather than "that link was wrong".

     So the import happens here, on the step, rather than sending anybody
     anywhere — and the one link that remains goes to a screen the catalogue
     says this role actually has. */
  return (
    <div className="space-y-4 text-[14px]">
      <p className="text-muted-foreground">
        Two ways in, and for a school moving off paper the second is the only realistic one.
      </p>

      <BulkImport
        entity="students"
        endpoint="/api/v1/students/import"
        templateUrl="/api/v1/students/import/template"
        title="Import your student list"
        hint="Checked row by row and shown to you before anything is written. Guardians and section placement come across in the same file."
        onDone={onDone}
      />

      <AdmitStudent onDone={onDone} />
    </div>
  )
}

function GradingPanel({ onDone }: PanelProps) {
  type Band = { grade: string; min_percent: number; max_percent: number; grade_point: number }
  const [name, setName] = useState('')
  const [bands, setBands] = useState<Band[]>([])
  const save = useSave(
    (body: { name: string; is_default: boolean; bands: Band[] }) => api.post('/api/v1/setup/grading-scales', body),
    onDone,
  )

  /* What the bands do not cover, said before the server refuses them.

     The server rejects overlapping bands and names the two that clash, which
     is right but arrives after a save. A gap is the quieter fault: 0-34 and
     36-100 saves happily and then produces a child with 35% and no grade at
     all on their report card. */
  const gap = (() => {
    if (bands.length < 2) return ''
    const sorted = [...bands].sort((a, b) => a.min_percent - b.min_percent)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].min_percent > sorted[i - 1].max_percent + 1) {
        return `nothing covers ${sorted[i - 1].max_percent + 1}–${sorted[i].min_percent - 1}%`
      }
    }
    if (sorted[0].min_percent > 0) return `nothing covers 0–${sorted[0].min_percent - 1}%`
    if (sorted[sorted.length - 1].max_percent < 100)
      return `nothing covers ${sorted[sorted.length - 1].max_percent + 1}–100%`
    return ''
  })()

  // The SSC ten-point scale. Grade points matter: the CGPA on a Telangana
  // memo is their average, not an average of percentages.
  const cce = () => {
    setName('CCE 10-point (BSE Telangana)')
    setBands([
      { grade: 'A1', min_percent: 91, max_percent: 100, grade_point: 10 },
      { grade: 'A2', min_percent: 81, max_percent: 90, grade_point: 9 },
      { grade: 'B1', min_percent: 71, max_percent: 80, grade_point: 8 },
      { grade: 'B2', min_percent: 61, max_percent: 70, grade_point: 7 },
      { grade: 'C1', min_percent: 51, max_percent: 60, grade_point: 6 },
      { grade: 'C2', min_percent: 41, max_percent: 50, grade_point: 5 },
      { grade: 'D1', min_percent: 35, max_percent: 40, grade_point: 4 },
      { grade: 'D2', min_percent: 0, max_percent: 34, grade_point: 3 },
    ])
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ name, is_default: true, bands })
      }}
    >
      <div className="mb-4">
        <Preset onClick={cce}>The SSC ten-point scale</Preset>
      </div>
      <Field label="Scale name" required>
        <Input value={name} onChange={setName} placeholder="CCE 10-point" />
      </Field>
      {bands.length > 0 && (
        <div className="mt-4 space-y-2">
          {bands.map((b, i) => (
            <div key={i} className="grid grid-cols-[4rem_5rem_5rem_5rem_auto] items-center gap-2 text-[14px]">
              <Input value={b.grade} onChange={(x) => setBands(bands.map((v, j) => (i === j ? { ...v, grade: x } : v)))} />
              <Input
                value={String(b.min_percent)}
                onChange={(x) => setBands(bands.map((v, j) => (i === j ? { ...v, min_percent: Number(x) } : v)))}
              />
              <Input
                value={String(b.max_percent)}
                onChange={(x) => setBands(bands.map((v, j) => (i === j ? { ...v, max_percent: Number(x) } : v)))}
              />
              <Input
                value={String(b.grade_point)}
                onChange={(x) => setBands(bands.map((v, j) => (i === j ? { ...v, grade_point: Number(x) } : v)))}
              />
              <button
                type="button"
                onClick={() => setBands(bands.filter((_, j) => j !== i))}
                className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-destructive"
                aria-label={`Remove the ${b.grade || 'blank'} band`}
              >
                remove
              </button>
            </div>
          ))}
          <p className="text-[13px] text-muted-foreground">Grade · from % · to % · grade point</p>
        </div>
      )}

      {/* A preset is a starting point, not the scale.
          The eight CCE bands were the only rows there were, so a school with
          an A+ at the top or an F at the bottom — or one running a five-band
          scale of its own — could edit the labels and never change how many
          there were. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            // A new band starts below the lowest one, because that is where a
            // school adding an F puts it, and pre-filling the numbers saves
            // working out what is still uncovered.
            const lowest = bands.length ? Math.min(...bands.map((b) => b.min_percent)) : 101
            setBands([
              ...bands,
              { grade: '', min_percent: 0, max_percent: Math.max(lowest - 1, 0), grade_point: 0 },
            ])
          }}
        >
          + Another band
        </Button>
        {bands.length > 0 && (
          <span className="text-[13px] text-muted-foreground">
            {bands.length} {bands.length === 1 ? 'band' : 'bands'}
            {gap && <span className="text-destructive"> · {gap}</span>}
          </span>
        )}
      </div>

      <SaveRow pending={save.isPending} error={save.error} label="Save grading scale" />
    </form>
  )
}

// --- 12. fee heads ----------------------------------------------------------

const COMMON_HEADS = [
  { name: 'Tuition Fee', code: 'TUIT', recurring: true },
  { name: 'Admission Fee', code: 'ADM', recurring: false },
  { name: 'Transport Fee', code: 'TRAN', recurring: true },
  { name: 'Books & Stationery', code: 'BOOK', recurring: false },
  { name: 'Uniform', code: 'UNIF', recurring: false },
  { name: 'Examination Fee', code: 'EXAM', recurring: false },
  { name: 'Laboratory Fee', code: 'LAB', recurring: true },
  { name: 'Computer Lab Fee', code: 'COMP', recurring: true },
  { name: 'Library Fee', code: 'LIB', recurring: true },
  { name: 'Hostel Fee', code: 'HOST', recurring: true },
  { name: 'Mess Charges', code: 'MESS', recurring: true },
]

function FeeHeadsPanel({ onDone }: PanelProps) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const save = useSave(async () => {
    for (const h of COMMON_HEADS.filter((h) => picked.has(h.code))) {
      await api.post('/api/v1/setup/fee-heads', { name: h.name, code: h.code, is_recurring: h.recurring })
    }
  }, onDone)

  const toggle = (c: string) => {
    const n = new Set(picked)
    n.has(c) ? n.delete(c) : n.add(c)
    setPicked(n)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined as never)
      }}
    >
      <p className="mb-4 text-[14px] text-muted-foreground">
        A head is a line on a receipt. Keep them few — every extra head is another column in every
        collection report for the rest of the year.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {COMMON_HEADS.map((h) => (
          <button
            key={h.code}
            type="button"
            onClick={() => toggle(h.code)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
              picked.has(h.code) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
            )}
          >
            {h.name}
          </button>
        ))}
      </div>
      <SaveRow pending={save.isPending} error={save.error} label={`Add ${picked.size || ''} fee heads`} />
    </form>
  )
}

// --- 13. fee structures -----------------------------------------------------

function FeeStructuresPanel({ onDone }: PanelProps) {
  const { data: classes } = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const { data: heads } = useQuery({
    queryKey: ['fee-heads'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/setup/fee-heads'),
  })
  const [name, setName] = useState('')
  const [classID, setClassID] = useState('')
  const [instalments, setInstalments] = useState('3')
  const [amounts, setAmounts] = useState<Record<string, string>>({})

  const save = useSave(async () => {
    const n = Math.max(1, Number(instalments) || 1)
    const items: { fee_head_id: string; instalment_no: number; amount_paise: number; due_on?: string }[] = []
    for (const [headID, rupees] of Object.entries(amounts)) {
      const total = rupeesToPaise(rupees)
      if (!total) continue
      // Split evenly, then push the rounding remainder onto the first
      // instalment so the instalments always sum back to the annual figure.
      const each = Math.floor(total / n)
      for (let i = 1; i <= n; i++) {
        items.push({ fee_head_id: headID, instalment_no: i, amount_paise: i === 1 ? total - each * (n - 1) : each })
      }
    }
    await api.post('/api/v1/setup/fee-structures', { name, class_id: classID || undefined, items })
  }, onDone)

  const total = Object.values(amounts).reduce((a, r) => a + (parseFloat(r) || 0), 0)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined as never)
      }}
    >
      <FormGrid>
        <Field label="Structure name" required>
          <Input value={name} onChange={setName} placeholder="Class 6 — 2026-27" />
        </Field>
        <Field label="Class" hint="Leave blank to apply to every class.">
          <Select
            value={classID}
            onChange={setClassID}
            placeholder="Every class"
            options={(classes?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <Field label="Instalments" hint="Annual amounts below are divided into this many terms.">
          <Input value={instalments} onChange={setInstalments} />
        </Field>
      </FormGrid>

      <p className="eyebrow mb-2 mt-4">Annual amount per head</p>
      <div className="space-y-2">
        {(heads?.items ?? []).map((h) => (
          <div key={h.id} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-2">
            <span className="text-[14px]">{h.name}</span>
            <Input
              value={amounts[h.id] ?? ''}
              onChange={(x) => setAmounts({ ...amounts, [h.id]: x })}
              placeholder="₹ per year"
            />
          </div>
        ))}
      </div>
      {total > 0 && (
        <p className="mt-3 text-[14px]">
          <span className="text-muted-foreground">Annual total </span>
          <span className="tabular-nums">₹{total.toLocaleString('en-IN')}</span>
          <span className="text-muted-foreground">
            {' '}
            · {instalments} instalments of about ₹{Math.round(total / (Number(instalments) || 1)).toLocaleString('en-IN')}
          </span>
        </p>
      )}
      <SaveRow pending={save.isPending} error={save.error} label="Create structure" />
    </form>
  )
}

// --- 14. exams --------------------------------------------------------------

function ExamsPanel({ onDone }: PanelProps) {
  const { data: classes } = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
  })
  const [f, setF] = useState({ name: '', kind: 'formative', cce_component: 'FA1', starts_on: '', ends_on: '', max_marks: '20' })
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const save = useSave(
    () =>
      api.post('/api/v1/setup/exams', {
        ...f,
        max_marks: Number(f.max_marks) || 20,
        class_ids: [...picked],
      }),
    onDone,
  )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined as never)
      }}
    >
      <p className="mb-4 text-[14px] text-muted-foreground">
        Under CCE the four formative assessments are out of 20 and the three summative ones out of
        80. Choosing a component sets the marks for you. A paper is created for every subject each
        selected class studies.
      </p>
      <FormGrid>
        <Field label="Exam name" required>
          <Input value={f.name} onChange={(x) => setF({ ...f, name: x })} placeholder="Formative Assessment 1" />
        </Field>
        <Field label="CCE component">
          <Select
            value={f.cce_component}
            onChange={(x) =>
              setF({
                ...f,
                cce_component: x,
                kind: x.startsWith('FA') ? 'formative' : 'summative',
                max_marks: x.startsWith('FA') ? '20' : '80',
              })
            }
            options={[
              { value: 'FA1', label: 'FA1 — formative, 20 marks' },
              { value: 'FA2', label: 'FA2 — formative, 20 marks' },
              { value: 'FA3', label: 'FA3 — formative, 20 marks' },
              { value: 'FA4', label: 'FA4 — formative, 20 marks' },
              { value: 'SA1', label: 'SA1 — summative, 80 marks' },
              { value: 'SA2', label: 'SA2 — summative, 80 marks' },
              { value: 'SA3', label: 'SA3 — summative, 80 marks' },
            ]}
          />
        </Field>
        <Field label="Starts on">
          <Input type="date" value={f.starts_on} onChange={(x) => setF({ ...f, starts_on: x })} />
        </Field>
        <Field label="Ends on">
          <Input type="date" value={f.ends_on} onChange={(x) => setF({ ...f, ends_on: x })} />
        </Field>
      </FormGrid>

      <p className="eyebrow mb-2 mt-4">Classes sitting it</p>
      <div className="flex flex-wrap gap-1.5">
        <Preset onClick={() => setPicked(new Set((classes?.items ?? []).map((c) => c.id)))}>All classes</Preset>
        {(classes?.items ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              const n = new Set(picked)
              n.has(c.id) ? n.delete(c.id) : n.add(c.id)
              setPicked(n)
            }}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
              picked.has(c.id) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
            )}
          >
            {c.name}
          </button>
        ))}
      </div>
      <SaveRow pending={save.isPending} error={save.error} label="Schedule exam" />
    </form>
  )
}

// --- 15. UDISE --------------------------------------------------------------

function UDISEPanel({ onDone }: PanelProps) {
  const { data: cur } = useQuery({
    queryKey: ['institution'],
    queryFn: () => api.get<Profile>('/api/v1/setup/institution'),
  })
  const [code, setCode] = useState('')
  const save = useSave(() => api.put('/api/v1/setup/institution', { ...(cur ?? {}), udise_code: code }), onDone)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(undefined as never)
      }}
    >
      <p className="mb-4 text-[14px] text-muted-foreground">
        The eleven-digit code on your UDISE+ certificate. Every student's record carries it into the
        annual return, so a wrong one is found months later at the district office rather than here.
      </p>
      <Field label="UDISE+ code" required hint="Eleven digits, no spaces.">
        <Input value={code || cur?.udise_code || ''} onChange={setCode} placeholder="36051200145" />
      </Field>
      {cur?.udise_code && (
        <p className="mt-2 text-[13px]">
          <Badge tone="success">Recorded</Badge>
        </p>
      )}
      <SaveRow pending={save.isPending} error={save.error} label="Save code" />
    </form>
  )
}

// --- registry ---------------------------------------------------------------

export const PANELS: Record<string, ComponentType<PanelProps>> = {
  profile: ProfilePanel,
  campus: CampusPanel,
  academic_year: YearPanel,
  classes: ClassesPanel,
  sections: SectionsPanel,
  subjects: SubjectsPanel,
  class_subjects: ClassSubjectsPanel,
  periods: PeriodsPanel,
  staff: StaffPanel,
  students: StudentsPanel,
  grading: GradingPanel,
  fee_heads: FeeHeadsPanel,
  fee_structures: FeeStructuresPanel,
  exams: ExamsPanel,
  udise: UDISEPanel,
}


