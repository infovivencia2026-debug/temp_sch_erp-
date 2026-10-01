import { useRef, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Users, Wallet, Plus, Trash2, Download, Settings, Bell, Palette, BookOpen } from 'lucide-react'
import {
  PageHead, PageBody, Card, CardHeader, Panel, CellGrid, Stat, Table, Td, Badge, Button,
  ConfirmButton, Checkbox, Select, Input, Textarea, Field, FormGrid, FormNotice, ErrorState,
  EmptyState, UnavailableState, Loading, PrintButton, RangePicker, Reload, TAB_BAR, tabClass,
  SEG_BAR, segClass, Dialog, ExportTable, type ActiveRange,
} from '@/components/ui'
import { SkeletonCards, SkeletonRows, SkeletonText } from '@/components/Skeleton'
import { SlidingIndicator } from '@/components/SlidingIndicator'
import StudentAvatar from '@/components/StudentAvatar'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { Ring as StudentRing, Bar, DueChip, DoneCheck, Segmented, Tile } from '@/features/portal/student-kit'
import { ProgressRing } from '@/features/learning/lms-shared'
import { Meter } from '@/features/bento/bento-kit'
import { Ring as BentoRing } from '@/features/bento/bento-viz'
import { SkeletonTable, SkeletonTiles, SkeletonForm } from '@/components/Skeleton'
import { StatusPill } from '@/components/NeedsAttention'
import { PickerMenu } from '@/components/PickerMenu'
import { SearchBox, Showing } from '@/components/rows'
import { TriLoader } from '@/components/Loader'
import { useToast } from '@/components/Toast'
import { useSession } from '@/lib/session'
import { Menu } from '@/features/bento/Menu'
import { CardShell } from '@/features/bento/bento-cards'
import { Rows, Row, NavRow, SwitchRow, SegmentRow, SliderRow, DropdownRow } from '@/features/bento/SettingsRows'

/* EVERY SHARED ELEMENT, ON ONE PAGE.

   A reference sheet for the design pass, not a feature: it renders the
   shared components from ui.tsx, components/ and features/bento in each of
   their variants and states, grouped by type, so a change to one of them can
   be judged against all the others at once. Reached only by typing the URL:
   platform admins see it, and anyone signed in can add ?elements=1. It is in
   no navigation, catalogue or menu. Nothing on it writes anything. */

const TE = 'విద్యార్థుల హాజరు నమోదు'
const LONG = 'Annual day rehearsal for the senior secondary classes in the main auditorium, with parents invited'

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} data-section={id} className="space-y-3">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

const OPTS = [
  { value: 'a', label: 'Class 6-A' },
  { value: 'b', label: 'Class 7-B' },
  { value: 't', label: TE },
  { value: 'l', label: LONG },
]
const RANGES = [
  { value: 'this_month', label: 'This month', group: 'Month' },
  { value: 'last_month', label: 'Last month', group: 'Month' },
  { value: 'this_year', label: 'This year', group: 'Year' },
]

export default function ElementsGallery() {
  const session = useSession()
  const loc = useLocation()
  const allowed = session.user?.platform_admin === true ||
    new URLSearchParams(loc.search).get('elements') === '1'
  if (!session.user || !allowed) return <Navigate to="/" replace />
  return <Gallery />
}

