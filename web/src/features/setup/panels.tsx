import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ComponentType, type ReactNode, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, KeyRound, Maximize2, Minimize2, Plus, Wand2, X } from 'lucide-react'
import BulkImport from '@/components/BulkImport'
import RoleSelect from '@/components/RoleSelect'
import AdmitStudent from './AdmitStudent'
import { api, type AcademicYear, type Klass, type List, type Section, type Subject } from '@/lib/api'
import { Button, Field, FormGrid, FormNotice, Input, Select, Badge } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useOverlayHistory } from '@/lib/overlay-history'

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

/* THE VERTICAL SCALE, WRITTEN DOWN SO IT STOPS DRIFTING.

   These panels had no unit. Six consecutive gaps down the classes form
   measured 14, 10.5, 5.3, 7, 14.5 and 17.5 -- no two of them alike -- and the
   staff form ran 14, 14, 21, 17.5. Nobody chose any of that. It is what you
   get when `mb-4`, `mb-3`, `mb-1.5`, `mt-2`, `mt-3`, `mt-5` and `mt-6` are
   picked one element at a time, each one reasonable on its own and none of
   them agreeing with the element above it. The eye does not read a 10.5 and a
   14 as two deliberate sizes; it reads them as a page that was not measured.

   The unit is 14px, the root font size this product pins itself to, and the
   scale is that unit halved, whole and doubled:

     7px  (mt-2 / mb-2 / space-y-2)   inside one thing: a header over its own
                                      rows, a list of rows, a label over its
                                      control.
     14px (mt-4 / mb-4)               between things: block to block down a
                                      form, and the air on each side of a
                                      section rule.
     28px (mt-4 border-t pt-4)        between sections, which is the 14 above
                                      the rule plus the 14 below it, so a
                                      section break is literally two units and
                                      not a seventh arbitrary number.

   Anything smaller than 7 belongs to a caption glued to the line above it and
   is not block rhythm. `FormGrid` owns the gap between fields inside a grid
   and lives in ui.tsx; it is one consistent value already and is not ours to
   change from here. */

/** A member of teaching staff as the picker needs them: who they are, what
 *  they teach, and whether they already hold a section of their own. */
interface Teacher {
  user_id: string
  full_name: string
  employee_id: string
  subjects: string
  class_teacher_of?: string
  /** What they type into the sign-in box, and whether that account has a
   *  password yet. An employee imported with an email has an account and no
   *  password: it exists and nobody can sign in as it. */
  sign_in_as: string
  can_sign_in: boolean
  roles: string
}

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
    <div className="mt-4 border-t pt-4">
      <p className="eyebrow mb-2">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({ children, muted, onRemove, busy }: {
  children: ReactNode
  muted?: boolean
  /* A cross on the tag itself.
   *
   * These lists are how a school sees what it has just created, and creating
   * them is exactly when a duplicate or a typo appears -- a class added twice,
   * a section named B when the school calls it Blue. Reading the mistake here
   * and having to go somewhere else to fix it is the gap people give up in.
   *
   * Omitted where the row cannot be removed, so a cross never appears on
   * something that will refuse. */
  onRemove?: () => void
  busy?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[13px]',
        muted && 'text-muted-foreground',
        busy && 'opacity-50',
      )}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          /* The label names what goes, because a row of identical crosses is
             unreadable to anybody using a screen reader, and this is a
             delete. */
          aria-label={`Remove ${typeof children === 'string' ? children : 'this'}`}
          className="-mr-0.5 rounded-sm px-0.5 leading-none text-muted-foreground
                     hover:bg-destructive/10 hover:text-destructive"
        >
          ×
        </button>
      )}
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

/* Saying that it worked.

   Every step here reported failure and nothing else: an error appeared above
   the button, and success looked exactly like not having pressed it. On a
   panel whose whole output is a row of chips that were already the right
   colour, there was no way to tell a save from a mis-click, so people pressed
   it again — which on this particular step rewrites the same set and looks
   identical a third time.

   A dialog rather than a line of green text, because the line is in the place
   people have already stopped looking by the time it appears. It says what
   changed, not just that something did. */
function SavedDialog({ message, onClose }: { message: string; onClose: () => void }) {
  // The phone's Back closes this, like every overlay: see overlay-history.ts.
  /* The hook's return value is what a close control must call. Calling
     onClose directly unmounts first, and the cleanup then spends the
     history entry the hook had pushed -- so the panel closes and the page
     navigates back at the same time. */
  const close = useOverlayHistory(true, onClose)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  /* Portalled: a fixed panel inside a transformed ancestor lays itself out
     against that ancestor, not the viewport, and every card here carries a
     transform while it is pressed. See BulkImport's SheetViewer. */
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={close}
      role="alertdialog"
      aria-modal="true"
      aria-label="Saved"
    >
      <div
        className="w-full max-w-sm rounded-lg border bg-background p-5 text-center shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
          <Check className="h-6 w-6" />
        </div>
        <p className="text-[15px] font-medium">Done</p>
        <p className="mt-1 text-[13.5px] text-muted-foreground">{message}</p>
        <Button className="mt-4 w-full" onClick={close}>
          Close
        </Button>
      </div>
    </div>
    ,
    document.body,
  )

}

function SaveRow({
  pending,
  error,
  label = 'Save and continue',
  saved,
  onDismissSaved,
  children,
}: {
  pending: boolean
  error: unknown
  label?: string
  /** What to say once it has worked. Nothing shown when absent. */
  saved?: string | null
  onDismissSaved?: () => void
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
      {saved && onDismissSaved && (
        <SavedDialog message={saved} onClose={onDismissSaved} />
      )}
    </>
  )
}

/* A TICK BOX THAT IS A TARGET IN BOTH DIRECTIONS.

   The touch floor in index.css puts a 44px minimum height on every input, and
   deliberately puts no minimum width on one: a text field is already wide, and
   forcing a width on one sitting in a narrow grid column would shove the whole
   row sideways for nothing. A checkbox is the case that rule was not written
   for. It is not wide already. It is the browser's default 13px square, so the
   two panels here were drawing controls measured at 13 by 44 -- a target three
   times taller than it is wide, which on a phone means a tick that is missed
   sideways while there is dead space above and below it.

   Fixed here rather than in the base rule, because widening every input is
   exactly the harm the base rule is avoiding. Sixteen pixels on a desk, where
   13 was simply small, and the full 44 square under a coarse pointer, which is
   the same "both axes or neither" the shared floor already applies to buttons.
   `shrink-0` because these sit next to a label in a flex row and a squeezed
   checkbox is a checkbox nobody can tell the state of. */
