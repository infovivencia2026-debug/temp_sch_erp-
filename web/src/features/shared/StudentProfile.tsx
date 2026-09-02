import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AdmitStudent from '@/features/setup/AdmitStudent'
import { Phone, Mail } from 'lucide-react'
import { api, type List, type Page, type Student, type Klass, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, FormGrid, Field as FormField, Select, Textarea, FormNotice, Checkbox,
  Table, Td, Badge, Button, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import {
  RecordShell, Field, type RecordTab, type RecordAction,
} from '@/components/RecordShell'
import { StatusPill } from '@/components/NeedsAttention'
import { useActiveRole } from '@/lib/catalog'
import { useSession } from '@/lib/session'
import { ExportRows } from '@/components/rows'
import { setTabTitle } from '@/lib/tabs'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import {
  SubjectMarks, FeeLedger, Receipts, StudentDocuments, LeaveHistory,
  TransportCrew, Activities, CoScholastic, type Detail,
} from './StudentTabs'
import { RecordBlock, FieldSheet } from './RecordBlock'
import StudentEditDialog from './StudentEditDialog'
import StudentFees from './StudentFees'
import { formatPaise, formatDate, formatDateTime, cn } from '@/lib/utils'
import { useToast } from '@/components/Toast'

/* What GET /students/{id} adds on top of the list row. The editable set is
   split across two endpoints -- names and address here, medium and the
   statutory ids on the profile -- so the form is prefilled from both rather
   than from casts that lie about what the response contains. */
interface StudentDetail extends Student {
  blood_group?: string; religion?: string; nationality?: string
  address_line1?: string; address_line2?: string
  city?: string; state?: string; pincode?: string
  category?: string; aadhaar_last4?: string
  custom_fields?: Record<string, string>
}

interface Profile {
  id: string; admission_no: string; full_name: string; status: string
  class_name?: string; section_name?: string; roll_no?: number
  gender?: string; date_of_birth?: string; medium?: string; blood_group?: string
  mother_tongue?: string; apaar_id?: string; child_info_id?: string
  primary_phone?: string; city?: string; prior_school?: string
  is_rte: boolean; is_cwsn: boolean; admission_date: string
  photo_file_id?: string
  attendance: { present: number; total: number; percent: number; below_threshold: boolean }
  fees: { outstanding_paise: number; paid_paise: number }
  category?: string; nationality?: string; aadhaar_last4?: string
  address_line1?: string; address_line2?: string; state?: string; pincode?: string
  permanent_address?: string
  emergency_contact_name?: string; emergency_contact_phone?: string
  emergency_contact_relation?: string
  house_id?: string; house_name?: string; house_color?: string
  exit_date?: string; exit_reason?: string
  height_cm?: string; weight_kg?: string; bmi?: string; measured_on?: string
  allergies?: string
  custom_fields?: Record<string, string>
  guardians: {
    id?: string; full_name: string; relation: string; phone: string
    email: string; is_primary: boolean; photo_file_id?: string
    occupation?: string
  }[]
  recent_attendance: { date: string; status: string }[]
  results: { exam: string; percentage: string; grade: string; rank: string }[]
  invoices: { date: string; invoice_no: string; net_paise: number; paid_paise: number; status: string }[]
  documents: { serial_no: string; type: string; issued_on: string }[]
  enrolments: {
    year: string; class: string; section: string
    roll_no: number | null; from: string; status: string
  }[]
  transport: {
    route: string; vehicle: string
    pickup_stop: string; pickup_time: string
    drop_stop: string; drop_time: string
    from: string; to: string
  }[]
}

const DOT: Record<string, string> = {
  present: 'bg-success', late: 'bg-warning', absent: 'bg-destructive',
  half_day: 'bg-warning/60', leave: 'bg-muted-foreground/40', holiday: 'bg-border',
}

/**
 * Student 360 — the screen a school opens most often, usually with a parent on
 * the phone. It answers the questions actually asked in that moment: which
 * class, who do we call, are they attending, what do they owe, how are they
 * doing.
 */
/* One thing a member of staff wrote about a child. */
interface Remark {
  id: string
  kind: string
  body: string
  subject?: string
  private: boolean
  observed_on: string
  recorded_at: string
  recorded_by?: string
}

export default function StudentProfile() {
  /* THE FILTERS LIVE IN THE URL, beside the child.

     They were component state, so opening a child and coming back put the
     clerk at the top of the whole school again — they had re-picked Grade 6
     every single time. Which child is open has been in the query string for
     exactly this reason; the filters that found them belong there too.

     Three things follow: the back button returns to the list as it was,
     "look at this section" is a link, and stepping from one child to the next
     keeps the section they were both found in. */
  const [params, setParams] = useSearchParams()
  const patch = (next: Record<string, string | null>, replace = false) => {
    const q = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) q.set(k, v)
      else q.delete(k)
    }
    setParams(q, { replace })
  }
  const search = params.get('q') ?? ''
  const setSearch = (v: string) => patch({ q: v || null }, true)
  /* BROWSE, NOT ONLY SEARCH.

     The screen answered exactly one question — "what is the name" — and a
     clerk who has a section in front of them and wants the eleven children in
     it had to know a name before the page would show them anything. Both ways
     in now: pick a class and section to see who is in it, or type a name or
     admission number. They compose, so a name typed while 7-A is chosen
     searches inside 7-A. */
  const classID = params.get('class') ?? ''
  const setClassID = (v: string) => patch({ class: v || null, section: null })
  const sectionID = params.get('section') ?? ''
  const setSectionID = (v: string) => patch({ section: v || null })
  /* ON THE ROLL, OR GONE — and on the roll is the default.

     Every list defaulted to both. A clerk searching a name got the child who
     left in 2023 above the one sitting in 7-A, distinguished only by a small
     grey badge, and a section browsed for its roll came back with last year's
     leavers in it. Leaving the school is a different question from being in
     it, so it is a deliberate choice rather than a badge to notice. */
  type Roll = 'active' | 'suspended' | 'left' | 'new' | 'all'
  const roll = (params.get('roll') as Roll) ?? 'active'
  const setRoll = (v: Roll) => patch({ roll: v === 'active' ? null : v })

  /* Which student is open lives in the query string, not in component state.

     Two things follow, and both are asked for daily. The student directory can
     hand a child straight to this screen instead of making the clerk retype a
     name they are already looking at — the directory used to be a dead end,
     rows of text with nowhere to click. And the address bar now identifies a
     child, so "look at this one" is a link rather than a set of instructions.

     Back also works, which it did not: the browser button used to leave the
     feature entirely rather than return to the search. */
  const selected = params.get('student')
  const setSelected = (id: string | null) => patch({ student: id }, !id)

  const classes = useQuery({
    queryKey: ['academics', 'classes'],
    queryFn: () => api.get<List<Klass>>('/api/v1/academics/classes'),
    enabled: !selected,
  })
  const sections = useQuery({
    queryKey: ['academics', 'sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
    enabled: !selected,
  })
  // Only the sections of the chosen class, so the second dropdown is never a
  // list of every section in the school with six of them relevant.
  const sectionsOfClass = (sections.data?.items ?? [])
    .filter((x) => !classID || x.class_id === classID)

  /* The roll, in four numbers.

     Counted on the server across the whole school rather than from the rows
     on screen: the list is filtered, paged and capped, so counting what is
     rendered would report "12 active" about a section of twelve and call it
     the school. */
  const counts = useQuery({
    queryKey: ['student-counts'],
    queryFn: () => api.get<Record<string, number>>('/api/v1/students/counts'),
    enabled: !selected,
  })

  /* PRESSING A TILE SHOWS THE LIST.

     "On the roll · 63" did nothing when pressed, because the list only
     appeared once a class was chosen or a name typed — so the tile counting
     sixty-three children was the one tile that could not show you them. The
     other three worked only by accident: they set a roll other than the
     default, which happened to be what the list was testing for. */
  const listing = params.get('list') === '1'
  const browsing = listing || !!classID || !!sectionID || roll !== 'active'
  const searching = search.trim().length >= 2
  const results = useQuery({
    queryKey: ['profile-search', search, classID, sectionID, roll],
    queryFn: () => {
      const qs = new URLSearchParams()
      if (searching) qs.set('q', search.trim())
      if (sectionID) qs.set('section_id', sectionID)
      else if (classID) qs.set('class_id', classID)
      /* The API takes one status. "Left" is four of them — graduated,
         transferred, withdrawn, alumni — so that view is filtered on the
         client from everyone rather than by four round trips that would each
         need their own paging. */
      if (roll === 'active' || roll === 'new') qs.set('status', 'active')
      if (roll === 'suspended') qs.set('status', 'suspended')
      // Served by the API, not filtered here, so the tile and the list cannot
      // disagree about what "new this year" means.
      if (roll === 'new') qs.set('new_this_year', '1')
      /* A whole section is forty children and a whole class is two hundred.
         Fifteen was right for "the three people called Sharma" and wrong for
         everything this filter is for, and a list silently cut at fifteen is
         one somebody reads as the complete roll. */
      qs.set('limit', browsing ? '300' : '15')
      return api.get<Page<Student>>(`/api/v1/students?${qs.toString()}`)
    },
    /* Kept alive while a child is open, which is what makes Previous and Next
       possible: the list the arrows walk is the one the filters produced, and
       re-deriving it on the record would be a second opinion about which
       children are in this section. */
    enabled: searching || browsing,
    placeholderData: keepPreviousData,
  })
  const rows = (results.data?.items ?? [])
    /* Suspended is not left. A suspended child is still enrolled and still
       has a seat, so they belong on the roll rather than in the list of
       people who have gone. */
    /* "Left" is four statuses — graduated, transferred, withdrawn, alumni —
       and the API takes one, so that view asks for everybody and narrows
       here. Suspended is not left: the child is still enrolled and still has
       a seat. */
    .filter((x) => (roll === 'left'
      ? x.status !== 'active' && x.status !== 'suspended'
      : true))

  const profile = useQuery({
    queryKey: ['student-profile', selected],
    queryFn: () => api.get<Profile>(`/api/v1/students/${selected}/profile`),
    enabled: !!selected,
  })

  /* The profile view carries full_name; the write API wants the parts. Rather
     than split a name on spaces -- which mangles "Meera Sai Menon" and every
     name that does not have exactly two words -- the record is fetched for the
     fields the form actually edits. */
  const [editing, setEditing] = useState(false)
  const [admitting, setAdmitting] = useState(false)
  const record = useQuery({
    queryKey: ['student-record', selected],
    queryFn: () => api.get<StudentDetail>(`/api/v1/students/${selected}`),
    // Fetched whenever a child is open, not only while editing: the update
    // dialog needs the name in parts and cannot wait for a second round trip
    // after somebody has already pressed the button.
    enabled: !!selected,
  })

  /* Everything written about this child, newest first.

     Fetched here rather than folded into the profile payload: it is one tab of
     seven and most readers open the overview and leave.

     ABOVE THE EARLY RETURNS, and it must stay there. It sat next to the tab
     that draws it, which is below `if (profile.isLoading) return <Loading/>` —
     so the hook ran on the render where the profile had arrived and not on the
     one before it. React counts hooks by position: the count changed between
     renders and the whole screen came down with error #310, showing a stack
     trace instead of the child. Same fault as LostLeads, same fix. */
  /* The depth behind the tabs, fetched once and shared by all of them.

     Not folded into the profile: that call has to be instant because somebody
     is on the telephone, and nobody opens all seven tabs. */
  const activityCatalogue = useQuery({
    queryKey: ['academics', 'activities'],
    enabled: !!selected,
    queryFn: () => api.get<List<{
      id: string; name: string; category: string; schedule?: string
      fee_paise: number; capacity: number; enrolled: number; is_active: boolean
    }>>('/api/v1/academics/activities'),
  })

  const detail = useQuery({
    queryKey: ['student-detail', selected],
    enabled: !!selected,
    queryFn: () => api.get<Detail>(`/api/v1/students/${selected}/detail`),
  })

  const remarks = useQuery({
    queryKey: ['student-remarks', selected],
    enabled: !!selected,
    queryFn: () => api.get<List<Remark>>(
      `/api/v1/teaching/remarks?student_id=${selected}`),
  })
  const remarkRows = remarks.data?.items ?? []

  /* The child's photograph.

     students.photo_file_id has been in the schema since the beginning and
     nothing ever wrote to it: the ID card reads it, the statutory return
     checks for it and the report card prints it, and all three saw an empty
     column because no screen could fill one. */
  const [photoFile, setPhotoFile] = useState<UploadedFile | null>(null)
  /* Leaving, and coming back.

     Nothing is deleted either way: the child's marks, attendance, fees and
     documents stay where they are and the status changes. A school asked
     about a former pupil years later must still be able to answer. */
  const [exiting, setExiting] = useState(false)
  const [statusAction, setStatusAction] = useState('')
  /* One dialog for the whole record, grouped in tabs.

     Editing was in pieces — names in one form, contact in another, the
     government codes nowhere — so "update this child", which is one job
     somebody sits down to do, was four screens and a gap. */
  const [updating, setUpdating] = useState(false)
  // The details block's own fields, as a form, without the six-tab dialog.
  const [editingDetails, setEditingDetails] = useState(false)
  const recordExit = useMutation({
    mutationFn: (v: { status: string; exit_date: string; reason: string }) =>
      api.post(`/api/v1/students/${selected}/exit`, v),
    onSuccess: () => {
      setExiting(false)
      qc.invalidateQueries({ queryKey: ['student-profile', selected] })
      qc.invalidateQueries({ queryKey: ['profile-search'] })
    },
  })
  /* Suspension leaves the enrolment open: the child is expected back, and the
     register should go on expecting them. */
  const suspend = useMutation({
    mutationFn: (v: { suspended: boolean }) =>
      api.post(`/api/v1/students/${selected}/suspend`, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['student-profile', selected] })
      qc.invalidateQueries({ queryKey: ['student-counts'] })
    },
  })
  const readmit = useMutation({
    mutationFn: () => api.post(`/api/v1/students/${selected}/readmit`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['student-profile', selected] })
      qc.invalidateQueries({ queryKey: ['profile-search'] })
    },
  })

  const [writingRemark, setWritingRemark] = useState(false)
  const addRemark = useMutation({
    mutationFn: (v: { kind: string; body: string; private: boolean; observed_on: string }) =>
      api.post('/api/v1/teaching/remarks', { ...v, student_id: selected }),
    onSuccess: () => {
      setWritingRemark(false)
      qc.invalidateQueries({ queryKey: ['student-remarks', selected] })
    },
  })

  const savePhoto = useMutation({
    mutationFn: (fileID: string) =>
      api.put(`/api/v1/students/${selected}/photo`, { file_id: fileID }),
    onSuccess: () => {
      setPhotoFile(null)
      qc.invalidateQueries({ queryKey: ['student-profile', selected] })
    },
  })

  /* The tab says which child it is holding.

     The strip names a tab from the catalogue, by path — right for a screen
     that shows one thing, wrong for one that shows a different child each
     time. Three children opened gave three tabs all reading "My students",
     and the only way to find the one you were reading was to click them one
     at a time.

     Named once the child has loaded, so nothing flickers; the store refuses
     to rename a tab that is no longer open. */
  const named = profile.data?.full_name
  useEffect(() => {
    if (named) setTabTitle(window.location.pathname + window.location.search, named)
  }, [named])

  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put(`/api/v1/students/${selected}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['student-profile', selected] })
      qc.invalidateQueries({ queryKey: ['student-record', selected] })
      setEditing(false)
    },
  })

  /* Where a record action sends you.

     An action names what it wants — "fees", "certificates" — and the concrete
     route depends on which workspace this role keeps that in. A principal's
     fee screen and an accountant's are different URLs and the same intent, so
     the record must not hard-code either. Resolving against the caller's own
     catalogue means the same action works from every role that has it, and
     silently does nothing from the ones that do not. */
  /* Issued, shown once, never stored. The response is held in component state
     rather than refetched, because the server does not keep the password and a
     second request would issue a different one.

     These three sat below the early returns — after "no student selected" and
     after "still loading". React counts hooks by call order, so the render
     that showed the search box ran twelve of them and the render after
     clicking Open ran fifteen, which is error #310 and a blank screen. A hook
     cannot live behind a condition; the early returns stay, and every hook
     now runs before them. */
  const toast = useToast()
  const [issued, setIssued] = useState<IssuedLogin | null>(null)
  /* The panel is drawn at the top of the record and the button is most of a
     page below it, so pressing Give a login from the guardians card looked
     like nothing at all: the answer appeared where nobody was looking. */
  const credentialsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (issued) credentialsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [issued])
  /* Both of these had onSuccess and nothing else.

     Issuing a login is a one-shot act — the server does not keep the password —
     so a failure that says nothing is the worst possible outcome: the clerk
     sees no panel, assumes the click missed, and presses again. The error is
     named rather than generic, because "could not issue a login" and "this
     guardian already has one" need different next steps from whoever is
     standing at the desk. */
  const studentLogin = useMutation({
    mutationFn: (opts?: { reset?: boolean }) =>
      api.post<IssuedLogin>(
        `/api/v1/setup/students/${selected}/login${opts?.reset ? '?reset=true' : ''}`, {}),
    onSuccess: (v) => setIssued({
      ...v, who: v.full_name,
      reset: () => studentLogin.mutate({ reset: true }),
    }),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : 'Could not issue a login for this student'),
  })
  const guardianLogin = useMutation({
    mutationFn: (v: { g: Profile['guardians'][number]; reset?: boolean }) =>
      api.post<IssuedLogin>(
        `/api/v1/setup/guardians/${v.g.id}/login${v.reset ? '?reset=true' : ''}`, {}),
    onSuccess: (v, sent) => setIssued({
      ...v, who: v.full_name,
      reset: () => guardianLogin.mutate({ g: sent.g, reset: true }),
    }),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : 'Could not issue a login for this guardian'),
  })

  const role = useActiveRole()
  const navigate = useNavigate()
  const session = useSession()
  const held = new Set(session.permissions)

  /* Slugs that are verbs, not capabilities.

     The fallback below matches on the last segment, so a FEATURE key like
     "…​.issue_certificate" is answered by whichever workspace grants it. Applied
     to a PERMISSION key it was a hole the size of the product: students.write
     was satisfied by academics.homework.write, so every teacher in the school
     "could" edit any child, add a photograph and issue a family login — until
     the server refused them and they were shown "missing permission:
     students.write" about a button the product had offered.

     These words appear at the end of nearly every permission this product
     defines, so a match on one says nothing at all. */
  const GENERIC = new Set([
    'read', 'write', 'approve', 'export', 'send', 'create', 'update', 'delete',
    'manage', 'view', 'all', 'any',
  ])

  function can(featureKey: string) {
    if (held.has(featureKey)) return true
    const slug = featureKey.split('.').slice(-1)[0]
    if (GENERIC.has(slug)) return false
    // A capability may be granted through a different role's feature key —
    // match on the trailing slug so "issue a certificate" is answered by
    // whichever workspace this person reaches it through.
    return [...held].some((k) => k.endsWith('.' + slug))
  }

  function go(target: string) {
    if (!role) return
    for (const section of role.sections) {
      for (const f of section.features) {
        if (f.live && f.in_scope && `${section.slug} ${f.slug}`.includes(target)) {
          navigate(`/${role.key}/${section.slug}/${f.slug}`)
          return
        }
      }
    }
  }

  if (!selected) {
    return (
      <>
        <PageHead
          eyebrow="Student Information"
          title="Student 360"
          description="Search a student to see everything about them on one page."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-44">
                <Select
                  value={roll}
                  onChange={(v) => setRoll(v as Roll)}
                  options={[
                    { value: 'active', label: 'On the roll' },
                    { value: 'suspended', label: 'Suspended' },
                    { value: 'new', label: 'New this year' },
                    { value: 'left', label: 'Left the school' },
                    { value: 'all', label: 'Everyone' },
                  ]}
                />
              </div>
              <div className="w-40">
                <Select
                  value={classID}
                  onChange={(v) => { setClassID(v); setSectionID('') }}
                  options={[
                    { value: '', label: 'All classes' },
                    ...(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </div>
              <div className="w-40">
                <Select
                  value={sectionID}
                  onChange={setSectionID}
                  options={[
                    { value: '', label: classID ? 'All sections' : 'Section' },
                    ...sectionsOfClass.map((x) => ({
                      value: x.id,
                      label: `${x.class_name}-${x.name}`,
                    })),
                  ]}
                />
              </div>
              <Input value={search} onChange={setSearch} placeholder="Name or admission no." />
              {can('students.write') && (
                <Button variant={admitting ? 'secondary' : 'primary'} onClick={() => setAdmitting(!admitting)}>
                  {admitting ? 'Close' : 'Admit a student'}
                </Button>
              )}
            </div>
          }
        />
        <PageBody>
          {/* This screen is where somebody looking to add a child ends up, so
              the form belongs here rather than only in the setup wizard: a
              search box that answers "no student matches" and offers no way to
              create one is a dead end at the exact moment it matters. */}
          {admitting && can('students.write') && (
            <div className="mb-4">
              <AdmitStudent onDone={() => results.refetch()} />
            </div>
          )}
          {counts.data && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/* All four filter, including the two that did not.

                  A tile showing a number somebody cannot act on is a number
                  they have to go and re-derive from a dropdown — and two of
                  these were exactly that, sitting beside two that worked. */}
              <RollTile label="On the roll" value={counts.data.active ?? 0}
                note="currently studying" active={roll === 'active'}
                onClick={() => patch({ roll: null, list: '1', class: null, section: null })} />
              <RollTile label="Left" value={counts.data.left ?? 0}
                note="TC issued, withdrawn or graduated" active={roll === 'left'}
                onClick={() => patch({ roll: 'left', list: '1', class: null, section: null })} />
              <RollTile label="Suspended" value={counts.data.suspended ?? 0}
                note="temporarily barred" active={roll === 'suspended'}
                onClick={() => patch({ roll: 'suspended', list: '1', class: null, section: null })} />
              <RollTile label="New this year" value={counts.data.new_this_year ?? 0}
                note="admitted this academic year" active={roll === 'new'}
                onClick={() => patch({ roll: 'new', list: '1', class: null, section: null })} />
            </div>
          )}
          {!searching && !browsing ? (
            <EmptyState
              title="Pick a class, or search for a student"
              body="Choose a class and section to see who is in it, or type at least two characters of a name or admission number." />
          ) : results.isLoading ? (
            <Loading />
          ) : (
            <Card>
              {/* What the list is, said plainly: a roll read as complete when
                  it was a filtered subset is the whole risk of this screen. */}
              <CardHeader
                title={
                  rows.length + (rows.length === 1 ? ' student' : ' students') +
                  (roll === 'left' ? ' who have left' : roll === 'active' ? ' on the roll' : '')
                }
                action={
                  browsing || searching ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        patch({ class: null, section: null, q: null, roll: null, list: null })
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
              {/* The columns an office actually reads a roll by: who, where,
                  their number, how old, and a phone. Admission number came
                  first before, which is the thing you look up BY rather than
                  the thing you look FOR. */}
              <Table head={['Student', 'Class / sec', 'Adm no.', 'Date of birth', 'Contact', 'Status', '']}
                empty={!rows.length}
                emptyLabel={roll === 'left'
                  ? 'Nobody has been recorded as leaving.'
                  : 'No student matches.'}>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <Td className="font-medium">
                      {s.full_name}
                      {s.roll_no ? (
                        <span className="block text-[12px] font-normal text-muted-foreground">
                          Roll {s.roll_no}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{s.class_name ? `${s.class_name}-${s.section_name}` : '—'}</Td>
                    <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                    <Td className="text-muted-foreground">
                      {s.date_of_birth ? formatDate(s.date_of_birth) : '—'}
                    </Td>
                    <Td className="text-muted-foreground">{s.primary_phone ?? '—'}</Td>
                    <Td><Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status}</Badge></Td>
                    <Td><Button size="sm" onClick={() => setSelected(s.id)}>Open</Button></Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </PageBody>
      </>
    )
  }

  if (profile.isLoading) return <Loading />
  if (profile.error) return <ErrorState error={profile.error} />
  const p = profile.data!

  /* Whether the person reading this is teaching the child or filing returns
     about them. The workspace they are actually in, not the roles they hold:
     a principal who also teaches a class still runs the school, and while
     they are standing in the principal's workspace they still need the
     admissions identifiers on this page. */
  const teacherOnly = role?.key === 'faculty'


  const cls = p.class_name ? `${p.class_name}${p.section_name ? `-${p.section_name}` : ''}` : 'Unplaced'
  const overdue = p.invoices.filter((i) => i.status === 'overdue').length

  /* Actions live on the record, not scattered across the modules that own
     them. Issuing a TC is a thing you do *to a student*; making someone find
     the certificates screen and search for the child again is how an ERP
     turns a thirty-second job into a three-minute one.

     Two different things used to be greyed out here and they are not the
     same thing. An action this account lacks the permission for stays,
     disabled, with the permission named beside it — somebody has to be able
     to see what to ask for. An action nobody can perform because it is not
     written yet is gone; "Not built yet" in a menu is our roadmap, printed
     where a person was looking for a control. */
  const mayIssue = can('students.write')
  const issueGuardian = (g: Profile['guardians'][number]) => guardianLogin.mutate({ g })

  const actions: RecordAction[] = [
    { label: 'Record payment', onClick: () => go('fees'),
      /* THE KEY HAS TO EXIST.

         These named catalogue features that are not in the catalogue —
         finance.fees.collect_payment and
         institution_admin.students.certificates_documents appear nowhere in
         catalog_gen.go — so can() could never match one, the suffix fallback
         had nothing to fall back to, and four actions sat permanently greyed
         with "Needs the certificates permission" against a principal who holds
         everything. The real keys are take_fee_payment and
         certificates_transfers. */
      disabled: !can('finance.fees.take_fee_payment'),
      disabledReason: 'Needs the fee counter permission' },
    { label: 'Issue certificate', onClick: () => go('certificates'),
      disabled: !can('institution_admin.students.certificates_transfers'),
      disabledReason: 'Needs the certificates permission' },
    { label: 'Generate transfer certificate', onClick: () => go('certificates'),
      disabled: !can('institution_admin.students.certificates_transfers'),
      disabledReason: 'Needs the certificates permission' },
    { label: 'Send message', onClick: () => go('announcements'),
      // Same fault: comms.messages.send is not a catalogue key either. The
      // workspaces call it <workspace>.communication.messages, and can()
      // matches on the trailing slug across whichever the reader holds.
      disabled: !can('institution_admin.communication.messages'),
      disabledReason: 'Needs the messaging permission' },
    /* "Change section" was here, permanently disabled with "Not built yet"
       for its reason. A menu item that can never be clicked is not a control,
       it is an announcement; it comes back when moving a child between
       sections is something this screen can actually do. */
    /* The child's own way in. Nothing outside the demo seeder had ever given
       a student an account, so the whole student workspace was unreachable in
       a real school. The admission number becomes the username. */
    { label: 'Give this student a login', onClick: () => studentLogin.mutate({}),
      disabled: !can('students.write') || studentLogin.isPending,
      disabledReason: 'Needs permission to change student records' },
    ...(p.status === 'active' || p.status === 'suspended'
      ? [{
          label: p.status === 'suspended' ? 'Lift the suspension' : 'Suspend',
          onClick: () => suspend.mutate({ suspended: p.status !== 'suspended' }),
          disabled: !can('students.write') || suspend.isPending,
          disabledReason: 'Needs the student write permission',
        }]
      : []),
    ...(p.status === 'active' || p.status === 'suspended'
      ? [{
          label: 'Record that they have left',
          onClick: () => setExiting(true),
          disabled: !can('students.write'),
          disabledReason: 'Needs the student write permission',
        }]
      : []),
    ...(p.status !== 'active' && p.status !== 'suspended'
      ? [{
          label: 'Put back on the roll',
          onClick: () => readmit.mutate(),
          disabled: !can('students.write') || readmit.isPending,
          disabledReason: 'Needs the student write permission',
        }]
      : []),
    { label: editing ? 'Stop editing' : 'Edit student', onClick: () => setEditing(!editing),
      disabled: !can('students.write'),
      disabledReason: 'Needs permission to change student records' },
  ]

  const credentials = issued && (
    <div ref={credentialsRef}>
    <Card className={cn('mb-4', issued.password ? 'border-success' : 'border-warning')}>
      <CardHeader
        /* An existing login is an answer, not a credential. Showing it under
           "Login issued" with an empty Password read as a button that had done
           nothing — which is exactly what somebody standing at the desk
           concluded. */
        /* A password in hand is the thing that matters, however it got here.

           The server answers a RESET with existing:true — the account did
           already exist — and a real password beside it. Keying the panel on
           `existing` therefore hid the password of the reset somebody had just
           asked for: they pressed the button, the card stayed as it was, the
           family's old password had already stopped working, and the new one
           was in the response and nowhere on the screen. */
        title={
          issued.password
            ? `Login for ${issued.who}`
            : `${issued.who} already has a login`
        }
        description={
          issued.password
            ? 'Shown once and not stored anywhere. Copy it now — if it is lost, reset it again rather than looking this one up.'
            : issued.note
        }
      />
      <dl className="divide-y text-[14px]">
        <Field k="Sign in as" v={issued.sign_in_as} mono />
        {issued.password && <Field k="Password" v={issued.password} mono />}
        {issued.relation && <Field k="Relation" v={issued.relation} />}
      </dl>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        {/* The password cannot be shown, because the school does not keep it.

            A reset is the only way to put one in somebody's hand again, and it
            stops the one the family may still be using — so it is offered
            plainly and named for what it does rather than dressed as "show
            password", which is a thing this product cannot do. */}
        {!issued.password && issued.reset && (
          <Button
            size="sm"
            disabled={studentLogin.isPending || guardianLogin.isPending}
            onClick={issued.reset}
          >
            Reset the password
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
          {issued.password ? 'I have copied it' : 'Close'}
        </Button>
      </div>
    </Card>
    </div>
  )

  const tabs: RecordTab[] = [
    {
      key: 'overview', label: 'Overview',
      render: () => (
        <div className="grid gap-6 lg:grid-cols-2">
          {editing ? (
            <Card className="lg:col-span-2">
              <CardHeader
                title="Edit details"
                description="Everything the school holds about this child. Blank is allowed — a field nobody has filled in yet is better than a guess."
              />
              <div className="p-4">
                {record.isLoading ? <Loading /> : record.error ? (
                  <ErrorState error={record.error} />
                ) : (
                  <StudentForm
                    student={record.data!}
                    profile={p}
                    saving={save.isPending}
                    error={save.error}
                    onCancel={() => setEditing(false)}
                    onSave={(body) => save.mutate(body)}
                  />
                )}
              </div>
            </Card>
          ) : null}
          {/* 4. QUICK STATUS — the three things somebody wants before they
                 have finished reading the name, and the one that cannot wait.

                 The allergy tag is first and is the only one that shouts. A
                 severe allergy is the single fact on this page where being
                 told late is the whole harm, and it was previously nowhere on
                 the screen at all — it lived in the infirmary module, which a
                 class teacher has no reason to open. */}
          <div className="lg:col-span-2 flex flex-wrap gap-3">
            {p.allergies && (
              <div className="flex-1 basis-full rounded-xl border-2 border-danger bg-danger/5 px-4 py-3">
                <p className="eyebrow text-danger">Medical alert</p>
                <p className="mt-0.5 text-[14px] font-medium">{p.allergies}</p>
              </div>
            )}
            <QuickTile
              label="Attendance"
              value={`${p.attendance.percent}%`}
              tone={p.attendance.below_threshold ? 'danger' : 'success'}
              note={`${p.attendance.present} of ${p.attendance.total} days`}
            />
            <QuickTile
              label="Fees"
              value={p.fees.outstanding_paise > 0
                ? formatPaise(p.fees.outstanding_paise)
                : 'Clear'}
              tone={p.fees.outstanding_paise > 0 ? 'warning' : 'success'}
              note={p.fees.outstanding_paise > 0 ? 'outstanding' : 'nothing due'}
            />
            {p.house_name && (
              <QuickTile label="House" value={p.house_name} tone="neutral"
                note={p.house_color ? undefined : undefined} swatch={p.house_color} />
            )}
            {p.height_cm && (
              <QuickTile
                label="Height & weight"
                value={`${p.height_cm} cm · ${p.weight_kg} kg`}
                tone="neutral"
                note={p.bmi ? `BMI ${p.bmi}${p.measured_on ? ` · ${formatDate(p.measured_on)}` : ''}` : undefined}
              />
            )}
          </div>
          {/* STATUS, AND THE BUTTONS THAT CHANGE IT, on the page.

              Exit, suspension and re-admission were built and then put inside
              an "Actions" dropdown at the top of the record — the same place
              Edit was hidden, and with the same result: people concluded the
              product could not do it. A thing a school does to a child belongs
              on the child's record where the eye already is, not behind a menu
              somebody has to think to open. */}
          <Card className="lg:col-span-2">
            <CardHeader
              title="Status on the roll"
              description={
                p.status === 'active'
                  ? 'On the roll and being taught.'
                  : p.status === 'suspended'
                    ? 'Still enrolled and still holding a seat — the fees, the register and the class list are unchanged.'
                    : 'Off the roll. The record is kept in full: marks, attendance, fees and documents are all still here.'
              }
              action={
                <Badge tone={p.status === 'active' ? 'success'
                  : p.status === 'suspended' ? 'danger' : 'warning'}>
                  {p.status}
                </Badge>
              }
            />
            <div className="flex flex-wrap items-center gap-3 px-5 pb-5">
              {can('students.write') ? (
                <>
                  {/* ONE DROPDOWN, not a row of buttons.

                      Three buttons of equal weight sat side by side and two of
                      them end a child's time at the school — a row where
                      Suspend is the same size and colour as Issue a transfer
                      certificate invites the wrong press. Choosing the thing
                      and then confirming it is two deliberate acts. */}
                  <div className="w-64">
                    <Select
                      value={statusAction}
                      onChange={setStatusAction}
                      placeholder="Change this status…"
                      options={[
                        ...(p.status === 'active'
                          ? [{ value: 'suspend', label: 'Suspend' }]
                          : p.status === 'suspended'
                            ? [{ value: 'unsuspend', label: 'Lift the suspension' }]
                            : []),
                        ...(p.status === 'active' || p.status === 'suspended'
                          ? [
                              { value: 'exit', label: 'Record that they have left' },
                              { value: 'tc', label: 'Issue a transfer certificate' },
                            ]
                          : [{ value: 'readmit', label: 'Put back on the roll' }]),
                      ]}
                    />
                  </div>
                  {statusAction && (
                    <Button
                      disabled={suspend.isPending || readmit.isPending}
                      onClick={() => {
                        if (statusAction === 'suspend') suspend.mutate({ suspended: true })
                        if (statusAction === 'unsuspend') suspend.mutate({ suspended: false })
                        if (statusAction === 'exit') setExiting(true)
                        if (statusAction === 'readmit') readmit.mutate()
                        if (statusAction === 'tc') go('certificates')
                        setStatusAction('')
                      }}
                    >
                      Do it
                    </Button>
                  )}
                  {p.status !== 'active' && p.status !== 'suspended' && p.exit_reason && (
                    <span className="text-[13px] text-muted-foreground">
                      {p.exit_reason}
                      {p.exit_date ? ` · ${formatDate(p.exit_date)}` : ''}
                    </span>
                  )}
                </>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  Changing a child&rsquo;s status needs the student write permission.
                </p>
              )}
            </div>
          </Card>
          {p.status === 'suspended' && (
            <Card className="border-danger lg:col-span-2">
              <CardHeader
                title="This child is suspended"
                description="They are still enrolled and still on the roll — the seat, the fees and the register are unchanged. Lift the suspension when they return."
              />
            </Card>
          )}
          {p.status !== 'active' && p.status !== 'suspended' && (
            <Card className="border-warning lg:col-span-2">
              <CardHeader
                title="This child has left the school"
                description={
                  'Their record is kept in full — marks, attendance, fees and documents. '
                  + 'They are off the roll and out of the class lists.'
                }
              />
              <dl className="divide-y text-[14px]">
                <Field k="Status" v={p.status} />
              </dl>
            </Card>
          )}
          {exiting && (
            <Card className="lg:col-span-2">
              <CardHeader
                title="Record that this child has left"
                description="Nothing is deleted. The record stays and can be put back on the roll if this was a mistake."
              />
              <div className="p-4">
                <ExitForm
                  saving={recordExit.isPending}
                  error={recordExit.error}
                  onCancel={() => setExiting(false)}
                  onSave={(v) => recordExit.mutate(v)}
                />
              </div>
            </Card>
          )}
          {/* THE RECORD, laid out as somebody reads it.

              A person opening this page is doing one of two things: checking
              they have the right child in front of them, or looking up one
              fact about them. The narrow column answers the first â face,
              name, class, who to ring â and the wide column answers the
              second.

              The details are a grid of labelled boxes rather than a list of
              rows. Fifteen key-and-value rows down a page is a thing you read
              from the top; pairs of boxes are a thing you scan, and scanning
              is what actually happens here. */}
          <div className="lg:col-span-2 grid gap-6 lg:grid-cols-[minmax(0,30%)_minmax(0,1fr)] lg:items-start">
            <div className="space-y-6">
              <Card>
                <div className="p-5">
                  <div className="mx-auto h-[34mm] w-[28mm] overflow-hidden rounded border bg-muted/30">
                    {p.photo_file_id && (
                      <img
                        src={`/api/v1/files/${p.photo_file_id}`}
                        alt={`Photograph of ${p.full_name}`}
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  {/* THE IDENTIFYING FACTS, under the face and nowhere else.

                      Name, class and admission number were three rows inside a
                      table of fifteen, so the things somebody checks first were
                      indistinguishable from the things they check once a year. */}
                  <p className="mt-3 text-center text-[16px] font-semibold">{p.full_name}</p>
                  <p className="text-center text-[13px] text-muted-foreground">
                    {cls}{p.roll_no ? ` · Roll ${p.roll_no}` : ''}
                  </p>
                  <p className="text-center font-mono text-[12px] text-muted-foreground">
                    {p.admission_no}
                  </p>
                  {can('students.write') && (
                    <div className="mt-3 flex justify-center">
                      <FilePicker
                        value={photoFile}
                        onChange={(f) => {
                          setPhotoFile(f)
                          // Saved on upload: a photograph chosen and then left
                          // unsaved is the commonest way this stays empty.
                          if (f) savePhoto.mutate(f.file_id)
                        }}
                        purpose="student_photo"
                        label={p.photo_file_id ? 'Change photo' : 'Upload photo'}
                        /* The picker's own hint is about attachments — "any
                           document, image, recording or archive, up to 64 MB" —
                           which under a passport frame is three lines of advice
                           about the wrong thing. */
                        hint="A portrait. Passport size prints best."
                      />
                    </div>
                  )}
                  {savePhoto.error && <FormNotice error={savePhoto.error} />}
                </div>
              </Card>

              <Guardians p={p} onIssue={mayIssue ? issueGuardian : undefined}
                mayEdit={can('students.write')}
                onChanged={() => qc.invalidateQueries({ queryKey: ['student-profile', selected] })} />

            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader
                  title="Student details"
                  /* TWO WAYS IN, because they answer different questions.

                     "Expand & edit" opens this block's own fields as a form,
                     which is what somebody correcting a blood group wants.
                     "Update details" opens the whole record in tabs — names,
                     identifiers, address, emergency contact — which is what
                     somebody working through a new admission wants. Offering
                     only the second made fixing one field a six-tab dialog. */
                  action={can('students.write') ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="secondary"
                        onClick={() => setEditingDetails(true)}>
                        Expand &amp; edit
                      </Button>
                      <Button size="sm" onClick={() => setUpdating(true)}>
                        Update details
                      </Button>
                    </div>
                  ) : undefined}
                />
                {/* THE GREY BLOCK WAS AN EMPTY GRID CELL.

                    gap-px over a bg-border container draws the gaps by letting
                    the background show through — which works until the last row
                    is half full, and then a whole missing cell shows through as
                    a grey slab. Borders on the cells instead: nothing shows
                    through, because there is nothing behind them. */}
                <div className="grid sm:grid-cols-2">
                  {([
                    ['Admitted on', formatDate(p.admission_date)],
                    ['Date of birth', formatDate(p.date_of_birth)],
                    ['Gender', p.gender],
                    ['Blood group', p.blood_group],
                    ['Mother tongue', p.mother_tongue],
                    ['Medium', p.medium],
                    ['House', p.house_name],
                    ['Nationality', p.nationality],
                    /* The government identifiers and the statutory category
                       are the office's business. A teacher wants to know who to
                       ring, and four of these between them and the phone number
                       is four boxes of noise â so the faculty workspace does
                       not carry them, and the office still files the returns
                       they exist for. */
                    ...(teacherOnly ? [] : [
                      ['Category', p.category ? p.category.toUpperCase() : undefined],
                      ['Admitted under', [p.is_rte && 'RTE', p.is_cwsn && 'CWSN'].filter(Boolean).join(' · ')],
                      ['APAAR ID', p.apaar_id ?? 'Not issued'],
                      ['Child Info ID', p.child_info_id ?? 'Not linked'],
                      ['Aadhaar', p.aadhaar_last4 ? `•••• ${p.aadhaar_last4}` : undefined],
                      ['Previous school', p.prior_school],
                    ]),
                  ] as [string, string | undefined][])
                    /* FILLED ONLY, UNTIL SOMEBODY IS EDITING.

                       Reading, a box saying "Nationality —" tells you nothing
                       you did not know and takes the same room as one that
                       does; a dozen of them push the four facts that ARE
                       recorded off the first screen. Editing, the opposite is
                       true: an empty field you cannot see is a field you
                       cannot fill, which is how half of these came to be empty
                       in the first place. */
                    /* Only what is filled. An empty box tells a reader
                       nothing they did not know and takes the same room as one
                       that does; the Update details dialog is where every
                       field, filled or not, is offered. */
                    .filter(([, v]) => v && v !== 'Not issued' && v !== 'Not linked')
                    .map(([k, v]) => (
                    <div key={k} className="border-b border-r px-4 py-3">
                      <p className="eyebrow text-muted-foreground">{k}</p>
                      <p className={cn('mt-0.5 text-[14px]', !v && 'text-muted-foreground')}>
                        {v || 'Not recorded'}
                      </p>
                    </div>
                  ))}
                  {/* The school's own fields, beside the ones we thought of. */}
                  {Object.entries(p.custom_fields ?? {})
                    .filter(([k]) => k.startsWith('Details/'))
                    .map(([k, v]) => (
                      <div key={k} className="border-b border-r px-4 py-3">
                        <p className="eyebrow text-muted-foreground">{k.slice(8)}</p>
                        <p className="mt-0.5 text-[14px]">{v || '—'}</p>
                      </div>
                    ))}
                </div>
                {/* ALWAYS, for anyone who may write.

                    It was drawn only while `editing` was true — and Edit was
                    replaced by the Update details dialog, so nothing set that
                    flag any more and the button ceased to exist. A control
                    gated on a state the screen no longer enters is a control
                    that has been deleted without anybody deciding to. */}
                {can('students.write') && (
                  <div className="border-t px-5 py-3">
                    <AddDetailField
                      studentID={p.id}
                      onChanged={() => qc.invalidateQueries({ queryKey: ['student-profile', selected] })}
                    />
                  </div>
                )}
              </Card>

              <RecordBlock
                title="Contact and address"
                blockKey="Contact"
                studentID={p.id}
                mayEdit={can('students.write')}
                onChanged={() => qc.invalidateQueries({ queryKey: ['student-profile', selected] })}
                custom={p.custom_fields}
                /* Each field names the column it edits, so expanding gives a
                   real form rather than a list of dashes. The summary on the
                   card joins the address into one line; the form takes it
                   apart again, because "19 Green Park, Hyderabad, 500001" is
                   one thing to read and four things to type. */
                fields={[
                  { k: 'Address', v: p.address_line1, field: 'address_line1',
                    multiline: true, placeholder: 'House number and street' },
                  { k: 'Area or landmark', v: p.address_line2, field: 'address_line2' },
                  { k: 'City', v: p.city, field: 'city' },
                  { k: 'State', v: p.state, field: 'state' },
                  { k: 'Pincode', v: p.pincode, field: 'pincode', hint: 'Six digits' },
                  { k: 'Permanent address', v: p.permanent_address,
                    field: 'permanent_address', multiline: true,
                    hint: 'Only if it differs from the address above' },
                  { k: 'Emergency contact', v: p.emergency_contact_name,
                    field: 'emergency_contact_name', placeholder: 'Enter name',
                    hint: 'Somebody to ring when no parent answers. They get no login and no messages.' },
                  { k: 'Their phone', v: p.emergency_contact_phone,
                    field: 'emergency_contact_phone', placeholder: 'Enter phone number' },
                  { k: 'Relation', v: p.emergency_contact_relation,
                    field: 'emergency_contact_relation', placeholder: 'e.g. Uncle' },
                ]}
              />

              {/* Fields with no block of their own. Shown only when there are
                  some: an empty card headed "Also recorded" is a question mark
                  on every child's page. */}
              {(() => {
                const loose = Object.entries(p.custom_fields ?? {})
                  .filter(([k]) => !k.includes('/'))
                if (loose.length === 0) return null
                return (
                  <RecordBlock
                    title="Also recorded"
                    blockKey="Other"
                    studentID={p.id}
                    mayEdit={can('students.write')}
                    onChanged={() => qc.invalidateQueries({ queryKey: ['student-profile', selected] })}
                    fields={loose.map(([k, v]) => ({ k, v }))}
                  />
                )
              })()}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'academics', label: 'Academics',
      render: () => (
        <>
        <Card>
          <CardHeader title="Results" description="Published report cards only" />
          <Table head={['Exam', 'Percentage', 'Grade', 'Rank']} empty={!p.results.length}
            emptyLabel="Nothing published yet.">
            {p.results.map((x, i) => (
              <tr key={i}>
                <Td className="font-medium">{x.exam || '—'}</Td>
                <Td>{x.percentage ? `${x.percentage}%` : '—'}</Td>
                <Td>{x.grade ? <Badge tone="primary">{x.grade}</Badge> : '—'}</Td>
                <Td>{x.rank || '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <SubjectMarks rows={detail.data?.subject_marks ?? []} loading={detail.isLoading} />
        <CoScholastic
          studentID={p.id}
          rows={detail.data?.co_scholastic ?? []}
          mayEdit={can('academics.marks.write')}
          onChanged={() => detail.refetch()}
        />
        </>
      ),
    },
    {
      key: 'attendance', label: 'Attendance',
      render: () => (
        <>
          {/* THE SUMMARY FIRST. "Is this child in trouble" is answered by four
              numbers, and it was previously answered by counting coloured
              squares. */}
          <Card>
            <CardHeader title="This year" />
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
              {[
                ['School days', String(p.attendance.total)],
                ['Present', String(p.attendance.present)],
                ['Absent', String(Math.max(0, p.attendance.total - p.attendance.present))],
                ['Attendance', `${p.attendance.percent}%`],
              ].map(([k, v]) => (
                <div key={k} className="bg-background px-4 py-3">
                  <p className="eyebrow text-muted-foreground">{k}</p>
                  <p className="mt-0.5 text-[20px] font-semibold tabular-nums">{v}</p>
                </div>
              ))}
            </div>
          </Card>
          <LeaveHistory rows={detail.data?.leave ?? []} />
          <Card>
            <CardHeader
              title="Last 30 marked days"
              description={p.attendance.below_threshold
                ? 'Below the 75% board threshold for exam eligibility.'
                : 'Most recent first.'}
            />
            <div className="p-5">
              {p.recent_attendance.length === 0 ? (
                <p className="py-4 text-center text-[14px] text-muted-foreground">Nothing marked yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {p.recent_attendance.map((d) => (
                    <span key={d.date} title={`${d.date} — ${d.status}`}
                      className={cn('h-4 w-4 rounded-sm', DOT[d.status] ?? 'bg-muted')} />
                  ))}
                </div>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Recent days" />
            <Table head={['Date', 'Status']} empty={!p.recent_attendance.length}>
              {p.recent_attendance.slice(0, 15).map((d) => (
                <tr key={d.date}>
                  <Td className="text-muted-foreground">{formatDate(d.date)}</Td>
                  <Td><StatusPill status={d.status} /></Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      ),
    },
    {
      key: 'fees', label: 'Fees', badge: overdue || undefined,
      render: () => (
        <>
        <Card>
          <CardHeader
            title="Fee history"
            description={p.fees.outstanding_paise
              ? `${formatPaise(p.fees.outstanding_paise)} outstanding`
              : 'Settled in full'}
          />
          <Table head={['Date', 'Invoice', 'Amount', 'Paid', 'Status']} empty={!p.invoices.length}
            emptyLabel="No invoices raised.">
            {p.invoices.map((x) => (
              <tr key={x.invoice_no}>
                <Td className="text-muted-foreground">{formatDate(x.date)}</Td>
                <Td className="font-mono text-[12px]">{x.invoice_no}</Td>
                <Td>{formatPaise(x.net_paise)}</Td>
                <Td>{formatPaise(x.paid_paise)}</Td>
                <Td><StatusPill status={x.status} /></Td>
              </tr>
            ))}
          </Table>
        </Card>
        {/* The quote, the waivers and the bill, on the record.

            All three lived on the admission panel, which exists for ninety
            seconds and is then gone — so for every child admitted before
            today there was nowhere to see whether a concession had been asked
            for, and nowhere to ask for one. */}
        <StudentFees
          studentID={p.id}
          classID={detail.data?.class_id}
          mayEdit={can('students.write')}
          onChanged={() => {
            detail.refetch()
            qc.invalidateQueries({ queryKey: ['student-profile', selected] })
          }}
        />
        <FeeLedger heads={detail.data?.fee_heads ?? []} />
        <Receipts rows={detail.data?.payments ?? []} />
        </>
      ),
    },
    {
      key: 'documents', label: 'Documents',
      render: () => (
        <>
        <StudentDocuments
          studentID={p.id}
          rows={detail.data?.documents ?? []}
          mayEdit={can('students.write')}
          onChanged={() => detail.refetch()}
        />
        <Card>
          <CardHeader
            title="Certificates the school issued"
            description="What the school gave out, as opposed to what the family handed in."
          />
          <Table head={['Serial', 'Type', 'Issued']} empty={!p.documents.length}
            emptyLabel="Nothing issued for this child yet.">
            {p.documents.map((d) => (
              <tr key={d.serial_no}>
                <Td className="font-mono text-[12px]">{d.serial_no}</Td>
                <Td>{d.type}</Td>
                <Td className="text-muted-foreground">{formatDate(d.issued_on)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        </>
      ),
    },
    /* Transport came back, because there is now something to put in it.

       It was removed for being a tab that opened on "Not built yet" — a
       promise that paid out an apology. What was actually missing was a
       query: a bus seat has always been a transport_allocations row, and the
       record simply never asked for one. The front desk with a mother at the
       gate asking which bus her daughter takes was being sent to the
       transport module to find out about a child whose record was already
       open.

       Communication stays out. A child's messages are a real thing to show
       and there is no one place they live yet, so the tab returns when there
       is something behind it and not before. */
    {
      key: 'transport', label: 'Transport',
      render: () => (
        <>
        <Card>
          <CardHeader
            title="Bus route"
            description="The route this child is allotted, and where they are picked up and dropped."
          />
          <Table
            head={['Route', 'Vehicle', 'Pick-up', 'Drop', 'From']}
            empty={!p.transport.length}
            emptyLabel="This child does not use school transport."
          >
            {p.transport.map((t, i) => (
              <tr key={`${t.route}-${t.from}-${i}`}>
                <Td>{t.route}</Td>
                <Td className="font-mono text-[12px]">{t.vehicle || '—'}</Td>
                <Td>
                  {t.pickup_stop || '—'}
                  {t.pickup_time && (
                    <span className="text-muted-foreground"> · {t.pickup_time}</span>
                  )}
                </Td>
                <Td>
                  {t.drop_stop || '—'}
                  {t.drop_time && <span className="text-muted-foreground"> · {t.drop_time}</span>}
                </Td>
                <Td className="text-muted-foreground">
                  {formatDate(t.from)}
                  {t.to ? ` — ${formatDate(t.to)}` : ''}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <TransportCrew rows={detail.data?.transport_crew ?? []} />
        </>
      ),
    },
    {
      key: 'activities', label: 'Activities',
      badge: (detail.data?.activities ?? []).filter((a) => a.status === 'enrolled').length || undefined,
      render: () => (
        <Activities
          studentID={p.id}
          rows={detail.data?.activities ?? []}
          catalogue={activityCatalogue.data?.items ?? []}
          mayEdit={can('students.write')}
          onChanged={() => {
            detail.refetch()
            // The bill is real, so the fee tab and the overview tile must move
            // with it rather than showing yesterday's balance.
            qc.invalidateQueries({ queryKey: ['student-profile', selected] })
          }}
        />
      ),
    },
    {
      key: 'remarks', label: 'Remarks', badge: remarkRows.length || undefined,
      render: () => (
        <Card>
          <CardHeader
            title="What staff have written"
            action={
              <div className="flex flex-wrap items-center gap-2">
              {can('academics.homework.write') && (
                <Button size="sm" variant={writingRemark ? 'secondary' : 'primary'}
                  onClick={() => setWritingRemark(!writingRemark)}>
                  {writingRemark ? 'Close' : 'Add a remark'}
                </Button>
              )}
              <ExportRows
                rows={remarkRows}
                name="remarks"
                columns={[
                  { header: 'Observed on', value: (x) => x.observed_on },
                  { header: 'Written at', value: (x) => x.recorded_at },
                  { header: 'By', value: (x) => x.recorded_by },
                  { header: 'Kind', value: (x) => x.kind },
                  { header: 'Subject', value: (x) => x.subject },
                  { header: 'Remark', value: (x) => x.body },
                  { header: 'Seen by family', value: (x) => (x.private ? 'no' : 'yes') },
                ]}
              />
              </div>
            }
          />
          {writingRemark && (
            <div className="border-b bg-muted/20 p-4">
              <RemarkForm
                saving={addRemark.isPending}
                error={addRemark.error}
                onCancel={() => setWritingRemark(false)}
                onSave={(v) => addRemark.mutate(v)}
              />
            </div>
          )}
          {remarks.isLoading ? (
            <Loading />
          ) : remarkRows.length === 0 ? (
            <EmptyState
              title="Nothing written yet"
              body="Observations a teacher records about this child appear here, newest first."
            />
          ) : (
            <ul className="divide-y">
              {remarkRows.map((x) => (
                <li key={x.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={x.kind === 'concern' ? 'warning' : 'neutral'}>
                      {x.kind}
                    </Badge>
                    {x.subject && (
                      <span className="text-[13px] text-muted-foreground">{x.subject}</span>
                    )}
                    {/* Said plainly, because the difference decides whether
                        somebody can quote it to a parent. */}
                    {x.private && <Badge tone="danger">staff only</Badge>}
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-[14px]">{x.body}</p>
                  {/* Both dates, and the author. A remark observed on Tuesday
                      and typed on Friday is a different fact from one typed as
                      it happened, and after a complaint a head wants to know
                      which it was. */}
                  <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                    {x.recorded_by ?? 'unknown'} &middot; observed {formatDate(x.observed_on)}
                    {x.recorded_at && (
                      <> &middot; written {formatDateTime(x.recorded_at)}</>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ),
    },
    {
      key: 'history', label: 'History',
      render: () => (
        <Card>
          <CardHeader
            title="Enrolment history"
            description="Every year this child has been on the roll, and how each one ended."
          />
          {/* This said three things the header already said. A promotion
              closes one enrolments row and opens the next, so the record of
              where a child has been was sitting there the whole time — which
              is what a class teacher is asking when they ask whether a child
              has been detained before. */}
          {/* Read from the detail call, which also carries the remarks and
              whether the year was reached by promotion — both already on the
              enrolments row and both previously unread. */}
          <Table
            head={['Year', 'Class', 'Roll', 'From', 'Outcome', 'Note']}
            empty={!(detail.data?.enrolment_history ?? []).length}
            emptyLabel="No enrolment recorded."
          >
            {(detail.data?.enrolment_history ?? []).map((e, i) => (
              <tr key={`${e.year}-${e.from}-${i}`}>
                <Td>{e.year || '—'}</Td>
                <Td>{[e.class, e.section].filter(Boolean).join('-') || '—'}</Td>
                <Td className="tabular-nums">{e.roll_no ?? '—'}</Td>
                <Td className="text-muted-foreground">{formatDate(e.from)}</Td>
                <Td>
                  <Badge tone={e.status === 'active' ? 'success' : e.status === 'detained' ? 'warning' : undefined}>
                    {e.status}
                  </Badge>
                </Td>
                <Td className="text-muted-foreground">
                  {e.remarks || (e.promoted ? 'Promoted from the year before' : '—')}
                </Td>
              </tr>
            ))}
          </Table>
          <dl className="divide-y border-t text-[14px]">
            <Field k="Admitted" v={formatDate(p.admission_date)} />
          </dl>
        </Card>
      ),
    },
  ]

  return (
    <>
    {credentials}
    {editingDetails && (
      <FieldSheet
        title="Student details"
        studentID={p.id}
        onClose={() => setEditingDetails(false)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['student-profile', selected] })
          qc.invalidateQueries({ queryKey: ['student-record', selected] })
        }}
        fields={[
          { k: 'Date of birth', v: p.date_of_birth, field: 'date_of_birth', kind: 'date' },
          { k: 'Gender', v: p.gender, field: 'gender',
            options: [
              { value: 'male', label: 'Male' },
              { value: 'female', label: 'Female' },
              { value: 'other', label: 'Other' },
            ] },
          { k: 'Blood group', v: p.blood_group, field: 'blood_group' },
          { k: 'Mother tongue', v: p.mother_tongue, field: 'mother_tongue' },
          { k: 'Medium', v: p.medium, field: 'medium' },
          { k: 'Nationality', v: p.nationality, field: 'nationality' },
          ...(teacherOnly ? [] : [
            { k: 'Category', v: p.category, field: 'category',
              hint: 'For RTE, scholarship and statutory returns',
              options: [
                { value: 'general', label: 'General' }, { value: 'obc', label: 'OBC' },
                { value: 'sc', label: 'SC' }, { value: 'st', label: 'ST' },
                { value: 'ews', label: 'EWS' }, { value: 'other', label: 'Other' },
              ] },
            { k: 'APAAR ID', v: p.apaar_id, field: 'apaar_id', hint: 'Twelve digits' },
            { k: 'Child Info ID', v: p.child_info_id, field: 'child_info_id' },
            { k: 'Aadhaar (last 4)', v: p.aadhaar_last4, field: 'aadhaar_last4',
              hint: 'Only the last four are stored, deliberately' },
            { k: 'Previous school', v: p.prior_school, field: 'prior_school' },
          ]),
        ]}
      />
    )}
    {updating && (
      <StudentEditDialog
        student={{
          id: p.id,
          full_name: p.full_name,
          admission_no: p.admission_no,
          class_name: p.class_name,
          section_name: p.section_name,
          photo_file_id: p.photo_file_id,
          date_of_birth: p.date_of_birth,
          gender: p.gender,
          blood_group: p.blood_group,
          medium: p.medium,
          mother_tongue: p.mother_tongue,
          nationality: p.nationality,
          category: p.category,
          aadhaar_last4: p.aadhaar_last4,
          apaar_id: p.apaar_id,
          child_info_id: p.child_info_id,
          prior_school: p.prior_school,
          house_id: p.house_id,
          address_line1: p.address_line1,
          address_line2: p.address_line2,
          city: p.city,
          state: p.state,
          pincode: p.pincode,
          permanent_address: p.permanent_address,
          emergency_contact_name: p.emergency_contact_name,
          emergency_contact_phone: p.emergency_contact_phone,
          emergency_contact_relation: p.emergency_contact_relation,
          /* The name in parts, which the profile does not carry: it returns
             full_name because that is what every screen prints, and splitting
             it here would mangle "Meera Sai Menon" and every name that is not
             exactly two words. The form reads them from the record endpoint. */
          first_name: record.data?.first_name,
          middle_name: record.data?.middle_name,
          last_name: record.data?.last_name,
        }}
        onClose={() => setUpdating(false)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['student-profile', selected] })
          qc.invalidateQueries({ queryKey: ['student-record', selected] })
          qc.invalidateQueries({ queryKey: ['profile-search'] })
        }}
      />
    )}
    <RecordShell
      title={p.full_name}
      subtitle={`${p.admission_no} · ${cls}${p.roll_no ? ` · Roll ${p.roll_no}` : ''}`}
      status={p.status}
      facts={[
        {
          label: 'Attendance',
          value: `${p.attendance.percent}%`,
          tone: p.attendance.below_threshold ? 'bad' : 'good',
        },
        // "Fees settled" over a bare 0 read as "nothing has been settled",
        // the opposite of what it means. The nothing-due case says so in
        // words; the amount is only shown when there is one.
        {
          label: 'Outstanding',
          value: p.fees.outstanding_paise ? formatPaise(p.fees.outstanding_paise) : 'Nothing due',
          tone: p.fees.outstanding_paise ? 'warn' : 'good',
        },
        // Every receipt this child's account has ever taken, across all years
        // and any advance not yet applied to a bill — which is why it can
        // exceed the one invoice the Fees tab shows for this year.
        { label: 'Receipts, all years', value: formatPaise(p.fees.paid_paise) },
      ]}
      tabs={tabs}
      actions={actions}
      onBack={() => { setSelected(null); setSearch('') }}
      backLabel="Back to search"
    />
    </>
  )
}

/** A login handed over once. The server does not keep the password, so this
 *  lives in component state and a refetch would lose it -- which is correct:
 *  a password a system can show you twice is one it is storing in a form
 *  somebody else can read. */
interface IssuedLogin {
  sign_in_as: string
  full_name: string
  password: string
  relation?: string
  note: string
  who: string
  /* True when the person already had a login and none was issued. The server
     answers this rather than failing, because "they already have one" is not
     an error — it is the answer to the question that was asked. */
  existing?: boolean
  /* How to issue a fresh one, when they already have it. Held on the panel so
     the button knows which of the two endpoints to call without the panel
     having to know whose login it is showing. */
  reset?: () => void
}

/** Who to call. First thing anyone needs when a child is the subject. */
function Guardians({ p, onIssue, mayEdit, onChanged }: {
  p: Profile
  onIssue?: (g: Profile['guardians'][number]) => void
  mayEdit?: boolean
  onChanged?: () => void
}) {
  /* '' means "adding a new one"; a guardian id means "correcting that one".
     null means the form is closed. */
  const [editing, setEditing] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      api.post(`/api/v1/students/${p.id}/guardians`, v),
    onSuccess: () => { setEditing(null); onChanged?.() },
  })
  const unlink = useMutation({
    mutationFn: (gid: string) => api.del(`/api/v1/students/${p.id}/guardians/${gid}`),
    onSuccess: () => onChanged?.(),
  })
  return (
    <Card>
      {/* The block a teacher opens this page for. Father and mother first,
          because "ring the parents" is the action, and a list sorted by a
          primary-contact flag put an uncle at the top of it whenever somebody
          had ticked that box.

          The email is printed rather than hidden behind the word "email". A
          teacher writing to a parent copies the address; a mailto link is the
          wrong tool on a school desktop where the default mail client is
          usually nothing at all. Email stays optional — a phone number is the
          contact that matters and a parent without an address is not a
          record with something missing from it. */}
      <CardHeader
        title="Parents and guardians"
        description="Father and mother first"
        action={mayEdit ? (
          <Button size="sm" variant={editing === '' ? 'secondary' : 'primary'}
            onClick={() => setEditing(editing === '' ? null : '')}>
            {editing === '' ? 'Close' : 'Add a parent'}
          </Button>
        ) : undefined}
      />
      {editing === '' && mayEdit && (
        <div className="border-b bg-muted/20 p-4">
          <GuardianForm
            saving={save.isPending}
            error={save.error}
            onCancel={() => setEditing(null)}
            onSave={(v) => save.mutate(v)}
          />
        </div>
      )}
      {p.guardians.length === 0 ? (
        <div className="p-6">
          <EmptyState title="No guardian on record"
            body="Nobody can be contacted about this child." />
        </div>
      ) : (
        <ul className="divide-y">
          {[...p.guardians]
            .sort((a, b) => rankRelation(a.relation) - rankRelation(b.relation))
            .map((g) => (
            <li key={g.full_name + g.phone} className="px-5 py-3">
              {/* The name gets a floor, and the row is allowed to wrap.

                  It was `min-w-0` with no basis, beside a `shrink-0` cluster
                  holding a button, a phone number and an email address. In
                  the two-column overview that cluster is wider than the card,
                  so the name was left about eleven pixels and "Guardian of
                  Aarav ADM0001" came down the card a letter at a time.

                  flex-1 alone does not fix it — what is left over is still
                  almost nothing. The name claims a 12rem basis and the row
                  wraps, so when the two do not fit side by side the contacts
                  drop to their own line instead of crushing the name. A
                  viewport breakpoint would be the wrong instrument: this card
                  is narrow because it is in a two-up grid, not because the
                  window is. */}
              {editing === g.id && mayEdit && (
                <div className="mb-3 rounded-lg border bg-muted/20 p-3">
                  <GuardianForm
                    guardian={g}
                    saving={save.isPending}
                    error={save.error}
                    onCancel={() => setEditing(null)}
                    onSave={(v) => save.mutate({ ...v, id: g.id })}
                  />
                </div>
              )}
              {/* STACKED, not a row.

                  Name, badge, relation, three buttons, a phone number and an
                  email address were laid out as one wrapping row. In a column
                  a third of the page wide that is not a row, and the contacts
                  ran outside the card. */}
              <div className="flex flex-col gap-2">
                <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
                  {/* OPTIONAL, AND SILENT WHEN EMPTY.

                      Most schools photograph the child and not the parents,
                      so a blank frame on every row would be a column of empty
                      boxes reading as missing data. The frame appears when
                      there is a face in it, or when somebody who may edit is
                      looking — and then only as a small button. */}
                  {(g.photo_file_id || (mayEdit && g.id)) && (
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border bg-muted/30">
                      {g.photo_file_id && (
                        <img
                          src={`/api/v1/files/${g.photo_file_id}`}
                          alt={`Photograph of ${g.full_name}`}
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                  )}
                  <div className="min-w-0">
                    {/* gap-1.5 rather than nothing: the badge butted straight
                        against the last character of the name. */}
                    <p className="flex flex-wrap items-center gap-x-1.5 text-[14px] font-medium">
                      {g.full_name}
                      {g.is_primary && <Badge tone="primary">primary</Badge>}
                    </p>
                    <p className="text-[13px] text-muted-foreground">
                      {[g.relation, g.occupation].filter(Boolean).join(' · ')}
                    </p>
                    {mayEdit && g.id && (
                      <GuardianPhoto studentID={p.id} guardian={g} />
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
                  {onIssue && (
                    <Button size="sm" variant="secondary" onClick={() => onIssue(g)}>
                      Give a login
                    </Button>
                  )}
                  {mayEdit && g.id && (
                    <>
                      <Button size="sm" variant="ghost"
                        onClick={() => setEditing(editing === g.id ? null : g.id!)}>
                        {editing === g.id ? 'Close' : 'Edit'}
                      </Button>
                      {/* UNLINKS, and says so. The person is very often a
                          sibling's parent too, and deleting them would take a
                          mother off another child's record — with her login,
                          her fee reminders and her absence alerts. */}
                      <Button size="sm" variant="ghost"
                        disabled={unlink.isPending}
                        onClick={() => unlink.mutate(g.id!)}>
                        Remove
                      </Button>
                    </>
                  )}
                  {g.phone && (
                    <a href={`tel:${g.phone}`} className="inline-flex items-center gap-1 text-primary">
                      <Phone className="h-3 w-3" />{g.phone}
                    </a>
                  )}
                  {/* The address is the longest thing in the row and the
                      least urgent, so it is the one that gives way: capped
                      and truncated rather than pushing the name off the
                      card. The full address is still on the link, and
                      copying it copies all of it. */}
                  {g.email && (
                    <a
                      href={`mailto:${g.email}`}
                      title={g.email}
                      className="inline-flex min-w-0 max-w-full items-center gap-1 text-primary"
                    >
                      <Mail className="h-3 w-3 shrink-0" />
                      <span className="truncate">{g.email}</span>
                    </a>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* The student form.
 *
 * One form, every field the write API accepts, because the alternative -- a
 * profile screen that shows fourteen facts and lets you change none of them --
 * is what a principal reported after buying the product: a record they could
 * read and not correct.
 *
 * Nothing here is required except a first name, which is the only thing the
 * server insists on. Schools fill records in over weeks, and a form that
 * demands a blood group before it will save a corrected spelling is a form
 * people work around by not using it.
 */
function StudentForm({
  student, profile, saving, error, onSave, onCancel,
}: {
  student: StudentDetail
  profile: Profile
  saving: boolean
  error: unknown
  onSave: (body: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({
    admission_no: student.admission_no ?? '',
    first_name: student.first_name ?? '',
    middle_name: student.middle_name ?? '',
    last_name: student.last_name ?? '',
    date_of_birth: student.date_of_birth ?? '',
    gender: student.gender ?? '',
    blood_group: student.blood_group ?? '',
    medium: profile.medium ?? '',
    mother_tongue: profile.mother_tongue ?? '',
    religion: student.religion ?? '',
    address_line1: student.address_line1 ?? '',
    address_line2: student.address_line2 ?? '',
    category: student.category ?? profile.category ?? '',
    nationality: student.nationality ?? profile.nationality ?? '',
    aadhaar_last4: student.aadhaar_last4 ?? profile.aadhaar_last4 ?? '',
    house_id: profile.house_id ?? '',
    permanent_address: profile.permanent_address ?? '',
    emergency_contact_name: profile.emergency_contact_name ?? '',
    emergency_contact_phone: profile.emergency_contact_phone ?? '',
    emergency_contact_relation: profile.emergency_contact_relation ?? '',
    city: student.city ?? '',
    state: student.state ?? '',
    pincode: student.pincode ?? '',
    apaar_id: profile.apaar_id ?? '',
    child_info_id: profile.child_info_id ?? '',
    prior_school: profile.prior_school ?? '',
  })
  /* Whatever else this school keeps about a child.

     Held as a list of pairs rather than an object so the field being renamed
     keeps its position and its value while somebody is halfway through typing
     the new name — an object keyed by the name loses both on every keystroke. */
  const houses = useQuery({
    queryKey: ['academics', 'houses'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/academics/houses'),
  }).data?.items ?? []
  const [extra, setExtra] = useState<{ k: string; v: string }[]>(
    Object.entries(student.custom_fields ?? profile.custom_fields ?? {})
      .map(([k, v]) => ({ k, v: String(v) })))
  const [rte, setRte] = useState(profile.is_rte)
  const [cwsn, setCwsn] = useState(profile.is_cwsn)
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })

  return (
    <>
      <FormNotice error={error} />
      <FormGrid>
        <FormField label="Admission no."><Input value={f.admission_no} onChange={set('admission_no')} /></FormField>
        <FormField label="First name" required><Input value={f.first_name} onChange={set('first_name')} /></FormField>
        <FormField label="Middle name"><Input value={f.middle_name} onChange={set('middle_name')} /></FormField>
        <FormField label="Last name"><Input value={f.last_name} onChange={set('last_name')} /></FormField>
        <FormField label="Date of birth"><Input type="date" value={f.date_of_birth} onChange={set('date_of_birth')} /></FormField>
        <FormField label="Gender">
          <Select value={f.gender} onChange={set('gender')} placeholder="Not recorded"
            options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
        </FormField>
        <FormField label="Blood group">
          <Select kind="blood_group" addLabel="Add another group" value={f.blood_group} onChange={set('blood_group')} placeholder="Not recorded"
            options={['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => ({ value: b, label: b }))} />
        </FormField>
        <FormField label="Medium">
          <Select kind="medium" addLabel="Add another medium" value={f.medium} onChange={set('medium')} placeholder="Not recorded"
            options={['telugu', 'english', 'urdu', 'hindi', 'other'].map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))} />
        </FormField>
        <FormField label="Mother tongue">
          <Select kind="mother_tongue" addLabel="Add a language" value={f.mother_tongue} onChange={set('mother_tongue')} placeholder="Not recorded" options={[]} />
        </FormField>
        <FormField label="Religion">
          <Select kind="religion" addLabel="Add one" value={f.religion} onChange={set('religion')} placeholder="Not recorded" options={[]} />
        </FormField>
        <FormField label="Category" hint="For RTE, scholarship and statutory returns">
          <Select value={f.category} onChange={set('category')} placeholder="Not recorded"
            options={[
              { value: 'general', label: 'General' }, { value: 'obc', label: 'OBC' },
              { value: 'sc', label: 'SC' }, { value: 'st', label: 'ST' },
              { value: 'ews', label: 'EWS' }, { value: 'other', label: 'Other' },
            ]} />
        </FormField>
        <FormField label="Nationality"><Input value={f.nationality} onChange={set('nationality')} placeholder="Indian" /></FormField>
        {/* FOUR DIGITS, NOT TWELVE. The column holds the last four and checks
            it, which is enough to match a child against a government list and
            leaves the school holding nothing worth stealing. */}
        <FormField label="Aadhaar (last 4 digits)" hint="Only the last four are stored, on purpose">
          <Input value={f.aadhaar_last4} onChange={set('aadhaar_last4')} placeholder="••••" />
        </FormField>
        {/* HOUSES ARE OPTIONAL AND UNNAMED BY US. A school's houses are
            named after its founders, local rivers, saints, colours or birds —
            there is no default that is not wrong somewhere. A school with no
            house system sees an empty dropdown and ignores it. */}
        <FormField label="House" hint={houses.length ? undefined : 'No houses set up — Academics → Houses'}>
          <Select value={f.house_id} onChange={set('house_id')} placeholder="Not in a house"
            options={houses.map((h) => ({ value: h.id, label: h.name }))} />
        </FormField>
        <FormField label="City"><Input value={f.city} onChange={set('city')} /></FormField>
        <FormField label="State"><Input value={f.state} onChange={set('state')} /></FormField>
        <FormField label="Pincode" hint="Six digits"><Input value={f.pincode} onChange={set('pincode')} /></FormField>
        <FormField label="APAAR ID" hint="Twelve digits"><Input value={f.apaar_id} onChange={set('apaar_id')} /></FormField>
        <FormField label="Child Info ID"><Input value={f.child_info_id} onChange={set('child_info_id')} /></FormField>
        <FormField label="Previous school"><Input value={f.prior_school} onChange={set('prior_school')} /></FormField>
      </FormGrid>

      <FormField label="Address">
        <Textarea value={f.address_line1} onChange={set('address_line1')} rows={2} />
      </FormField>
      <FormField label="Address (second line)" hint="Landmark, area — optional">
        <Input value={f.address_line2} onChange={set('address_line2')} />
      </FormField>
      <FormField label="Permanent address" hint="Only if it differs from the address above">
        <Textarea value={f.permanent_address} onChange={set('permanent_address')} rows={2} />
      </FormField>

      <div className="mt-4 border-t pt-4">
        <p className="eyebrow mb-1">Emergency contact</p>
        {/* NOT A GUARDIAN. A guardian gets a login, fee reminders and absence
            alerts; the neighbour who holds a spare key should get none of
            them, so this is three plain fields rather than another parent. */}
        <p className="mb-3 text-[12.5px] text-muted-foreground">
          Somebody to ring when no parent answers. They get no login and no messages.
        </p>
        <FormGrid>
          <FormField label="Name"><Input value={f.emergency_contact_name} onChange={set('emergency_contact_name')} /></FormField>
          <FormField label="Phone"><Input value={f.emergency_contact_phone} onChange={set('emergency_contact_phone')} /></FormField>
          <FormField label="Relation" hint="Neighbour, aunt, family friend">
            <Input value={f.emergency_contact_relation} onChange={set('emergency_contact_relation')} />
          </FormField>
        </FormGrid>
      </div>

      {/* ANYTHING ELSE THIS SCHOOL KEEPS.

          Schools differ in ways no fixed column list survives — a bus stop, a
          sibling's admission number, a scholarship reference, the parent's
          employer. The alternative was a migration per school, so the answer
          to "can we record X" was always no. */}
      <div className="mt-5 border-t pt-4">
        <p className="eyebrow mb-1">Anything else this school records</p>
        <p className="mb-3 text-[12.5px] text-muted-foreground">
          Optional. Add whatever this school keeps that the fields above do not cover.
        </p>
        <div className="space-y-2">
          {extra.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="w-56"
                value={row.k}
                placeholder="Field name"
                onChange={(v) => setExtra(extra.map((x, j) => (j === i ? { ...x, k: v } : x)))}
              />
              <Input
                className="flex-1"
                value={row.v}
                placeholder="Value"
                onChange={(v) => setExtra(extra.map((x, j) => (j === i ? { ...x, v } : x)))}
              />
              <Button size="sm" variant="secondary"
                onClick={() => setExtra(extra.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="secondary" className="mt-2"
          onClick={() => setExtra([...extra, { k: '', v: '' }])}>
          Add a field
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap gap-4">
        <Checkbox label="Admitted under RTE" checked={rte} onChange={setRte} />
        <Checkbox label="Child with special needs (CWSN)" checked={cwsn} onChange={setCwsn} />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          disabled={saving || !f.first_name.trim()}
          onClick={() => onSave({
            ...f,
            is_rte: rte,
            is_cwsn: cwsn,
            // A half-typed row is not a field yet. Sending it would store a
            // blank name the server refuses, failing the whole save over a
            // row the person had not finished.
            custom_fields: Object.fromEntries(
              extra.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v])),
          })}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </>
  )
}


/**
 * Father, then mother, then everybody else.
 *
 * The list was ordered by the is_primary flag, which is a billing and consent
 * field — whoever the office ticked. A teacher looking for a parent wants the
 * parents, and an uncle recorded as the primary contact should not be the
 * first row on the page every time.
 *
 * Unknown relations sort last rather than being hidden. A grandmother who is
 * raising the child is exactly the person somebody needs to reach.
 */
/* One parent's photograph.

   A picker per row rather than one shared dialog: the thing being edited is
   "the father's photograph", and a dialog that asks which parent afterwards
   is a question the row already answered.

   Saved on upload, like the child's. A photograph chosen and then left
   unsaved is the commonest way one of these columns stays empty. */
function GuardianPhoto({ studentID, guardian }: {
  studentID: string
  guardian: Profile['guardians'][number]
}) {
  const qc = useQueryClient()
  const [file, setFile] = useState<UploadedFile | null>(null)
  const save = useMutation({
    mutationFn: (fileID: string) =>
      api.put(`/api/v1/students/${studentID}/guardians/${guardian.id}/photo`,
        { file_id: fileID }),
    onSuccess: () => {
      setFile(null)
      qc.invalidateQueries({ queryKey: ['student-profile', studentID] })
    },
  })
  /* SHOWN ONLY WHEN ASKED FOR.

     The picker rendered inline on every parent, and it carries its own hint —
     "Any document, image, recording or archive, up to 64 MB" — which in a
     column a third of the page wide wrapped to three lines under every name.
     Four parents made a card of file-upload advice with the phone numbers
     somewhere underneath. */
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="mt-0.5 px-0"
        onClick={() => setOpen(true)}>
        {guardian.photo_file_id ? 'Change photo' : 'Add a photo'}
      </Button>
    )
  }
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-2">
        <FilePicker
          value={file}
          onChange={(f) => { setFile(f); if (f) save.mutate(f.file_id) }}
          purpose="student_photo"
          label={guardian.photo_file_id ? 'Replace photo' : 'Choose a photo'}
        />
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        {guardian.photo_file_id && (
          <Button size="sm" variant="ghost" disabled={save.isPending}
            onClick={() => save.mutate('')}>
            Remove
          </Button>
        )}
      </div>
      {save.error && <FormNotice error={save.error} />}
    </div>
  )
}

/* A count, and a way in.

   Each tile is the filter it describes, so "1 left" is a click away from the
   list of who they are — a number somebody cannot act on is a number they
   have to go and re-derive somewhere else. */
function RollTile({ label, value, note, active, onClick }: {
  label: string
  value: number
  note: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      /* Which one is showing, said by the tile itself. Four numbers and a
         separate dropdown that decides between them leaves the screen with
         two answers to one question. */
      aria-pressed={active}
      className={cn(
        // bg-background without text-foreground: the four figures on these
        // tiles measured 1.07:1 — black on the dark shell, i.e. invisible.
        'rounded-xl border bg-background text-foreground px-4 py-3 text-left transition-colors',
        active ? 'border-primary ring-1 ring-primary/30' : 'hover:border-primary/50',
      )}
    >
      <p className="eyebrow text-muted-foreground">{label}</p>
      <p className="mt-1 text-[26px] font-semibold leading-none tabular-nums">{value}</p>
      <p className="mt-1 text-[12px] text-muted-foreground">{note}</p>
    </button>
  )
}

/* One number, said once.

   Deliberately not a chart. The question these answer — is this child in
   trouble on attendance, does the family owe money — is answered by a number
   and a colour, and anything more is decoration on a page somebody is reading
   with a parent on the phone. */
function QuickTile({ label, value, note, tone, swatch }: {
  label: string
  value: string
  note?: string
  tone: 'success' | 'warning' | 'danger' | 'neutral'
  swatch?: string
}) {
  const ring = {
    success: 'border-success/40', warning: 'border-warning/50',
    danger: 'border-danger/50', neutral: 'border-border',
  }[tone]
  return (
    <div className={cn('min-w-[10rem] flex-1 rounded-xl border bg-background px-4 py-3', ring)}>
      <p className="eyebrow flex items-center gap-1.5 text-muted-foreground">
        {swatch && (
          <span className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: swatch }} />
        )}
        {label}
      </p>
      <p className="mt-0.5 text-[18px] font-semibold tabular-nums">{value}</p>
      {note && <p className="text-[12px] text-muted-foreground">{note}</p>}
    </div>
  )
}

/* One parent, added or corrected.

   A phone number or an email is required and the form says why: every alert
   this product sends goes to guardians, so a parent with neither is a name on
   a record the school cannot act on — and the morning that matters is the
   morning a child is hurt. */
/* Something this school records that we did not think of.

   Sits with the details rather than in a list at the foot of the page,
   because a field is looked for beside the fields it belongs with. Stored as
   "Details/Sibling admission no" in the custom_fields column that has been on
   students since the baseline, so no school needs a migration to record what
   it records. */
function AddDetailField({ studentID, onChanged }: {
  studentID: string
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const save = useMutation({
    mutationFn: () => api.post(`/api/v1/students/${studentID}/custom-fields`, {
      custom_fields: { ['Details/' + name.trim()]: value },
    }),
    onSuccess: () => { setOpen(false); setName(''); setValue(''); onChanged() },
  })
  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Add a field
      </Button>
    )
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-52">
        <FormField label="Field name">
          <Input value={name} onChange={setName} placeholder="Sibling admission no." />
        </FormField>
      </div>
      <div className="min-w-[10rem] flex-1">
        <FormField label="Value">
          <Input value={value} onChange={setValue} />
        </FormField>
      </div>
      <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Add'}
      </Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      <FormNotice error={save.error} />
    </div>
  )
}

function GuardianForm({ guardian, saving, error, onSave, onCancel }: {
  guardian?: Profile['guardians'][number]
  saving: boolean
  error: unknown
  onSave: (v: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({
    full_name: guardian?.full_name ?? '',
    relation: guardian?.relation ?? 'father',
    phone: guardian?.phone ?? '',
    email: guardian?.email ?? '',
    occupation: guardian?.occupation ?? '',
  })
  const [primary, setPrimary] = useState(guardian?.is_primary ?? false)
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })
  const reachable = f.phone.trim() !== '' || f.email.trim() !== ''
  return (
    <>
      <FormNotice error={error} />
      <FormGrid>
        <FormField label="Name" required>
          <Input value={f.full_name} onChange={set('full_name')} />
        </FormField>
        <FormField label="Relation" required>
          <Select value={f.relation} onChange={set('relation')} options={[
            { value: 'father', label: 'Father' },
            { value: 'mother', label: 'Mother' },
            { value: 'guardian', label: 'Guardian' },
            { value: 'other', label: 'Other' },
          ]} />
        </FormField>
        {/* ONE OF THE TWO IS REQUIRED, so both carry the star and the hint
            says which rule applies. A field the server refuses without and the
            form does not mark is a field somebody leaves blank and is told
            about after pressing Save. */}
        <FormField label="Phone" required
          hint="A phone number or an email — every alert the school sends goes to one of them">
          <Input value={f.phone} onChange={set('phone')} />
        </FormField>
        <FormField label="Email" required hint="Or a phone number above">
          <Input value={f.email} onChange={set('email')} />
        </FormField>
        <FormField label="Occupation">
          <Input value={f.occupation} onChange={set('occupation')} />
        </FormField>
      </FormGrid>
      <div className="mt-3">
        <Checkbox
          label="Ring this parent first"
          checked={primary}
          onChange={setPrimary}
        />
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button
          disabled={saving || !f.full_name.trim() || !reachable}
          onClick={() => onSave({ ...f, is_primary: primary })}
        >
          {saving ? 'Saving…' : guardian ? 'Save changes' : 'Add them'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </>
  )
}

/* Writing something down about a child.

   Two decisions, and the second is the one that matters: WHO CAN SEE IT. A
   remark a parent can read and a note kept between staff are different acts,
   and a screen that does not ask makes somebody guess — usually wrongly, and
   usually in the direction that gets quoted back at a meeting.

   An anecdotal note is private by definition and the database enforces it, so
   the toggle disappears rather than sitting there lying about a choice. */
function RemarkForm({ saving, error, onSave, onCancel }: {
  saving: boolean
  error: unknown
  onSave: (v: { kind: string; body: string; private: boolean; observed_on: string }) => void
  onCancel: () => void
}) {
  const [kind, setKind] = useState('academic')
  const [body, setBody] = useState('')
  const [priv, setPriv] = useState(false)
  const [on, setOn] = useState('')
  const forcedPrivate = kind === 'anecdotal'
  return (
    <>
      <FormNotice error={error} />
      <FormGrid>
        <FormField label="What kind" required>
          <Select value={kind} onChange={setKind} options={[
            { value: 'academic', label: 'Academic' },
            { value: 'achievement', label: 'Achievement or appreciation' },
            { value: 'participation', label: 'Participation' },
            { value: 'behaviour', label: 'Behaviour' },
            { value: 'concern', label: 'Concern' },
            { value: 'anecdotal', label: 'Anecdotal note (staff only)' },
          ]} />
        </FormField>
        <FormField label="Observed on" hint="Blank means today">
          <Input type="date" value={on} onChange={setOn} />
        </FormField>
      </FormGrid>
      <FormField label="The remark" required>
        <Textarea value={body} onChange={setBody} rows={3}
          placeholder="What happened, in the words you would use to the parent." />
      </FormField>
      <div className="mt-3">
        {forcedPrivate ? (
          <p className="text-[13px] text-muted-foreground">
            An anecdotal note is never shown to the family.
          </p>
        ) : (
          <Checkbox
            label="Keep this between staff — do not show the family"
            checked={priv}
            onChange={setPriv}
          />
        )}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button
          disabled={saving || !body.trim()}
          onClick={() => onSave({
            kind, body, private: forcedPrivate || priv, observed_on: on,
          })}
        >
          {saving ? 'Saving…' : 'Save the remark'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </>
  )
}

function ExitForm({ saving, error, onSave, onCancel }: {
  saving: boolean
  error: unknown
  onSave: (v: { status: string; exit_date: string; reason: string }) => void
  onCancel: () => void
}) {
  const [status, setStatus] = useState('withdrawn')
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')
  return (
    <>
      <FormNotice error={error} />
      <FormGrid>
        <FormField label="How they left" required>
          {/* Fixed choices, not free text: these feed the roll count, the
              alumni register and the statutory returns, and "left"/"Left"/
              "LEFT" would be three answers to one question. */}
          <Select value={status} onChange={setStatus} options={[
            { value: 'withdrawn', label: 'Withdrawn by the family' },
            { value: 'transferred', label: 'Moved to another school' },
            { value: 'graduated', label: 'Completed the final year' },
            { value: 'alumni', label: 'Former pupil' },
          ]} />
        </FormField>
        <FormField label="Last day" hint="Blank means today">
          <Input type="date" value={date} onChange={setDate} />
        </FormField>
      </FormGrid>
      <FormField label="Reason" hint="Optional, and the thing somebody asks about years later">
        <Textarea value={reason} onChange={setReason} rows={2} />
      </FormField>
      <div className="mt-4 flex items-center gap-2">
        <Button disabled={saving} onClick={() => onSave({ status, exit_date: date, reason })}>
          {saving ? 'Saving…' : 'Record it'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </>
  )
}

function rankRelation(relation: string): number {
  const r = (relation || '').trim().toLowerCase()
  if (r.startsWith('father') || r === 'dad') return 0
  if (r.startsWith('mother') || r === 'mum' || r === 'mom') return 1
  if (r.startsWith('guardian')) return 2
  return 3
}