function Gallery() {
  const toast = useToast()
  const [text, setText] = useState('')
  const [sel, setSel] = useState('a')
  const [area, setArea] = useState('')
  const [chk, setChk] = useState(true)
  const [tab, setTab] = useState(0)
  const [seg, setSeg] = useState(0)
  const [pick, setPick] = useState<'day' | 'week' | 'month'>('week')
  const [range, setRange] = useState<ActiveRange>({ period: 'this_month' })
  const [q, setQ] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtn = useRef<HTMLSpanElement>(null)
  const [sw, setSw] = useState(true)
  const [seg2, setSeg2] = useState<'on' | 'off'>('on')
  const [slide, setSlide] = useState(1)
  const [dd, setDd] = useState<'subtle' | 'off' | 'strong'>('subtle')
  const [dlg, setDlg] = useState<'' | 'sm' | 'lg'>('')
  const [chk2, setChk2] = useState(false)
  const [file, setFile] = useState<UploadedFile | null>(null)
  const [picked, setPicked] = useState(false)
  const [stu, setStu] = useState<'today' | 'week'>('today')
  const segList = useRef<HTMLDivElement>(null)

  return (
    <>
      <PageHead eyebrow="Design" title="Elements" actions={<><PrintButton /><Button>Primary action</Button></>} />
      <PageBody>
        <Section id="buttons" title="Buttons">
          <Card className="space-y-5 p-[var(--card-pad)]">
            {(['primary', 'secondary', 'ghost', 'ink', 'outline'] as const).map((v) => (
              <Specimen key={v} label={`${v}: md, sm, hover, focus, disabled, loading, danger, icon`}>
                <Button variant={v}>Save changes</Button>
                <Button variant={v} size="sm">Save</Button>
                <span data-force="hover"><Button variant={v}>Hover</Button></span>
                <span data-force="focus-visible"><Button variant={v}>Focus</Button></span>
                <Button variant={v} disabled>Disabled</Button>
                <Button variant={v} pending>Saving</Button>
                <Button variant={v} tone="danger"><Trash2 className="h-4 w-4" />Delete</Button>
                <Button variant={v} title="Add"><Plus className="h-4 w-4" /></Button>
              </Specimen>
            ))}
            <Specimen label="Long and Telugu labels">
              <Button variant="secondary">{TE}</Button>
              <Button variant="primary">Send the fee reminder to every parent</Button>
            </Specimen>
            <Specimen label="ConfirmButton, PrintButton, Reload, export-like">
              <ConfirmButton question="Remove this row?" confirmLabel="Remove" onConfirm={() => {}}>Remove</ConfirmButton>
              <PrintButton />
              <Reload onClick={() => {}} />
              <Reload onClick={() => {}} busy />
              <Button variant="secondary" size="sm"><Download className="h-3.5 w-3.5" />Export</Button>
            </Specimen>
          </Card>
        </Section>

        <Section id="inputs" title="Inputs and a row of controls">
          <Card>
            <FormGrid>
              <Field label="Text input" hint="A hint under the field">
                <Input value={text} onChange={setText} placeholder="Type a name" />
              </Field>
              <Field label="Focused" required>
                <span data-force="focus" className="block"><Input value="Focused box" onChange={() => {}} /></span>
              </Field>
              <Field label="Disabled">
                <input className="field" disabled value="Cannot change this" readOnly />
              </Field>
              <Field label="With an error">
                <input className="field" aria-invalid="true" value="not-an-email" readOnly />
              </Field>
              <Field label="Password">
                <Input type="password" value="secret123" onChange={() => {}} />
              </Field>
              <Field label="Date">
                <Input type="date" value="2026-09-28" onChange={() => {}} />
              </Field>
              <Field label="Combobox (Select)">
                <Select value={sel} onChange={setSel} options={OPTS} />
              </Field>
              <Field label="Telugu value">
                <Input value={TE} onChange={() => {}} />
              </Field>
              <Field label="Textarea" wide>
                <Textarea value={area} onChange={setArea} placeholder="Write a note for the class teacher" />
              </Field>
              <Field label="Checkbox" wide>
                <Checkbox checked={chk} onChange={setChk} label="Send an SMS as well" hint="Costs one credit per parent" />
                <Checkbox checked={chk2} onChange={setChk2} label={TE} />
              </Field>
            </FormGrid>
          </Card>
          <Card className="p-[var(--card-pad)]">
            <Specimen label="A toolbar row: everything should share one height and baseline">
              <SearchBox value={q} onChange={setQ} placeholder="Search students" />
              <div className="w-48"><Select value={sel} onChange={setSel} options={OPTS} /></div>
              <div className="w-40"><Input value="" onChange={() => {}} placeholder="Roll no." /></div>
              <PickerMenu value={pick} onChange={setPick} ariaLabel="Period"
                options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
              <Button>Apply</Button>
              <Button variant="secondary">Reset</Button>
            </Specimen>
            <div className="mt-4">
              <Specimen label="RangePicker">
                <RangePicker value={range} onChange={setRange} options={RANGES} label="September 2026" />
              </Specimen>
            </div>
          </Card>
        </Section>

        <Section id="notices" title="Form notices and toasts">
          <Card className="space-y-3 p-[var(--card-pad)]">
            <FormNotice ok="Saved: fee plan for Class 6." />
            <FormNotice error={new Error('Could not save: the admission number is already used.')} />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => toast.ok('Saved the attendance for 6-A')}>Show ok toast</Button>
              <Button variant="secondary" size="sm" onClick={() => toast.error('Could not reach the server')}>Show error toast</Button>
            </div>
          </Card>
        </Section>

        <Section id="badges" title="Badges and status pills">
          <Card className="space-y-4 p-[var(--card-pad)]">
            <Specimen label="Badge tones">
              {(['neutral', 'primary', 'success', 'warning', 'danger', 'info'] as const).map((t) => (
                <Badge key={t} tone={t}>{t}</Badge>
              ))}
              <Badge tone="info">{TE}</Badge>
            </Specimen>
            <Specimen label="StatusPill">
              {['Paid', 'Pending', 'Overdue', 'Draft', 'Present', 'Absent', 'Under review', 'Something new'].map((s) => (
                <StatusPill key={s} status={s} />
              ))}
            </Specimen>
          </Card>
        </Section>

        <Section id="tabs" title="Tabs and segments">
          <Card className="space-y-4 p-[var(--card-pad)]">
            <div className={TAB_BAR} role="tablist">
              {['Overview', 'Fees', TE, 'Disabled'].map((t, i) => (
                <button key={t} role="tab" aria-selected={tab === i} disabled={i === 3}
                  className={tabClass(tab === i)} onClick={() => setTab(i)}>{t}</button>
              ))}
            </div>
            <Specimen label="SEG_BAR + segClass, with the SlidingIndicator">
              <div ref={segList} className={`${SEG_BAR} relative`} role="tablist">
                <SlidingIndicator listRef={segList} active={seg} />
                {['Day', 'Week', 'Month', TE].map((t, i) => (
                  <button key={t} role="tab" aria-selected={seg === i} className={segClass(seg === i)} onClick={() => setSeg(i)}>{t}</button>
                ))}
              </div>
            </Specimen>
            <Specimen label="Student portal Segmented">
              <Segmented value={stu} onChange={setStu} label="Range"
                options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }]} />
            </Specimen>
          </Card>
        </Section>

        <Section id="cards" title="Cards, panels and stats">
          <CellGrid cols={4}>
            <Stat label="Students" value="1,248" icon={Users} delta={{ value: '+12 this month', positive: true }} />
            <Stat label="Collected" value="Rs 8,40,000" icon={Wallet} delta={{ value: '-4% on last month', positive: false }} />
            <Stat label="Clickable" value="37" onClick={() => {}} />
            <Stat label={TE} value="92%" hint="of the roll" />
          </CellGrid>
          <Card>
            <CardHeader title="Card with a header and actions" action={<><Button size="sm" variant="secondary">Filter</Button><Button size="sm">Add</Button></>} />
            <p>Card body text sits at the card padding. {LONG}.</p>
          </Card>
          <Panel className="p-[var(--card-pad)]"><p className="text-[14px]">A Panel, the quieter surface.</p></Panel>
          <div className="grid gap-4 sm:grid-cols-3">
            <CardShell title="Fees collected" value="Rs 8.4L" delta="+6%" deltaNote="vs last month" action={{ label: 'Open fees' }} />
            <CardShell title="Attendance" value="94%" change="1,172 of 1,248 present" />
            <CardShell title={TE} value="12" />
          </div>
        </Section>

        <Section id="tables" title="Tables">
          <Card>
            <CardHeader title="Table with rows" action={<Showing shown={3} total={3} />} />
            <div id="gallery-table">
            <Table head={['Name', 'Class', 'Status', { label: 'Due', align: 'right' }, '']}>
              {[
                ['Aarav Sharma', '6-A', 'Paid', 'Rs 0'],
                ['శ్రీనివాస్ రెడ్డి', '7-B', 'Pending', 'Rs 4,500'],
                [LONG, '10-C', 'Overdue', 'Rs 12,000'],
              ].map((r) => (
                <tr key={r[0]}>
                  <Td className="font-medium">{r[0]}</Td>
                  <Td>{r[1]}</Td>
                  <Td><StatusPill status={r[2]} /></Td>
                  <Td className="text-right tabular-nums">{r[3]}</Td>
                  <Td className="text-right"><Button size="sm" variant="ghost">Open</Button></Td>
                </tr>
              ))}
            </Table>
            </div>
          </Card>
          <Card>
            <CardHeader title="Empty table" />
            <Table head={['Name', 'Class', 'Status']} empty emptyLabel="No students match that search.">{null}</Table>
          </Card>
        </Section>

        <Section id="states" title="Empty, error and loading">
          <EmptyState title="No homework set this week" body="When a teacher sets homework it shows here." action={<Button>Set homework</Button>} />
          <ErrorState error={new Error('Could not load the fee ledger. Check the connection and try again.')} />
          <UnavailableState title="This screen is not switched on" body="Ask the school administrator to turn on Transport." />
          <Card className="p-[var(--card-pad)]"><Loading label="Loading the roll…" delay={0} shape="inline" /></Card>
          <div className="flex items-center gap-3"><TriLoader size={20} /><span className="text-[13px] text-muted-foreground">TriLoader</span></div>
          <SkeletonTiles count={4} delay={0} />
          <SkeletonTable rows={3} cols={4} delay={0} />
          <SkeletonForm fields={4} delay={0} />
        </Section>

        <Section id="menus" title="Menus and settings rows">
          <Card className="p-[var(--card-pad)]">
            <Specimen label="Bento Menu (anchored)">
              <span ref={menuBtn}><Button variant="secondary" onClick={() => setMenuOpen((o) => !o)} ariaHasPopup="menu" ariaExpanded={menuOpen}>Open menu</Button></span>
              <Menu open={menuOpen} anchor={menuBtn.current} label="Sample menu" onClose={() => setMenuOpen(false)}>
                <button role="menuitem" className="bento-menu__item" onClick={() => setMenuOpen(false)}><Settings className="h-4 w-4" />Settings</button>
                <button role="menuitem" className="bento-menu__item" onClick={() => setMenuOpen(false)}><Bell className="h-4 w-4" />Notifications</button>
                <button role="menuitem" className="bento-menu__item" onClick={() => setMenuOpen(false)}><Palette className="h-4 w-4" />{TE}</button>
              </Menu>
            </Specimen>
          </Card>
          <Card className="overflow-hidden">
            <Rows>
              <Row label="Plain row" value="Value" helper="Helper text sits under the label" />
              <NavRow label="Navigation row" helper="Opens a page" icon={<Settings className="h-4 w-4" />} onClick={() => {}} />
              <NavRow label="Current row" current onClick={() => {}} />
              <SwitchRow label="Switch" on={sw} onToggle={() => setSw((v) => !v)} helper={TE} />
              <SegmentRow label="Segment" value={seg2} options={['on', 'off'] as const} name={(v) => v === 'on' ? 'On' : 'Off'} onPick={setSeg2} />
              <DropdownRow label="Glow" value={dd} options={['off', 'subtle', 'strong'] as const} name={(v) => v[0].toUpperCase() + v.slice(1)} onPick={setDd} />
              <SliderRow label="Text size" value={slide} min={0.85} max={1.3} step={0.05} onChange={setSlide} />
            </Rows>
          </Card>
        </Section>


        <Section id="dialogs" title="Dialog (live) and sheets">
          <Card className="p-[var(--card-pad)]">
            <Specimen label="ui.tsx Dialog: centred on a desk, a bottom sheet on a phone; Escape, the dim and Back close it">
              <Button variant="secondary" onClick={() => setDlg('sm')} ariaHasPopup="dialog">Small dialog</Button>
              <Button variant="secondary" onClick={() => setDlg('lg')} ariaHasPopup="dialog">Large dialog with a form</Button>
            </Specimen>
          </Card>
          <Dialog open={dlg === 'sm'} onClose={() => setDlg('')} size="sm" title="Remove this fee head?"
            description="Nothing already collected changes."
            footer={<><Button variant="secondary" onClick={() => setDlg('')}>Cancel</Button><Button tone="danger" onClick={() => setDlg('')}>Remove</Button></>}>
            <p className="text-[14px] text-muted-foreground">{LONG}.</p>
          </Dialog>
          <Dialog open={dlg === 'lg'} onClose={() => setDlg('')} size="lg" title={TE} description="A long form scrolls inside; the footer stays put."
            footer={<><Button variant="secondary" onClick={() => setDlg('')}>Cancel</Button><Button onClick={() => setDlg('')}>Save</Button></>}>
            <FormGrid>
              {['Name', 'Class', 'Roll no.', 'Guardian', 'Phone', 'Address', 'House', 'Bus stop'].map((f) => (
                <Field key={f} label={f}><Input value="" onChange={() => {}} placeholder={f} /></Field>
              ))}
            </FormGrid>
          </Dialog>
        </Section>

        <Section id="avatars" title="Avatars and photos">
          <Card className="p-[var(--card-pad)]">
            <Specimen label="StudentAvatar: 24, 32, 44, 64; selectable; Telugu initials">
              <StudentAvatar name="Aarav Sharma" size={24} />
              <StudentAvatar name="Aarav Sharma" size={32} />
              <StudentAvatar name="శ్రీనివాస్ రెడ్డి" size={44} />
              <StudentAvatar name="Meera Iyer" size={64} />
              <StudentAvatar name="Kiran Rao" size={44} selected={picked} onSelect={() => setPicked((v) => !v)} />
            </Specimen>
          </Card>
        </Section>

        <Section id="progress" title="Progress: rings, bars, meters">
          <Card className="p-[var(--card-pad)] space-y-4">
            <Specimen label="Student Ring (120 / 64), lms ProgressRing, bento Ring">
              <StudentRing pct={72} label="Attendance">72%</StudentRing>
              <StudentRing pct={35} size={64} stroke={7} hue="rose" label="Homework">35%</StudentRing>
              <ProgressRing pct={60} label="Course" />
              <div className="w-24"><BentoRing value={18} total={24} srLabel="Classes marked" /></div>
            </Specimen>
            <Specimen label="Student Bar and bento Meter (all tones)">
              <div className="w-56 space-y-2"><Bar pct={64} /><Bar pct={20} hue="amber" /></div>
              <div className="w-56 space-y-2">
                {(['primary', 'success', 'warning', 'destructive'] as const).map((t, i) => (
                  <Meter key={t} value={(i + 1) * 22} total={100} tone={t} srLabel={t} />
                ))}
              </div>
            </Specimen>
            <Specimen label="DueChip, DoneCheck, Tile">
              <DueChip due={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} />
              <DueChip due={new Date(Date.now() - 86400000).toISOString().slice(0, 10)} />
              <DueChip due={new Date().toISOString().slice(0, 10)} done />
              <DoneCheck done={false} /><DoneCheck done />
              <div className="w-40"><Tile icon={BookOpen} hue="indigo" value="12" label="Homework due" /></div>
            </Specimen>
          </Card>
        </Section>

        <Section id="files" title="File picker and export">
          <Card className="p-[var(--card-pad)] space-y-4">
            <FilePicker value={file} onChange={setFile} hint="PDF or a photo, up to 20 MB" />
            <Specimen label="ExportTable (CSV of the table above, by id)">
              <ExportTable tableId="gallery-table" name="gallery" />
            </Specimen>
          </Card>
        </Section>

        <Section id="skeletons" title="More loading shapes">
          <Card className="p-[var(--card-pad)] space-y-4">
            <SkeletonText delay={0} />
            <SkeletonRows rows={3} cols={3} />
          </Card>
          <SkeletonCards n={3} delay={0} />
          {(['table', 'cards', 'form'] as const).map((sh) => (
            <Card key={sh} className="p-[var(--card-pad)]"><Loading shape={sh} delay={0} label={`Loading (${sh})`} rows={2} cols={3} /></Card>
          ))}
        </Section>

        <Section id="dialog" title="Dialog panel (static drawing)">
          <div className="mx-auto w-full max-w-[26rem] rounded-xl border bg-card shadow-[var(--elev-3)]">
            <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
              <p className="text-[16px] font-semibold">Dialog title</p>
            </div>
            <p className="px-5 py-4 text-[14px] text-muted-foreground">The house shape for a small dialog: a header row, a body, and the actions on the right of the footer.</p>
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button variant="secondary">Cancel</Button><Button>Confirm</Button>
            </div>
          </div>
        </Section>
      </PageBody>
    </>
  )
}