const CHECKBOX =
  'h-4 w-4 shrink-0 accent-primary [@media(pointer:coarse)]:min-w-[44px]'

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
  /** Every state and union territory, so the field is a choice not a hint. */
  states: string[]
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
        <Field label="Board" required wide hint="Not listed? Add your own at the bottom of the list.">
          <Select
            kind="affiliation_board"
            addLabel="Add another board"
            value={v.affiliation_board ?? ''}
            onChange={(x) => set('affiliation_board', x)}
            placeholder="Choose a board"
            options={(opts?.affiliation_boards ?? []).map((o) => ({ value: o.value, label: o.label }))}
          />
          {/* WHAT THIS CHOICE MEANS, BEFORE IT IS MADE.

              The board used to be a label: nothing in the product branched on
              it, so CBSE and Kerala SSLC produced the same empty grading scale
              and the same 33% nobody had set. It now carries a grading scale —
              and the school reads what that scale is and presses a button,
              because a field that silently rewrote grade bands somebody had
              spent an afternoon building would be the worst kind of help. */}
          <BoardImplications board={v.affiliation_board ?? ''} />
        </Field>
        <Field label="Affiliation number" hint="Leave blank if the application is still pending.">
          <Input value={v.affiliation_no ?? ''} onChange={(x) => set('affiliation_no', x)} />
        </Field>
        {/* A LIST, NOT A HINT.

            State was a free-text box whose placeholder read "Telangana", and
            district was an input with a <datalist> behind it. A datalist is a
            suggestion, not a choice: nothing shows until you start typing, and
            on Android Chrome — which is most of the people filling this in —
            it frequently does not appear at all. So the thirty-three districts
            were served, correct and effectively invisible, and everybody typed.

            Typed is how one state becomes four values: "Telangana",
            "TELANGANA", "Telengana", "TS". Every report grouping by state then
            shows four rows for one place, and no join against a district
            master will ever line up.

            Both are real dropdowns now. The Select carries `kind`, which is
            this product's escape hatch for school-defined additions — a school
            in a district we have not listed adds its own from the bottom of
            the list rather than being blocked by it. That is the same
            behaviour the board and management fields already have. */}
        <Field label="State" required>
          <Select
            kind="state"
            addLabel="Add another state"
            value={v.state ?? ''}
            onChange={(x) => set('state', x)}
            placeholder="Choose a state"
            options={(opts?.states ?? []).map((o: string) => ({ value: o, label: o }))}
          />
        </Field>
        <Field
          label="District"
          required
          hint={
            (v.state ?? '') === 'Telangana' || !v.state
              ? "Telangana's thirty-three. Add your own if you are elsewhere."
              : 'Add your own district from the bottom of the list.'
          }
        >
          <Select
            kind="district"
            addLabel="Add another district"
            value={v.district ?? ''}
            onChange={(x) => set('district', x)}
            placeholder="Choose a district"
            options={(opts?.telangana_districts ?? []).map((d) => ({ value: d, label: d }))}
          />
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
  const sectionList = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const sections = sectionList.data?.items ?? []
  const qc = useQueryClient()

  /* Removing one of these, from the tag itself.
   *
   * The server refuses a class that still has sections and a section that
   * still has a register, and its refusal names what is in the way -- "2
   * sections and 0 mapped subjects hang off this class". That sentence is
   * more useful than anything this screen could invent, so it is shown as it
   * comes back rather than replaced with "could not delete". */
  const [removing, setRemoving] = useState('')
  const [refused, setRefused] = useState('')

  const remove = async (kind: 'classes' | 'sections', id: string, label: string) => {
    setRefused('')
    setRemoving(id)
    try {
      await api.del(`/api/v1/setup/${kind}/${id}`)
      await qc.invalidateQueries()
    } catch (e) {
      setRefused(`${label}: ${e instanceof Error ? e.message : 'could not be removed.'}`)
    } finally {
      setRemoving('')
    }
  }
  /* A CLASS AND ITS SECTIONS ARE ONE THOUGHT.
   *
   * Sections used to be a step of their own: name Class 1 to 10, move on, then
   * come back and give each of the ten its A and B and a capacity. Nobody
   * decides their classes without already knowing how many sections each has,
   * and the second screen is the one people leave half done -- which is how a
   * school ends up with classes no child can be enrolled into.
   *
   * The level is gone from the form too. It orders the school and it is
   * already in the name: somebody typing "Grade 6" was then asked to type 6,
   * which is asking a person to restate what they just wrote and to be blamed
   * when the two disagree. It is read from the name on the server. */
  type Row = { name: string; sections: string; capacity: string }
  const [rows, setRows] = useState<Row[]>([{ name: '', sections: 'A', capacity: '40' }])

  const save = useSave(async (list: Row[]) => {
    // Sequential rather than parallel: these create sections too, and a burst
    // of concurrent inserts makes a failure harder to attribute to a row.
    for (const r of list) {
      if (!r.name.trim()) continue
      await api.post('/api/v1/setup/classes', {
        name: r.name.trim(),
        sections: r.sections.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
        capacity: Number(r.capacity) || 40,
      })
    }
  }, onDone)

  const preset = (from: number, to: number, label: (n: number) => string) =>
    setRows(
      Array.from({ length: to - from + 1 }, (_, i) => ({
        name: label(from + i),
        sections: 'A',
        capacity: '40',
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
              { name: 'Nursery', sections: 'A', capacity: '30' },
              { name: 'LKG', sections: 'A', capacity: '30' },
              { name: 'UKG', sections: 'A', capacity: '30' },
              ...Array.from({ length: 5 }, (_, i) => ({
                name: `Class ${i + 1}`, sections: 'A', capacity: '40',
              })),
            ])
          }
        >
          Pre-primary and 1–5
        </Preset>
      </div>

      <p className="mb-4 text-[14px] text-muted-foreground">
        Sections go in here with the class. Write them as you say them - A, B,
        or Rose, Newton - separated by commas. The order of classes is read
        from the name, so Class 10 sorts below Class 9 with nothing to fill in.
      </p>

      {/* Headers, because two time boxes side by side with nothing above them
          is a guess about which is which — and the wrong guess writes a period
          that ends before it starts. Hidden when the list is empty, where they
          would be a table header over no table. */}
      {/* Headers, because three boxes in a row with nothing above them is a
          guess about which is which. */}
      {/* NO PADDING ON THE HEADER ROW.

          The header and the rows beneath it are two separate grids that agree
          only because they are given the same track list. The header carried
          `px-1`, which is 3.5px at this root size, so its three tracks were
          resolved against 3.5px less width than the body's: 455/455/84 against
          458.5/458.5/84. The headings then drifted in opposite directions --
          "Class" 3.5px right of its input, "Seats each" 3.5px left of its own,
          and only the middle column, which happens to sit at the midpoint the
          drift pivots around, ever lined up. Padding on one of two grids that
          are meant to share a column geometry is padding that breaks it. */}
      {rows.length > 0 && (
        <div className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem] gap-2
                        text-[12px] font-medium text-muted-foreground">
          <span>Class</span>
          <span>Sections</span>
          <span>Seats each</span>
        </div>
      )}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem] gap-2">
            <Input
              value={r.name}
              onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, name: x } : v)))}
              placeholder="Class 6"
            />
            <Input
              value={r.sections}
              onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, sections: x } : v)))}
              placeholder="A, B"
            />
            <Input
              value={r.capacity}
              onChange={(x) => setRows(rows.map((v, j) => (i === j ? { ...v, capacity: x } : v)))}
              placeholder="40"
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setRows([...rows, { name: '', sections: 'A', capacity: '40' }])}
        className="tap-inline mt-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
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
            <Chip
              key={c.id}
              busy={removing === c.id}
              onRemove={() => remove('classes', c.id, c.name)}
            >
              {c.name}
            </Chip>
          ))}
        </Existing>
      )}

      {/* THE SECTIONS THAT EXIST, ON THE STEP THAT OWNS THEM.

          Renaming one, changing its seats and removing an empty one all lived
          on the separate sections step. Folding that step in without bringing
          this would have removed the only place a school could rename Rose to
          Blue -- a capability quietly lost while collapsing two screens into
          one, which is the usual way tidying a product costs it something. */}
      {refused && (
        <p className="mt-3 text-[13px] text-destructive">{refused}</p>
      )}

      {sections.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1.5 text-muted-foreground">Sections</p>
          <div className="space-y-1.5">
            {existing.map((c) => {
              const mine = sections.filter((x) => x.class_id === c.id)
              if (!mine.length) return null
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-24 flex-none text-[13px] text-muted-foreground">
                    {c.name}
                  </span>
                  {mine.map((sec) => (
                    <EditableSection key={sec.id} section={sec} />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
          <div className="mt-4 border-t pt-4">
        {/* ONE SHEET, NOT TWO.

            There were two boxes here: the classes, then the sections against
            the classes you had just made. The second only works once the
            first has landed, so doing them in the wrong order rejected every
            row for a class that did not exist yet -- which reads as the file
            being wrong rather than the order. */}
        <BulkImport
          entity="classes"
          title="Classes and sections from a sheet"
          hint="Three columns: the class, its sections, and how many seats each holds. Only the class name is required — a school that has not decided its sections yet can add them later."
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

      <div className="mt-4 border-t pt-4">
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

      <div className="mt-4 border-t pt-4">
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

/* The subject list and what studies it, on one step.
 *
 * These were two steps and the second needed the first, so a school that
 * started with the mapping sheet had every row rejected for a subject written
 * on the page in front of them. Picking the subjects is still worth its own
 * block -- the Telangana list is two clicks and typing it out is twenty -- so
 * it sits above the mapping rather than being folded into it.
 */
function SubjectsAndMapping({ onDone }: PanelProps) {
  return (
    <div className="space-y-5">
      <SubjectsPanel onDone={onDone} />
      <div className="border-t pt-5">
        <ClassSubjectsPanel onDone={onDone} />
      </div>
    </div>
  )
}

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

  const [saved, setSaved] = useState<string | null>(null)
  const save = useSave(async () => {
    const ids = [...picked]
    const targets = applyAll ? (classes?.items ?? []).map((c) => c.id) : [classID]
    for (const cid of targets) {
      if (!cid) continue
      await api.put('/api/v1/setup/class-subjects', { class_id: cid, subject_ids: ids })
    }
    const subject = ids.length === 1 ? 'subject' : 'subjects'
    setSaved(
      applyAll
        ? `All ${targets.length} classes now study the same ${ids.length} ${subject}.`
        : `${classes?.items.find((c) => c.id === classID)?.name ?? 'This class'} now studies ` +
          `${ids.length} ${subject}.`,
    )
  }, onDone)

  /* Adding a subject without leaving the step.
   *
   * The chips were the whole list and there was no way to extend it here: a
   * school that gets to this step and finds Sanskrit missing had to go back
   * two steps, add it, and come forward again — losing the class they had
   * chosen on the way. It is the same endpoint the subjects step uses, and
   * the new one arrives already ticked, because somebody who just typed it
   * means this class to study it. */
  const qc = useQueryClient()
  const [newSubject, setNewSubject] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const addSubject = async () => {
    const name = newSubject.trim()
    if (!name) return
    setAdding(true)
    setAddError('')
    try {
      // No code sent: the server derives one. A school types "Sanskrit", not
      // "SAN", and being asked for an abbreviation it has no convention for
      // is the kind of question that stops somebody mid-task.
      const made = await api.post<{ id: string }>('/api/v1/setup/subjects', {
        name,
        is_scholastic: true,
      })
      setNewSubject('')
      await qc.invalidateQueries({ queryKey: ['subjects'] })
      if (made?.id) setPicked((prev) => new Set(prev).add(made.id))
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not add that subject.')
    } finally {
      setAdding(false)
    }
  }

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
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
        <Field label="Not in the list? Add a subject">
          <Input
            value={newSubject}
            onChange={setNewSubject}
            placeholder="Sanskrit"
            className="w-56"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          disabled={!newSubject.trim() || adding}
          onClick={() => void addSubject()}
        >
          <Plus className="h-3.5 w-3.5" />
          {adding ? 'Adding…' : 'Add subject'}
        </Button>
        <span className="text-[12.5px] text-muted-foreground">
          It joins the list above, already selected for this class.
        </span>
      </div>
      {addError && <p className="mt-1 text-[13px] text-destructive">{addError}</p>}
      <SaveRow
        pending={save.isPending}
        error={save.error}
        label="Save mapping"
        saved={saved}
        onDismissSaved={() => setSaved(null)}
      />
      <div className="mt-4 border-t pt-4">
        <BulkImport
          entity="class_subjects"
          title="Classes, subjects and teachers from a sheet"
          hint="Class, subject, and the teacher who takes it. A subject the school has not added yet is created from this sheet, and naming a teacher assigns them to every section of that class — so one file does the whole job."
          onDone={onDone}
        />
      </div>
      {/* THE ALLOCATION SHEET LIVES HERE, not under Add staff.

          It was in the staff panel, beneath the form that registers people,
          which made that step two jobs: appointing somebody, and deciding what
          they teach. Those are not the same desk and usually not the same day
          — the staff sheet needs hr.employees.write and this one needs
          academics.write, and no role but the principal holds both.

          Here it sits with the other sheet about what a class studies, which
          is what it is. The ordering that actually matters is stated where it
          bites: it finds teachers by email, so the people have to exist
          first. */}
      <div className="mt-4 border-t pt-4">
        <BulkImport
          entity="allocations"
          title="Allocation sheet — who teaches what, where"
          hint="The head of department or the principal. Class, section, room, class teacher, subject and subject teacher. It finds teachers by email, so register the staff first — otherwise those rows are skipped and named. Every column but the class and section is optional."
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
  /* WHOSE DAY IS BEING EDITED.
   *
   * Empty means the school's own, which is what this panel has always been
   * and what a school running one bell keeps. Named, it is a second day --
   * primary starting later and finishing earlier, a shift, a pre-school -- and
   * the classes ticked below run to it.
   *
   * The classes are asked here rather than on a screen of their own because
   * somebody typing the primary timings is thinking about which classes are
   * primary at that exact moment. Asking again later is how a second day gets
   * created and never used by anybody. */
  const [scheduleName, setScheduleName] = useState('')
  const [forClasses, setForClasses] = useState<Record<string, boolean>>({})

  const schedules = useQuery({
    queryKey: ['bell-schedules'],
    queryFn: () => api.get<List<{
      id: string; name: string; is_default: boolean; periods: number
      starts_at?: string; ends_at?: string; classes: string
    }>>('/api/v1/timetable/bell-schedules'),
  })
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/academics/classes'),
  })

  const save = useSave((periods: P[]) => api.put('/api/v1/setup/periods', {
    periods,
    schedule_name: scheduleName.trim() || undefined,
    class_ids: Object.entries(forClasses).filter(([, on]) => on).map(([id]) => id),
  }), onDone)

  /* THE SAVED DAY HAS TO ARRIVE IN THE FORM.

     The query above has always fetched the school's periods, and the form has
     always started at []. So a school that had already defined its day opened
     this panel to an empty box with no times in it anywhere — the saved bells
     were rendered underneath as read-only chips, which reads as "there is
     nothing here to edit" rather than as "your day is below but you cannot
     touch it". The only way to see a time field at all was to press the preset,
     which overwrites the real day with a generic one.

     Seeded once, and only while the form is untouched. `seeded` is a ref rather
     than a dependency so that a refetch — after saving, or on window focus —
     cannot discard what somebody is halfway through typing. That is the trap
     with this pattern: an effect keyed on `data` looks correct and silently
     reverts an edit the moment React Query revalidates. */
  const seeded = useRef(false)
  const otherDays = (schedules.data?.items ?? []).filter((x) => !x.is_default)
  useEffect(() => {
    if (seeded.current || !data?.items?.length) return
    seeded.current = true
    setRows(
      data.items.map((p, i) => ({
        name: p.name,
        sequence: p.sequence ?? i + 1,
        // internal/api/timetable.go:72 formats these as to_char(...,'HH24:MI'),
        // so they arrive as HH:MM already. Sliced anyway: a time input handed
        // seconds shows nothing at all rather than complaining, and this panel
        // has just spent a release being empty for exactly that class of
        // reason.
        starts_at: (p.starts_at ?? '').slice(0, 5),
        ends_at: (p.ends_at ?? '').slice(0, 5),
        is_break: p.is_break,
      })),
    )
  }, [data])

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

      {/* THE SCHOOL THAT DOES NOT RUN ONE BELL.

          Primary starts later, finishes earlier and takes a longer lunch. A
          timetable that has Grade 1 changing lesson at 11:30 with Grade 10 is
          one the primary staff ignore, and once they ignore it attendance is
          being marked against periods nobody sat.

          Left alone this is the school's own day, which is what it has always
          been. Only a school that needs a second one has to read any of it. */}
      <div className="mb-4 rounded-lg border p-3">
        {/* THE BOXES ARE THE CONTROL, not a thing behind a text field.

            These were hidden until somebody typed a name, so the one question
            worth asking on this step — which classes are these timings for
            — was invisible until you had already guessed that naming a day
            was how you got there. Nobody guesses that.

            So the classes are the first thing, and always shown. Choose none
            and this is the whole school's day, which is what it has always
            been and what most schools want. Choose some and it becomes their
            own day, and only then does it need a name. */}
        <div>
          <p className="eyebrow mb-1.5 text-muted-foreground">
            Which classes run to these timings
          </p>
            {/* BOXES, NOT A COLUMN OF TICKS.

                A school picking the primary timings is choosing a run of
                classes -- Nursery through Class 5 -- and a list of fourteen
                checkboxes makes that fourteen separate decisions read one at a
                time. As boxes they are one shape the eye can sweep, and the
                ones already chosen are visible without reading a word.

                "All" earns its place for the school that runs a single
                afternoon shift: without it, choosing every class is fourteen
                clicks to say one thing. */}
            <div className="flex flex-wrap items-center gap-1.5">
              {(() => {
                const all = classes.data?.items ?? []
                const chosen = all.filter((c) => forClasses[c.id]).length
                const every = chosen === all.length && all.length > 0
                return (
                  <button
                    type="button"
                    onClick={() => setForClasses(
                      every ? {} : Object.fromEntries(all.map((c) => [c.id, true])))}
                    className={cn(
                      'rounded-sm border px-2 py-1 text-[13px] font-medium',
                      every
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {every ? 'None' : 'All'}
                  </button>
                )
              })()}
              {(classes.data?.items ?? []).map((c) => {
                const on = !!forClasses[c.id]
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setForClasses({ ...forClasses, [c.id]: !on })}
                    className={cn(
                      'rounded-sm border px-2 py-1 text-[13px]',
                      on
                        ? 'border-primary bg-primary/10 font-medium text-primary'
                        : 'hover:bg-accent',
                    )}
                  >
                    {c.name}
                  </button>
                )
              })}
            </div>
          {/* What the current choice means, said in the words somebody
              would use rather than left to be worked out from an empty set. */}
          {(() => {
            const all = classes.data?.items ?? []
            const chosen = all.filter((c) => forClasses[c.id]).length
            if (chosen === 0 || chosen === all.length) {
              return (
                <p className="mt-2 text-[12.5px] text-muted-foreground">
                  These are the whole school&rsquo;s timings.
                </p>
              )
            }
            return (
              <div className="mt-3">
                <FormGrid>
                  <Field
                    label="Call this day"
                    hint="A name for these timings, so the rest of the school keeps its own."
                  >
                    <Input
                      value={scheduleName}
                      onChange={setScheduleName}
                      placeholder="Primary"
                    />
                  </Field>
                </FormGrid>
                {!scheduleName.trim() && (
                  <p className="mt-1.5 text-[12.5px] text-warning">
                    Give these timings a name, or they will overwrite the
                    whole school&rsquo;s day.
                  </p>
                )}
              </div>
            )
          })()}
        </div>

        {otherDays.length > 0 && (
          <div className="mt-3 border-t pt-2.5 text-[12.5px] text-muted-foreground">
            {otherDays.map((d) => (
              <p key={d.id}>
                <span className="font-medium text-foreground">{d.name}</span>
                {d.starts_at ? ` ${d.starts_at}–${d.ends_at}` : ''}
                {' · '}
                {d.classes || 'no class runs to it yet'}
              </p>
            ))}
          </div>
        )}
      </div>

      <p className="mb-4 text-[14px] text-muted-foreground">
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
                className={CHECKBOX}
                checked={r.is_break}
                onChange={(e) => setRows(rows.map((v, j) => (i === j ? { ...v, is_break: e.target.checked } : v)))}
              />
              break
            </label>
          </div>
        ))}
      </div>
      {rows.length === 0 && (
        <p className="rounded-[3px] border border-dashed px-4 py-6 text-center text-[13.5px]
                      text-muted-foreground">
          No periods yet. Start from the seven-period day above, or add them one at a time.
        </p>
      )}
      <button
        type="button"
        onClick={() =>
          setRows([...rows, { name: `Period ${rows.length + 1}`, sequence: rows.length + 1, starts_at: '', ends_at: '', is_break: false }])
        }
        className="tap-inline mt-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
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
      {/* The importer for this has existed the whole time with nothing on any
          screen calling it. A school with a nine-period day and a second set
          of timings for the primary section was typing eighteen rows by hand
          past an endpoint that would have taken the file. */}
      <div className="mt-4 border-t pt-4">
        <BulkImport
          entity="periods"
          title="Or the day from a sheet"
          hint="Sequence, name, start, end, and whether it is a break. Breaks are listed too: the timetable needs them to know a teacher is free."
          onDone={onDone}
        />
      </div>
    </form>
  )
}

// --- 9. staff ---------------------------------------------------------------

function StaffPanel({ onDone }: PanelProps) {
  const { data: teachers } = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/timetable/teachers'),
  })
  const [f, setF] = useState({
    employee_code: '',
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    role_key: 'faculty',
    role_keys: [] as string[],
    create_login: true,
  })
  /* WHAT ACTUALLY HAPPENED, said out loud.

     The endpoint upserts on employee code, and this form reported success for
     both outcomes. A clerk typing a code already in use -- T-014 is somebody
     who left last year -- pressed Add, saw the fields clear, and no new person
     existed; the old employee had quietly been renamed to the new one.

     "Add staff is not working" is what that looks like from the office, and it
     was true: nothing was added. The server now says which it did, and this
     says so. */
  const [outcome, setOutcome] = useState<string | null>(null)
  const save = useSave(
    async (body: typeof f) =>
      api.post<{ created: boolean; employee_code: string }>('/api/v1/setup/employees', body),
    () => {
      setF({ ...f, employee_code: '', first_name: '', last_name: '', email: '', phone: '' })
      onDone()
    },
  )
  useEffect(() => {
    const d = save.data as { created?: boolean; employee_code?: string } | undefined
    if (!d) return
    setOutcome(
      d.created
        ? `Added ${d.employee_code}.`
        : `${d.employee_code} already existed — that record was updated, not added.`,
    )
  }, [save.data])

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
          <RoleSelect
            value={f.role_key}
            onChange={(x) => setF({ ...f, role_key: x, role_keys: f.role_keys.filter((k) => k !== x) })}
            extra={f.role_keys}
            onExtra={(v) => setF({ ...f, role_keys: v })}
          />
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
      {outcome && (
        <p className="mt-2 text-[13.5px] text-muted-foreground" role="status">
          {outcome}
        </p>
      )}
      {(teachers?.items.length ?? 0) > 0 && <StaffLogins staff={teachers!.items} />}
      <Assignments onDone={onDone} />
          <div className="mt-4 border-t pt-4">
        <BulkImport
          entity="staff"
          title="Staff sheet — who works here"
          hint="HR or the principal. Employee code and first name are required; give an email and a role and they get a login too. This sheet creates the people. Putting them in front of a class is the allocation sheet, under Class subjects."
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
      api.get<List<Teacher>>('/api/v1/timetable/teachers'),
  })
  const [sectionID, setSectionID] = useState('')
  const section = sections?.items.find((s) => s.id === sectionID)
  // What the step is actually measured on, shown where somebody can see it.
  const assignedSections = (sections?.items ?? []).filter((x) => x.class_teacher).length
  const { data: subjects } = useQuery({
    queryKey: ['class-subjects', section?.class_id],
    queryFn: () =>
      api.get<List<{ id: string; subject_id: string; subject_name: string; a_teacher?: string }>>(
        `/api/v1/setup/class-subjects?class_id=${section!.class_id}`,
      ),
    enabled: !!section,
  })
  /* Only the teachers free to take a section.
   *
   * One person cannot be class teacher of two sections at once, and the list
   * offered everybody for every section — so the mistake was one click away
   * with nothing on screen warning of it. The section being edited is
   * excluded from the exclusion, or whoever already holds it would vanish
   * from their own row.
   *
   * Deliberately not applied to the subject pickers: the class teacher of 6-A
   * teaches subjects in other sections, and hiding them there is the opposite
   * mistake. */
  const { data: freeTeachers } = useQuery({
    queryKey: ['teachers', 'free', sectionID],
    queryFn: () =>
      api.get<List<Teacher>>(
        `/api/v1/timetable/teachers?free_class_teacher=true${
          sectionID ? `&except_section=${sectionID}` : ''
        }`,
      ),
  })

  const [classTeacher, setClassTeacher] = useState('')
  const [room, setRoom] = useState('')
  const [subjectTeachers, setSubjectTeachers] = useState<Record<string, string>>({})

  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: async () => {
      // The room rides on createSection, which upserts on
      // (class, year, name) — so this edits the section rather than making a
      // second one, and the capacity has to travel with it or the upsert
      // would overwrite it with a default.
      if (section && room !== (section.room ?? '')) {
        await api.post('/api/v1/setup/sections', {
          class_id: section.class_id,
          name: section.name,
          capacity: section.capacity,
          room,
        })
      }
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

  // Named with what they teach, so the list does not require the reader to
  // already know the staff.
  const options = (freeTeachers?.items ?? []).map((t) => ({
    value: t.user_id,
    label: t.subjects ? `${t.full_name} · ${t.subjects}` : t.full_name,
  }))

  return (
    <div className="mt-4 border-t pt-4">
      <p className="eyebrow mb-2">Assign them to a section</p>
      <p className="mb-4 text-[14px] text-muted-foreground">
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
            setRoom(sections?.items.find((v) => v.id === x)?.room ?? '')
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
          {/* The room is a fact about the section and was only settable from a
              sheet: somebody in the office moving 6-B to another room had to
              build a CSV to say so. */}
          <div className="mt-4">
            <Field label="Room" hint="Where this section sits.">
              <Input value={room} onChange={setRoom} placeholder="6A" />
            </Field>
          </div>
          <div className="mt-4">
            <Field
              label="Class teacher"
              hint="Marks the daily register and sees the whole section. Only teachers without a section of their own are listed."
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
                {/* Only the people who teach this subject. The list used to
                    be every member of staff, so the Telugu row offered the
                    accountant. Where a school has recorded nothing, the
                    server falls back to everybody rather than to nothing. */}
                <SubjectTeacherSelect
                  subjectID={cs.subject_id}
                  value={subjectTeachers[cs.id] ?? ''}
                  onChange={(x) => setSubjectTeachers({ ...subjectTeachers, [cs.id]: x })}
                  current={cs.a_teacher}
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


/* THE STEP FOR A SCHOOL THAT IS NOT NEW.

   Every other step in this wizard assumes a school starting from nothing.
   Most are not: they have been running twenty years, they are moving, and the
   first thing they ask is whether their records come with them.

   The order below is the whole point of putting it here rather than leaving
   four importers loose in the application. Each one needs the one above it --
   marks need the child and the subject, a service record needs the person --
   and until now that order existed only inside the error messages you got for
   guessing it wrongly.

   Every file takes as many years as it covers. Three years is three rows per
   child, in one upload; the years and exams named in it are created once
   however many rows mention them. */
function HistoryPanel({ onDone }: PanelProps) {
  return (
    <div className="space-y-4 text-[14px]">
      <p className="text-muted-foreground">
        Only for a school that was running before it came here. A new school
        should skip this entirely — nothing below is required, and the step
        never blocks you.
      </p>

      <div className="rounded-lg border bg-muted/20 p-3 text-[13px]">
        <p className="font-medium">Upload in this order</p>
        {/* Said once, plainly, because getting it wrong is the commonest way
            an import fails: marks for a child who has not been imported yet
            is rejected row by row, and reads as the file being wrong when it
            is only early. */}
        <p className="mt-1 text-muted-foreground">
          Students and staff first — the steps above this one — then their
          history, then results. Each file is checked and shown to you before
          anything is written, and any upload can be taken back out afterwards.
        </p>
      </div>

      <BulkImport
        entity="student_history"
        title="Each child's past years"
        hint="One row per child per year: the class, attendance as a total, and what was billed, paid and waived. Held apart from this year's registers and collection, so a closed year is never counted as today's."
        onDone={onDone}
      />

      {/* The grid first, because it is the sheet a school actually has. The
          row-per-subject file stays for anyone whose export is already in
          that shape. */}
      <MarksGridUpload onDone={onDone} />

      <BulkImport
        entity="marks"
        title="Past exam results, one row per subject"
        hint="One row per child, per exam, per subject. These go into the real exam tables, so a report card for that year prints exactly as it did before. Exams and years named here are created for you; children and subjects are not."
        onDone={onDone}
      />

      <BulkImport
        entity="staff_history"
        title="Staff service before this system"
        hint="One row per person per year: designation, attendance and leave. What the school reads when it writes an experience certificate or settles seniority."
        onDone={onDone}
      />
    </div>
  )
}


/* THE MARK SHEET AS THE STAFF ROOM KEEPS IT.

   The row-per-subject import is the right shape for a database and the wrong
   shape for a school. Forty children across six subjects is two hundred and
   forty rows, and nobody keeps marks that way: the sheet on the table is a
   grid, children down the side, subjects across the top, one mark in a cell.

   Asking somebody to reshape that first is asking them to do by hand, forty
   times, the transformation a computer exists for. Most will not, and the
   year's results stay in the spreadsheet.

   The four facts below describe the whole sheet, so they are asked once. A
   grid has no column for the exam or the class -- it is titled "Grade 5,
   Annual Examination" at the top and every cell belongs to that -- and asking
   per row is how one mistyped cell puts one child in another class. */
function MarksGridUpload({ onDone }: { onDone?: () => void }) {
  const [year, setYear] = useState('')
  const [exam, setExam] = useState('')
  const [cls, setCls] = useState('')
  const [max, setMax] = useState('100')

  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/academics/classes'),
  })

  const ready = year.trim() && exam.trim() && cls.trim() && Number(max) > 0

  return (
    <div className="space-y-3">
      <FormGrid>
        <Field label="Which year" required hint="As the school writes it, e.g. 2024-25.">
          <Input value={year} onChange={setYear} placeholder="2024-25" />
        </Field>
        <Field label="Which examination" required
          hint="Created if the school has never recorded it here.">
          <Input value={exam} onChange={setExam} placeholder="Annual Examination" />
        </Field>
        <Field label="Which class" required
          hint="The class as it is now named. Subjects are checked against it.">
          <Select
            value={cls}
            onChange={setCls}
            placeholder="Choose a class"
            options={(classes.data?.items ?? []).map((c) => ({ value: c.name, label: c.name }))}
          />
        </Field>
        <Field label="Out of" required
          hint="What every paper on this sheet is marked out of.">
          <Input type="number" value={max} onChange={setMax} />
        </Field>
      </FormGrid>

      {ready ? (
        <BulkImport
          entity="marks_grid"
          title="Upload the mark sheet"
          hint="Children down, subjects across — the sheet you already have. Name the subject each marks column holds; leave Total, Rank and Remarks empty, since those are worked out from the marks."
          params={{ year, exam, class: cls, max_marks: max }}
          subjectMapping
          onDone={onDone}
        />
      ) : (
        <p className="rounded-md border border-dashed p-3 text-[13px] text-muted-foreground">
          Fill in the four above and the upload box appears. They describe the
          whole sheet, so they are asked once rather than repeated on every row.
        </p>
      )}
    </div>
  )
}

function GradingPanel({ onDone }: PanelProps) {
  /* The numbers are held as text while they are being typed.

     They used to be numbers, converted on every keystroke with Number(x).
     That makes the box impossible to clear — Number('') is 0, so backspacing
     the last digit puts a 0 back — and any half-typed value that is not yet a
     number becomes NaN, which renders as the word NaN and cannot be deleted
     either, because deleting it produces NaN again.

     A field is a string until somebody has finished with it. These are parsed
     once, on save. */
  type Band = { grade: string; min_percent: string; max_percent: string; grade_point: string }
  type SavedBand = { grade: string; min_percent: number; max_percent: number; grade_point: number }
  const [name, setName] = useState('')
  const [bands, setBands] = useState<Band[]>([])

  // Blank and rubbish both read as zero rather than NaN, so a band somebody
  // left half-finished is saved as something the server can judge.
  const num = (v: string) => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }

  const save = useSave(
    (body: { name: string; is_default: boolean; bands: SavedBand[] }) =>
      api.post('/api/v1/setup/grading-scales', body),
    onDone,
  )

  /* What the bands do not cover, said before the server refuses them.

     The server rejects overlapping bands and names the two that clash, which
     is right but arrives after a save. A gap is the quieter fault: 0-34 and
     36-100 saves happily and then produces a child with 35% and no grade at
     all on their report card. */
  const gap = (() => {
    if (bands.length < 2) return ''
    const sorted = bands
      .map((b) => ({ min: num(b.min_percent), max: num(b.max_percent) }))
      .sort((a, b) => a.min - b.min)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].min > sorted[i - 1].max + 1) {
        return `nothing covers ${sorted[i - 1].max + 1}–${sorted[i].min - 1}%`
      }
    }
    if (sorted[0].min > 0) return `nothing covers 0–${sorted[0].min - 1}%`
    if (sorted[sorted.length - 1].max < 100)
      return `nothing covers ${sorted[sorted.length - 1].max + 1}–100%`
    return ''
  })()

  // The SSC ten-point scale. Grade points matter: the CGPA on a Telangana
  // memo is their average, not an average of percentages.
  const cce = () => {
    setName('CCE 10-point (BSE Telangana)')
    setBands([
      { grade: 'A1', min_percent: '91', max_percent: '100', grade_point: '10' },
      { grade: 'A2', min_percent: '81', max_percent: '90', grade_point: '9' },
      { grade: 'B1', min_percent: '71', max_percent: '80', grade_point: '8' },
      { grade: 'B2', min_percent: '61', max_percent: '70', grade_point: '7' },
      { grade: 'C1', min_percent: '51', max_percent: '60', grade_point: '6' },
      { grade: 'C2', min_percent: '41', max_percent: '50', grade_point: '5' },
      { grade: 'D1', min_percent: '35', max_percent: '40', grade_point: '4' },
      { grade: 'D2', min_percent: '0', max_percent: '34', grade_point: '3' },
    ])
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          name,
          is_default: true,
          bands: bands.map((b) => ({
            grade: b.grade.trim(),
            min_percent: num(b.min_percent),
            max_percent: num(b.max_percent),
            grade_point: num(b.grade_point),
          })),
        })
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
                value={b.min_percent}
                onChange={(x) => setBands(bands.map((v, j) => (i === j ? { ...v, min_percent: x } : v)))}
              />
              <Input
                value={b.max_percent}
                onChange={(x) => setBands(bands.map((v, j) => (i === j ? { ...v, max_percent: x } : v)))}
              />
              <Input
                value={b.grade_point}
                onChange={(x) => setBands(bands.map((v, j) => (i === j ? { ...v, grade_point: x } : v)))}
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
            const lowest = bands.length
              ? Math.min(...bands.map((b) => num(b.min_percent)))
              : 101
            setBands([
              ...bands,
              {
                grade: '',
                min_percent: '0',
                max_percent: String(Math.max(lowest - 1, 0)),
                grade_point: '',
              },
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

      <ExistingScales />
    </form>
  )
}

/**
 * The scales this school already has, with their bands.
 *
 * The step saved a scale and then showed nothing but "1 already added", so the
 * only way to see the bands you had entered was to enter them again and watch
 * what happened. Every other setup step lists what is there; this one could
 * not, because nothing served it.
 *
 * A scale an exam has been graded against cannot be removed. It is not a label
 * on that exam, it is what turned its marks into grades, and deleting it
 * leaves marked papers whose grades cannot be explained.
 */
function ExistingScales() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState('')
  const [failed, setFailed] = useState('')

  const { data } = useQuery({
    queryKey: ['grading-scales'],
    queryFn: () => api.get<List<GradingScale>>('/api/v1/setup/grading-scales'),
  })

  const remove = async (scale: GradingScale) => {
    if (!confirm(`Remove "${scale.name}" and its ${scale.bands.length} bands?`)) return
    setBusy(scale.id)
    setFailed('')
    try {
      await api.del(`/api/v1/setup/grading-scales/${scale.id}`)
      await qc.invalidateQueries()
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Could not remove that scale.')
    } finally {
      setBusy('')
    }
  }

  const scales = data?.items ?? []
  if (!scales.length) return null

  return (
    <div className="mt-4 border-t pt-4">
      <p className="eyebrow mb-2">Scales you have set up</p>
      <div className="space-y-3">
        {scales.map((sc) => (
          <div key={sc.id} className="rounded-md border px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-medium">{sc.name}</span>
              {sc.is_default && <Chip>default</Chip>}
              <span className="text-[13px] text-muted-foreground">
                {sc.bands.length} bands
              </span>
              <button
                type="button"
                disabled={busy === sc.id || sc.in_use}
                onClick={() => remove(sc)}
                title={
                  sc.in_use
                    ? 'An exam has been graded against this scale, so removing it would leave marked papers whose grades cannot be explained.'
                    : 'Remove this scale'
                }
                className="ml-auto text-[13px] underline underline-offset-2 text-muted-foreground enabled:hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sc.in_use ? 'in use by an exam' : busy === sc.id ? 'removing…' : 'remove'}
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {sc.bands.map((b, i) => (
                <span
                  key={i}
                  className="rounded border px-1.5 py-0.5 text-[12px] tabular-nums text-muted-foreground"
                >
                  <b className="text-foreground">{b.grade}</b> {b.min_percent}–{b.max_percent}%
                  {b.grade_point != null && ` · ${b.grade_point}`}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {failed && <p className="mt-2 text-[13px] text-destructive">{failed}</p>}
    </div>
  )
}

interface GradingScale {
  id: string
  name: string
  is_default: boolean
  in_use: boolean
  bands: { grade: string; min_percent: number; max_percent: number; grade_point?: number }[]
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
      {/* Same story: an importer nobody could reach. A school with twenty
          heads across tuition, transport, books and lab was clicking through
          a list one at a time. */}
      <div className="mt-4 border-t pt-4">
        <BulkImport
          entity="fee_heads"
          title="Or every fee head from a sheet"
          hint="Name, code, and whether it recurs each term. The code is what a receipt prints and what a second upload matches on."
          onDone={onDone}
        />
      </div>
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
  /* The structure is named after the year, because that is what it is.

     The placeholder read "Class 6 — 2026-27" and the field started empty, so
     every structure was named by hand and no two schools named them the same
     way. A fee structure belongs to an academic year and applies to whichever
     classes are ticked below; putting the class in its name was describing
     the selection twice and getting it wrong as soon as two classes were
     picked. */
  const { data: years } = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => api.get<List<AcademicYear>>('/api/v1/academics/years'),
  })
  const [name, setName] = useState('')
  const currentYear = years?.items.find((y) => y.is_current) ?? years?.items[0]

  useEffect(() => {
    if (!name && currentYear?.name) setName(currentYear.name)
  }, [currentYear, name])

  /* Which classes it applies to.
   *
   * One dropdown offering a single class or "every class" could not express
   * the ordinary case, which is that Grades 6 to 8 pay one thing and 9 to 10
   * pay another. Ticking none means every class, which is what the blank
   * dropdown used to mean, so the default has not changed. */
  const [pickedClasses, setPickedClasses] = useState<Set<string>>(new Set())
  const [instalments, setInstalments] = useState('3')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  /* Which heads this structure charges.
   *
   * Every fee head in the school was listed with a box beside it, and a head
   * with a blank box is simply not charged — so it worked, and it read as if
   * a school that does not charge for the library must still look at a
   * Library Fee line on every structure it ever builds. Worse for a school
   * with fifteen heads across three structures: the same twelve irrelevant
   * lines, three times.
   *
   * Null until the heads have loaded, then seeded with all of them, which
   * keeps the opening screen the same as it was. */
  const [lines, setLines] = useState<string[] | null>(null)
  const [adding, setAdding] = useState('')
  const [newHead, setNewHead] = useState('')
  const qcFees = useQueryClient()

  useEffect(() => {
    if (lines === null && heads?.items) setLines(heads.items.map((h) => h.id))
  }, [heads, lines])

  const shown = (heads?.items ?? []).filter((h) => (lines ?? []).includes(h.id))
  const hidden = (heads?.items ?? []).filter((h) => !(lines ?? []).includes(h.id))

  /* Adding a head the school has not created yet.
   *
   * A structure is where somebody discovers they need a Lab Fee, and sending
   * them back two steps to create it — losing the amounts they have typed —
   * is how a form makes people give up. */
  const createHead = useSave(
    async () => {
      const made = await api.post<{ id: string }>('/api/v1/setup/fee-heads', {
        name: newHead.trim(),
        code: newHead.trim().slice(0, 4).toUpperCase(),
      })
      setLines([...(lines ?? []), made.id])
      setNewHead('')
      await qcFees.invalidateQueries({ queryKey: ['fee-heads'] })
    },
    () => {},
  )

  const save = useSave(async () => {
    const n = Math.max(1, Number(instalments) || 1)
    const items: { fee_head_id: string; instalment_no: number; amount_paise: number; due_on?: string }[] = []
    for (const [headID, rupees] of Object.entries(amounts)) {
      // A head taken off the structure is not charged even if an amount was
      // typed against it before it was removed.
      if (lines && !lines.includes(headID)) continue
      const total = rupeesToPaise(rupees)
      if (!total) continue
      // Split evenly, then push the rounding remainder onto the first
      // instalment so the instalments always sum back to the annual figure.
      const each = Math.floor(total / n)
      for (let i = 1; i <= n; i++) {
        items.push({ fee_head_id: headID, instalment_no: i, amount_paise: i === 1 ? total - each * (n - 1) : each })
      }
    }
    // One structure per class chosen, because that is what the server stores;
    // ticking none writes the single every-class structure it wrote before.
    const targets = pickedClasses.size ? [...pickedClasses] : [undefined]
    for (const cid of targets) {
      const label =
        cid && classes?.items
          ? `${classes.items.find((c) => c.id === cid)?.name ?? ''} — ${name}`.trim()
          : name
      await api.post('/api/v1/setup/fee-structures', { name: label, class_id: cid, items })
    }
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
        <Field label="Structure name" required hint="The academic year it belongs to.">
          <Input value={name} onChange={setName} placeholder="2026-2027" />
        </Field>
        <Field
          label="Applies to"
          hint={
            pickedClasses.size
              ? `${pickedClasses.size} ${pickedClasses.size === 1 ? 'class' : 'classes'} — one structure is created for each.`
              : 'Nothing ticked means every class.'
          }
        >
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setPickedClasses(new Set())}
              className={cn(
                'rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
                pickedClasses.size === 0
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              Every class
            </button>
            {(classes?.items ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  const next = new Set(pickedClasses)
                  next.has(c.id) ? next.delete(c.id) : next.add(c.id)
                  setPickedClasses(next)
                }}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[13px] transition-colors duration-150',
                  pickedClasses.has(c.id)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Instalments" hint="Annual amounts below are divided into this many terms.">
          <Input value={instalments} onChange={setInstalments} />
        </Field>
      </FormGrid>

      <p className="eyebrow mb-2 mt-4">Annual amount per head</p>
      <div className="space-y-2">
        {shown.map((h) => (
          <div key={h.id} className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-2">
            <span className="text-[14px]">{h.name}</span>
            <Input
              value={amounts[h.id] ?? ''}
              onChange={(x) => setAmounts({ ...amounts, [h.id]: x })}
              placeholder="₹ per year"
            />
            <button
              type="button"
              onClick={() => {
                setLines((shown.map((x) => x.id) ?? []).filter((id) => id !== h.id))
                // The amount goes with the line. Leaving it behind means a head
                // removed and re-added silently carries the old figure.
                const { [h.id]: _dropped, ...rest } = amounts
                setAmounts(rest)
              }}
              className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-destructive"
              aria-label={`Do not charge ${h.name} in this structure`}
            >
              remove
            </button>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            No heads on this structure yet — add one below.
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        {hidden.length > 0 && (
          <Field label="Add a head">
            <Select
              value={adding}
              onChange={(v) => {
                if (!v) return
                setLines([...(lines ?? []), v])
                setAdding('')
              }}
              placeholder="Choose a fee head"
              options={hidden.map((h) => ({ value: h.id, label: h.name }))}
            />
          </Field>
        )}
        <Field label="Or a new one" hint="Created as a fee head for the whole school.">
          <Input value={newHead} onChange={setNewHead} placeholder="Lab Fee" />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={!newHead.trim() || createHead.isPending}
          onClick={() => createHead.mutate(undefined as never)}
        >
          {createHead.isPending ? 'Adding…' : 'Add'}
        </Button>
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

      {/* What is already priced, and a way to take it off.
       *
       * Fees are re-set every year and nothing here could be removed: a
       * structure typed with the wrong amounts, or last year's, stayed on the
       * list for good, and the only way past it was a second structure with a
       * similar name. Two price lists for one class is worse than none,
       * because the office then has to know which one is live. */}
      <FeeStructureList />

      <div className="mt-4 border-t pt-4">
        <BulkImport
          entity="fee_structures"
          title="Or price every class from a sheet"
          hint="One row per class per fee head: structure, class, fee head, the annual amount and how many instalments to split it into. Leave the class blank for a fee the whole school pays. Re-uploading a corrected sheet overwrites the amounts rather than adding a second structure."
          onDone={onDone}
        />
      </div>
    </form>
  )
}

/** The structures that exist, with the year they belong to and a way to remove one. */
function FeeStructureList() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState('')
  const [failed, setFailed] = useState('')
  const { data } = useQuery({
    queryKey: ['fee-structures'],
    queryFn: () =>
      api.get<List<{
        id: string
        name: string
        class_name?: string
        lines: number
        total_paise: number
      }>>('/api/v1/setup/fee-structures'),
  })
  const rows = data?.items ?? []
  if (rows.length === 0) return null

  const remove = async (id: string, label: string) => {
    if (!confirm(`Remove ${label}? Invoices already raised are unaffected — this is the price list, not the bills.`)) return
    setBusy(id)
    setFailed('')
    try {
      await api.del(`/api/v1/setup/fee-structures/${id}`)
      await qc.invalidateQueries({ queryKey: ['fee-structures'] })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Could not remove that structure.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="mt-4 border-t pt-4">
      <p className="eyebrow mb-2">Structures already priced</p>
      <div className="scroll-x rounded-md border">
        <table className="w-full text-[13px]">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Structure</th>
              <th className="px-3 py-1.5 font-medium">Applies to</th>
              <th className="px-3 py-1.5 font-medium">Lines</th>
              <th className="px-3 py-1.5 font-medium">A year</th>
              <th className="px-3 py-1.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className="border-t">
                <td className="px-3 py-1.5 font-medium">{f.name}</td>
                <td className="px-3 py-1.5">{f.class_name ?? 'Every class'}</td>
                <td className="px-3 py-1.5 tabular-nums">{f.lines}</td>
                <td className="px-3 py-1.5 tabular-nums">
                  ₹{(f.total_paise / 100).toLocaleString('en-IN')}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {/* A cross, as on every other list. "remove" as a word in
                      a right-hand column reads as a link to somewhere; the
                      cross is the same gesture people already know from the
                      class and section tags, and it is in the same place. */}
                  <button
                    type="button"
                    disabled={busy === f.id}
                    onClick={() => void remove(f.id, `${f.name} for ${f.class_name ?? 'every class'}`)}
                    aria-label={`Remove ${f.name}`}
                    title={`Remove ${f.name}`}
                    className="rounded-sm px-1 leading-none text-[15px] text-muted-foreground
                               hover:bg-destructive/10 hover:text-destructive
                               disabled:opacity-50"
                  >
                    {busy === f.id ? '…' : '×'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failed && <p className="mt-2 text-[13px] text-destructive">{failed}</p>}
    </div>
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

/* EMPTYING THE SCHOOL SO REAL DATA CAN GO IN.
 *
 * A school evaluates this with invented children, invented staff and invented
 * fees, decides to use it, and then cannot get rid of any of it. Every guard
 * that protects live data works exactly as well against test data: a class
 * will not delete because it has sections, a section because it has a
 * register, a teacher because they are assigned to a class. Undoing an upload
 * of twenty-two staff removed three and kept eight, every one for a good
 * reason.
 *
 * So the alternatives were to unpick a school by hand in exact reverse order,
 * or to start again on a new one and lose the week of setup that made them
 * want to keep it. This is the third answer.
 */
function ResetPanel({ onDone }: PanelProps) {
  const [typed, setTyped] = useState('')
  const [done, setDone] = useState<{ deleted: number; could_not_clear: string[] } | null>(null)

  const school = useQuery({
    queryKey: ['institution'],
    // The same call the profile step makes. Written from memory the first
    // time as /setup/profile, which is not a route -- so the school's name
    // never arrived and the confirmation could never be satisfied, leaving a
    // button permanently disabled with nothing on screen explaining why.
    queryFn: () => api.get<{ name: string }>('/api/v1/setup/institution'),
  })
  const name = school.data?.name ?? ''

  const reset = useMutation({
    mutationFn: () => api.post<{ deleted: number; could_not_clear: string[] }>(
      '/api/v1/setup/reset', { confirm: typed }),
    onSuccess: (res) => { setDone(res); setTyped(''); onDone?.() },
  })

  if (done) {
    return (
      <div className="space-y-2 text-[14px]">
        <p className="font-medium text-success">
          {done.deleted.toLocaleString()} records removed. The school is empty.
        </p>
        <p className="text-muted-foreground">
          Your login, the school's details, its campuses and its academic years
          are as they were. Start again from the first step.
        </p>
        {done.could_not_clear.length > 0 && (
          /* Named rather than hidden. A school told "done" that still has rows
             somewhere finds out when a list is not empty, and by then it does
             not trust the button. */
          <p className="text-[13px] text-warning">
            Still holding records: {done.could_not_clear.join(', ')}. Tell us and
            we will look.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3 text-[14px]">
      <p className="text-muted-foreground">
        For a school that has finished trying this out and wants to put its real
        records in. Nothing here is needed by a school that is simply setting up.
      </p>

      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3">
        <p className="text-[13px] font-medium text-destructive">
          This deletes everything this school has recorded.
        </p>
        <p className="mt-1 text-[12.5px]">
          Children, staff, classes, sections, subjects, the timetable, marks,
          report cards, attendance, fees, payments, admissions and messages. It
          cannot be undone and no copy is kept.
        </p>
        {/* What survives, said as plainly as what does not -- somebody about to
            press this needs to know they are not deleting their own way back
            in, and that the week they spent on settings is not going with it. */}
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          Kept: your login and everyone else's, the school's own details, its
          campuses, and its academic years.
        </p>
      </div>

      <Field
        label={`Type ${name || "the school's name"} to confirm`}
        hint="Typed rather than ticked, because a tick is a reflex and this is a decision."
      >
        <Input value={typed} onChange={setTyped} placeholder={name} />
      </Field>

      <FormNotice error={reset.error} />
      <Button
        className="bg-destructive text-white hover:bg-destructive/90"
        disabled={reset.isPending || typed.trim().toLowerCase() !== name.trim().toLowerCase() || !name}
        onClick={() => reset.mutate()}
      >
        {reset.isPending ? 'Deleting…' : 'Delete everything and start again'}
      </Button>
    </div>
  )
}

// --- registry ---------------------------------------------------------------

export const PANELS: Record<string, ComponentType<PanelProps>> = {
  profile: ProfilePanel,
  campus: CampusPanel,
  academic_year: YearPanel,
  classes: ClassesPanel,
  subjects: SubjectsAndMapping,
  periods: PeriodsPanel,
  staff: StaffPanel,
  students: StudentsPanel,
  grading: GradingPanel,
  fee_heads: FeeHeadsPanel,
  fee_structures: FeeStructuresPanel,
  exams: ExamsPanel,
  history: HistoryPanel,
  udise: UDISEPanel,
  reset: ResetPanel,
}

/**
 * The teachers who teach one subject.
 *
 * Every subject dropdown on the assignment screen offered every member of
 * staff, so the Telugu row listed the accountant and whoever was filling it in
 * had to know the staff well enough to ignore most of the list.
 *
 * The narrowing is the server's, and it falls back to everybody where a school
 * has recorded nothing about who teaches what — an unhelpful list is better
 * than an empty one, which reads as a broken screen.
 */
function SubjectTeacherSelect({
  subjectID,
  value,
  onChange,
  current,
}: {
  subjectID: string
  value: string
  onChange: (v: string) => void
  /** Who holds it now, shown as the placeholder so an untouched row still
   *  says what it is rather than looking unassigned. */
  current?: string
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['teachers', subjectID],
    queryFn: () =>
      api.get<List<Teacher>>(`/api/v1/timetable/teachers?subject_id=${subjectID}`),
    enabled: !!subjectID,
  })
  const options = (data?.items ?? []).map((t) => ({
    value: t.user_id,
    label: t.subjects ? `${t.full_name} · ${t.subjects}` : t.full_name,
  }))
  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={
        isLoading
          ? 'Loading…'
          : (current ?? (options.length ? 'Unassigned' : 'Nobody is recorded as teaching this'))
      }
      options={options}
    />
  )
}

/**
 * The staff on the roll, and what each of them signs in with.
 *
 * This was a row of names and nothing else, so the only way to find out
 * whether somebody could sign in was to ask them to try — and the only place a
 * password was ever shown was the panel that appears after an import, which is
 * gone the moment you leave the page.
 *
 * An account created alongside a staff record has no password until somebody
 * issues one. That state is worth showing plainly: "no login yet" is a
 * different problem from "has a login and has forgotten it", and they are
 * fixed by the same button for different reasons.
 */

/* The file, written once and used by both buttons.

   Excel reads a CSV as the system codepage unless it finds a byte order mark,
   which turns every name that is not ASCII into rubbish. */
function downloadRows(body: string[][]) {
  const rows = [
    ['Name', 'Subjects', 'Role', 'Class teacher of', 'Signs in as', 'Password'],
    ...body,
  ]
  const csv = rows
    .map((row) => row.map((c) => '"' + c.replace(/"/g, '""') + '"').join(','))
    .join('\r\n')
  const url = URL.createObjectURL(
    new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = 'staff-logins.csv'
  a.click()
  URL.revokeObjectURL(url)
}

/* A refusal in the words of the person reading it.

   The server names the permission it wanted — "missing permission:
   hr.employees.write" — which is exactly right in a log and no use at all on
   screen, where the reader is a head teacher who has never heard of it and
   whose real problem is that they are signed in as somebody else in this tab. */
function explain(e: unknown): string {
  const raw = e instanceof Error ? e.message : ''
  if (raw.includes('hr.employees.write')) {
    return 'Only HR or the principal can issue or reset a staff password. ' +
      'Check which account this tab is signed in as.'
  }
  return raw || 'Could not do that.'
}

function StaffLogins({ staff }: { staff: Teacher[] }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState('')
  const [issued, setIssued] = useState<Record<string, { user: string; pass: string }>>({})
  const [failed, setFailed] = useState('')
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const withoutLogin = staff.filter((t) => !t.can_sign_in).length
  // The phone's Back closes this, like every overlay: see overlay-history.ts.
  const closeLogins = useCallback(() => setOpen(false), [])
  useOverlayHistory(open, closeLogins)

  /* The list, as the file a school actually keeps.
   *
   * Passwords are shown once and hashed on the way in, so this is the only
   * moment the plain ones exist anywhere. A page that shows them and offers
   * no way to keep them is a page whose whole point is lost to a refresh. */
  const download = () => downloadRows(
    staff.map((t) => [
      t.full_name,
      t.subjects ?? '',
      t.roles ?? '',
      t.class_teacher_of ?? '',
      issued[t.user_id]?.user ?? t.sign_in_as ?? '',
      issued[t.user_id]?.pass ?? (t.can_sign_in ? 'already set' : 'no login yet'),
    ]),
  )

  /* Reset everybody, and hand over the file.
   *
   * "Show me the passwords" cannot be answered: they are hashed on the way in
   * and the plain text is never stored, which is the whole point — an
   * administrator who can read a teacher's password can sign in as them, and
   * the audit trail then says the teacher did it. "already set" is the true
   * state, not a missing feature.
   *
   * What a school actually needs is a full list that works, and this is the
   * only honest way to produce one: give everybody a new password and write
   * them all down in the same breath. The download happens in the same click,
   * because the passwords exist for exactly as long as this page holds them. */
  const resetAllAndExport = async () => {
    if (!confirm(
      'Give every member of staff a new password?\n\n' +
      'The passwords they are using now will stop working, and the new ones ' +
      'download as a file. This is the only way to get a complete list — the ' +
      'ones already set cannot be looked up.'
    )) return
    setBusy('all')
    setFailed('')
    try {
      const res = await api.post<{ rows: { name: string; sign_in_as: string; password: string }[] }>(
        '/api/v1/setup/logins/bulk', { kind: 'staff', reset: true },
      )
      const fresh: Record<string, { user: string; pass: string }> = {}
      const byName = new Map(res.rows.map((r) => [r.name, r]))
      for (const t of staff) {
        const r = byName.get(t.full_name)
        if (r) fresh[t.user_id] = { user: r.sign_in_as, pass: r.password }
      }
      setIssued((v) => ({ ...v, ...fresh }))
      await qc.invalidateQueries({ queryKey: ['teachers'] })
      // Straight to the file, from the response rather than from state, which
      // has not re-rendered yet.
      downloadRows(staff.map((t) => {
        const r = byName.get(t.full_name)
        return [
          t.full_name, t.subjects ?? '', t.roles ?? '', t.class_teacher_of ?? '',
          r?.sign_in_as ?? t.sign_in_as ?? '', r?.password ?? '',
        ]
      }))
    } catch (e) {
      setFailed(explain(e))
    } finally {
      setBusy('')
    }
  }

  const issue = async (t: Teacher, reset: boolean) => {
    if (reset && !confirm(
      `Reset ${t.full_name}'s password? The one they are using now will stop working.`
    )) return
    setBusy(t.user_id)
    setFailed('')
    try {
      const body = await api.post<{ sign_in_as: string; password: string }>(
        `/api/v1/setup/employees/${t.employee_id}/login${reset ? '?reset=true' : ''}`, {},
      )
      if (body.password) {
        setIssued((v) => ({ ...v, [t.user_id]: { user: body.sign_in_as, pass: body.password } }))
      }
      await qc.invalidateQueries({ queryKey: ['teachers'] })
    } catch (e) {
      setFailed(explain(e))
    } finally {
      setBusy('')
    }
  }

  /* A button, and the page behind it.
   *
   * This was a table sitting open under the staff form, which is the wrong
   * shape for something read once a term: it pushed the form nobody had
   * finished off the screen, and it was too narrow for the columns it
   * carries. One button, and a page that opens over the top with room for
   * them.
   *
   * Everything on the page stays live — a reset issued in here is the same
   * reset, and the password it shows is still shown only once. */
  if (!open) {
    return (
      <div className="mt-4 border-t pt-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <KeyRound className="h-3.5 w-3.5" />
          Staff logins
          <span className="ml-1 text-muted-foreground">({staff.length})</span>
        </Button>
        {withoutLogin > 0 && (
          <span className="ml-2 text-[12.5px] text-destructive">
            {withoutLogin} of them cannot sign in yet
          </span>
        )}
      </div>
    )
  }

  /* PORTALLED TO THE BODY, which is what makes Expand work at all.

     `position: fixed` is relative to the viewport only while no ancestor
     establishes a containing block, and several things do: a transform, a
     filter, a backdrop-filter, and -- the one that catches this -- CSS
     containment. `.bento-cell` carries `container-type: size`, which implies
     `contain: layout style size`, so a fixed child inside one is fixed to the
     CELL.

     That is why the dialog appeared clipped at the left edge and why Expand
     looked like it did nothing: it was already filling the box it was trapped
     in, and toggling between "all of that box" and "85% of that box" is not a
     visible change.

     Rendered into document.body it is fixed to the viewport, which is what
     every line of styling below already assumed. */
  return createPortal(
    <div
      className={
        full
          ? 'fixed inset-0 z-[80] bg-background'
          : 'fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4'
      }
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Staff logins"
    >
    <div
      className={
        full
          ? 'flex h-full w-full flex-col overflow-auto border bg-background p-4'
          : 'flex max-h-[85vh] w-full max-w-[70rem] flex-col overflow-auto rounded-lg border bg-background p-4 shadow-lg'
      }
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-[15px] font-medium">Staff logins</p>
        <span className="text-[12.5px] text-muted-foreground">
          {staff.length} on the roll
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={download}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy === 'all'}
            onClick={() => void resetAllAndExport()}
          >
            <KeyRound className="h-3.5 w-3.5" />
            {busy === 'all' ? 'Resetting…' : 'Reset all & export'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFull((v) => !v)}>
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {full ? 'Windowed' : 'Expand'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            <X className="h-3.5 w-3.5" />
            Close
          </Button>
        </div>
      </div>
      <div className="scroll-x rounded-md border">
        <table className="w-full text-[13px]">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Name</th>
              <th className="px-3 py-1.5 font-medium">Role</th>
              <th className="px-3 py-1.5 font-medium">Signs in as</th>
              <th className="px-3 py-1.5 font-medium">Password</th>
              <th className="px-3 py-1.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((t) => {
              const fresh = issued[t.user_id]
              return (
                <tr key={t.user_id} className="border-t">
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{t.full_name}</span>
                    {t.subjects && (
                      <span className="ml-1.5 text-muted-foreground">· {t.subjects}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {t.roles ? (
                      <Chip>{t.roles}</Chip>
                    ) : (
                      <span className="text-muted-foreground">no role</span>
                    )}
                    {t.class_teacher_of && (
                      <span className="ml-1.5 text-[12.5px] text-muted-foreground">
                        class teacher {t.class_teacher_of}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono">
                    {fresh?.user ?? t.sign_in_as ?? '—'}
                  </td>
                  <td className="px-3 py-1.5">
                    {fresh ? (
                      <span className="font-mono font-medium">{fresh.pass}</span>
                    ) : t.can_sign_in ? (
                      <span
                        className="text-muted-foreground"
                        title="Not stored anywhere — only a hash of it is, so nobody can look it up, including us. Reset this one, or use Reset all &amp; export for the whole list."
                      >
                        already set
                      </span>
                    ) : (
                      <span className="text-destructive">no login yet</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      disabled={busy === t.user_id}
                      onClick={() => issue(t, t.can_sign_in)}
                      className="underline underline-offset-2 text-muted-foreground hover:text-primary"
                    >
                      {busy === t.user_id
                        ? 'working…'
                        : t.can_sign_in
                          ? 'reset password'
                          : 'give a login'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {Object.keys(issued).length > 0 && (
        <p className="mt-2 text-[12.5px] text-destructive">
          Copy these before you leave the page. A password is shown once and cannot be
          looked up again — only replaced.
        </p>
      )}
      {failed && <p className="mt-2 text-[13px] text-destructive">{failed}</p>}
    </div>
    </div>,
    document.body,
  )
}


/* What choosing a board actually does, said before it does it.

   The board was stored, printed on the setup form, counted towards "setup
   finished" — and nothing in the product branched on it. A school picked CBSE
   and got what a school picking Kerala SSLC got: an empty grading scale to
   build by hand.

   Three rules this panel obeys, and each of them is a thing that goes wrong
   when a product is clever about presets:

     it SHOWS before it acts, so a registrar can check the bands against the
     circular on their desk;

     it never applies as a side effect of the dropdown, because a scale
     somebody spent an afternoon on must not be rewritten by a field;

     and it says plainly that the preset is a starting point. A product that
     hardcodes what it believes a board requires is wrong the year the board
     changes it, and the school cannot correct it. */
interface BoardPreset {
  value: string
  label: string
  group: string
  scale_name: string
  pass_mark: number
  assessment: string
  leaving_doc: string
  notes?: string
  bands: { grade: string; min_percent: number; max_percent: number; grade_point?: number }[]
}

export function BoardImplications({ board }: { board: string }) {
  const [open, setOpen] = useState(false)
  const boards = useQuery({
    queryKey: ['setup', 'boards'],
    queryFn: () => api.get<{ items: BoardPreset[] }>('/api/v1/setup/boards'),
  })
  const apply = useMutation({
    mutationFn: () => api.post<{ scale_name: string; bands: number; already_existed: boolean }>(
      '/api/v1/setup/boards/apply', { board }),
  })

  if (!board) return null
  const preset = (boards.data?.items ?? []).find((b) => b.value === board)
  if (!preset) {
    /* A board the school added themselves. There is nothing to preset, and
       that is an honest answer rather than a gap — so it says what to do
       instead of showing an empty panel. */
    return (
      <p className="mt-2 rounded-lg border bg-muted/30 p-3 text-[12.5px] text-muted-foreground">
        This is your school&rsquo;s own board, so nothing is assumed about it.
        Set the grade bands it reports in under Academics → Grading, and they
        will be used everywhere marks are graded.
      </p>
    )
  }

  return (
    <div className="mt-2 rounded-lg border bg-muted/30 p-3 text-[12.5px]">
      <p className="font-medium text-foreground">Choosing {preset.label} sets up:</p>
      <ul className="mt-1.5 space-y-1 text-muted-foreground">
        <li>
          <span className="text-foreground">Grading:</span> {preset.scale_name} —{' '}
          {preset.bands.map((b) => b.grade).join(', ')}
        </li>
        <li><span className="text-foreground">Pass mark:</span> {preset.pass_mark}%</li>
        <li><span className="text-foreground">Assessed as:</span> {preset.assessment}</li>
        <li><span className="text-foreground">Leaving document:</span> {preset.leaving_doc}</li>
      </ul>
      {preset.notes && (
        <p className="mt-2 text-muted-foreground">{preset.notes}</p>
      )}

      {open && (
        <table className="mt-3 w-full text-[12px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1">Grade</th><th>From</th><th>To</th><th>Points</th>
            </tr>
          </thead>
          <tbody>
            {preset.bands.map((b) => (
              <tr key={b.grade} className="border-t">
                <td className="py-1 font-medium">{b.grade}</td>
                <td className="tabular-nums">{b.min_percent}%</td>
                <td className="tabular-nums">{b.max_percent}%</td>
                <td className="tabular-nums">{b.grade_point || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="text-primary"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide the bands' : 'Show the bands'}
        </button>
        <button
          type="button"
          className="rounded-md border bg-background px-2.5 py-1 font-medium"
          disabled={apply.isPending}
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? 'Setting up…' : 'Use this grading scale'}
        </button>
        {apply.isSuccess && (
          <span className="text-success">
            {apply.data.already_existed
              ? `You already have ${apply.data.scale_name} — nothing was changed.`
              : `${apply.data.scale_name} created with ${apply.data.bands} bands. Edit it under Academics → Grading.`}
          </span>
        )}
        {apply.isError && (
          <span className="text-destructive">
            {apply.error instanceof Error ? apply.error.message : 'Could not set it up'}
          </span>
        )}
      </div>
      <p className="mt-2 text-muted-foreground">
        A starting point, not a rule — every band stays editable, and nothing
        you have already set up is overwritten.
      </p>
    </div>
  )
}

/* A section, renameable in place.

   The name is the thing most likely to be wrong on the first pass: a school
   types A and B during setup because that is what the example said, then finds
   its own noticeboards say Rose and Jasmine. Nothing joins on the name — every
   register, timetable, mark and invoice points at the section by id — so the
   rename is a label change and the school's history follows it.

   Deleting is offered only for an empty section, and the server refuses on
   every enrolment rather than only the active ones: a section whose children
   were all promoted out still holds last year's register, and the cascade
   would take it. */
function EditableSection({ section }: { section: Section }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(section.name)
  const [capacity, setCapacity] = useState(String(section.capacity))
  const [failed, setFailed] = useState('')

  const done = () => {
    setFailed('')
    setOpen(false)
    qc.invalidateQueries({ queryKey: ['sections'] })
  }

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/v1/setup/sections/${section.id}`, {
        name: name.trim(),
        capacity: Number(capacity) || section.capacity,
      }),
    onSuccess: done,
    onError: (e: unknown) => setFailed(e instanceof Error ? e.message : 'Could not save.'),
  })

  const remove = useMutation({
    // /setup, not /academics. The edit and delete routes for classes,
    // sections and subjects all live under setup; /academics only lists them.
    // This was the fourth screen today naming a path the router does not have.
    mutationFn: () => api.del(`/api/v1/setup/sections/${section.id}`),
    onSuccess: done,
    onError: (e: unknown) => setFailed(e instanceof Error ? e.message : 'Could not delete.'),
  })

  if (!open) {
    return (
      /* The tag opens for renaming; the cross removes. Two intentions, and one
         of them cannot be undone -- so they are two targets rather than one
         control that behaves differently depending on where you land. */
      <span className="inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[13px]">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Rename this section, or change what it holds"
          className="hover:underline"
        >
          {section.class_name}-{section.name} · {section.enrolled}/{section.capacity}
        </button>
        {/* Only while it is empty. A section with children in it is refused by
            the server anyway, and a cross that always refuses is worse than no
            cross -- it reads as the product being broken rather than the
            section being in use. */}
        {section.enrolled === 0 && (
          <button
            type="button"
            title={failed || 'Remove this section'}
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            aria-label={`Remove section ${section.class_name}-${section.name}`}
            className="-mr-0.5 rounded-sm px-0.5 leading-none text-muted-foreground
                       hover:bg-destructive/10 hover:text-destructive"
          >
            ×
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-sm border px-2 py-1">
      <span className="text-[13px] text-muted-foreground">{section.class_name}</span>
      <span className="w-28">
        <Input value={name} onChange={setName} placeholder="Rose" />
      </span>
      <span className="w-16">
        <Input value={capacity} onChange={setCapacity} />
      </span>
      <Button size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
      {section.enrolled === 0 && (
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          title="Delete this empty section"
        >
          Delete
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setFailed('') }}>
        Cancel
      </Button>
      {failed && <span className="text-[12px] text-danger">{failed}</span>}
    </span>
  )
}
