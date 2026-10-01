import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, CheckCircle2, ChevronLeft, Paperclip, Plus, Send, Users } from 'lucide-react'
import { api, type List, type Section, type Subject } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader,
  Badge, Button, Dialog, Field, FormGrid, FormNotice, Input, Select, Textarea,
  SkeletonTable, SkeletonTiles, ErrorState, EmptyState, Table, Td,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import FileView, { type ViewableFile } from '@/components/FileView'
import { formatDate, cn } from '@/lib/utils'
import { useToast } from '@/components/Toast'

/* The homework diary, from both ends.

   The same endpoint serves a teacher and a child, and the server decides which
   is which — a teacher sees what they set and how many of the class have
   turned it in, a student sees what they owe and whether they have submitted.
   One screen rather than two, because the difference between them is one
   field, and a second screen would be the same list with a different heading
   drifting slowly out of sync. */

/** A row's identity: the task, and for a family reader the child it is for. */
const rowKey = (h: { id: string; student_id?: string }) => (h.student_id ? `${h.id}:${h.student_id}` : h.id)

interface Homework {
  id: string
  title: string
  kind: string
  subject?: string
  class_name?: string
  section_name?: string
  assigned_on: string
  due_on?: string
  instructions?: string
  overdue: boolean
  submissions: number
  strength: number
  submitted: boolean
  teacher?: string
  /* What the teacher attached, and what this reader turned in. */
  files?: { file_id: string; name: string; content_type?: string; size_bytes?: number }[]
  my_answer?: string
  my_file_id?: string
  /* Whose row this is, for a student or a family reader: the server sends
     one row per child, so siblings' homework is never merged. */
  student_id?: string
  student_name?: string
  my_file_name?: string
}

/* How long is left, in the words somebody would use.

   "03 Sep 2026" makes a reader do the subtraction, and the thing they are
   deciding is whether it is tonight's problem. */
function dueIn(iso: string) {
  const days = Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}

/** Close enough to colour. Inside three days is this week's problem. */
function dueSoon(iso: string) {
  const days = Math.round(
    (new Date(iso + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  )
  return days >= 0 && days <= 3
}


/* THE KINDS OF WORK A TEACHER SETS, one list for the form, the filter and the
   family's diary. The teacher chooses from these and nothing else, so the
   parent's filter always matches what was chosen. */
const WORK_KINDS = [
  { value: 'homework', label: 'Homework' },
  { value: 'classwork', label: 'Classwork' },
  { value: 'assignment', label: 'Assignment' },
  { value: 'project', label: 'Project' },
]
const kindLabel = (k: string) => WORK_KINDS.find((x) => x.value === k)?.label ?? 'Homework'

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (s: string, n: number) => {
  const d = new Date(s + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return iso(d)
}
/** Monday of the week the day falls in. */
const mondayOf = (s: string) => {
  const d = new Date(s + 'T00:00:00')
  return addDays(s, -((d.getDay() + 6) % 7))
}
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/* The month a week belongs to, and both when it straddles two -- which is
   the only week where the day numbers alone are ambiguous. */
function monthSpan(week: string[]): string {
  if (!week.length) return ''
  const name = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  const first = name(week[0])
  const last = name(week[week.length - 1])
  if (first === last) return first
  const short = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long' })
  return `${short(week[0])} – ${last}`
}

export default function Homework() {
  const { data: session, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.call('GET /session'),
  })
  if (isLoading && !session) return <SkeletonTiles count={4} />
  const canPublish = session?.permissions.includes('academics.homework.write') ?? false
  return <Diary canPublish={canPublish} />
}

/* THE FAMILY'S DIARY.

   A parent opens homework to answer "what was given today, and is it done".
   So the page is a week of days across the top, with a dot on every day that
   has work, the kinds of work as filters under it, and the chosen day's work
   as cards. The colours are the school's own theme; the kinds are the ones the
   teacher picked from the list when setting the work. */
function Diary({ canPublish }: { canPublish: boolean }) {
  const qc = useQueryClient()
  const today = iso(new Date())
  /* No day chosen means every piece of work, newest first. The diary opened
     on today alone, and work given on any earlier day vanished from view. */
  const [day, setDay] = useState<string | null>(null)
  const [weekOf, setWeekOf] = useState(mondayOf(today))
  const [kind, setKind] = useState('')
  const [viewing, setViewing] = useState<string | null>(null)
  const [viewFile, setViewFile] = useState<ViewableFile | null>(null)
  const [answer, setAnswer] = useState('')
  const [attached, setAttached] = useState<UploadedFile | null>(null)
  const [composing, setComposing] = useState(false)
  /* Everything set for the teacher's sections by default; their own is one press away. */
  const [onlyMine, setOnlyMine] = useState(false)
  const mine = canPublish && onlyMine

  const from = weekOf
  const week = Array.from({ length: 7 }, (_, i) => addDays(from, i))

  const { data, isLoading, error } = useQuery({
    queryKey: ['homework', 'diary', mine],
    queryFn: () => api.get<List<Homework>>(`/api/v1/homework${mine ? '?mine=1' : ''}`),
  })

  const submit = useMutation({
    mutationFn: (h: Homework) => api.post(`/api/v1/homework/${h.id}/submit`, {
      student_id: h.student_id,
      text_answer: answer.trim() || undefined,
      file_id: attached?.file_id,
    }),
    onSuccess: () => {
      setAnswer('')
      setAttached(null)
      setViewing(null)
      qc.invalidateQueries({ queryKey: ['homework'] })
    },
  })

  const all = data?.items ?? []
  const onDay = day ? all.filter((h) => h.assigned_on.slice(0, 10) === day) : all
  const shown = kind ? onDay.filter((h) => h.kind === kind) : onDay
  const hasWork = new Set(all.map((h) => h.assigned_on.slice(0, 10)))
  const manyChildren = new Set(all.map((h) => h.student_id).filter(Boolean)).size > 1
  const count = (k: string) => onDay.filter((h) => h.kind === k).length
  const dayTitle = day ? new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }) + (day === today ? ' (today)' : '') : 'All work, newest first'

  return (
    <>
      {viewFile && <FileView file={viewFile} onClose={() => setViewFile(null)} />}
      <PageHead
        eyebrow="Homework & diary"
        title={canPublish ? 'Work you have set' : 'School diary'}
        description={canPublish
          ? 'Published straight to the class and their parents. Pick a day to see what was set and who has turned it in.'
          : 'The work set for each day, and whether it has been done.'}
        actions={canPublish && (
          <Button onClick={() => setComposing((c) => !c)}>
            <Plus className="h-3.5 w-3.5" />
            {composing ? 'Close' : 'Set homework'}
          </Button>
        )}
      />
      <PageBody>
        {composing && <Compose canPublish={canPublish} onClose={() => setComposing(false)} />}
        {canPublish && (
          <div className="flex items-center justify-end">
            <span className="flex overflow-hidden rounded-sm border">
              <Button size="sm" variant={mine ? 'primary' : 'ghost'} onClick={() => setOnlyMine(true)} title="Only the work you set yourself">Set by me</Button>
              <Button size="sm" variant={!mine ? 'primary' : 'ghost'} onClick={() => setOnlyMine(false)} title="Everything set for these sections, by any teacher">Set by anyone</Button>
            </span>
          </div>
        )}
        <Card>
          {/* WHICH MONTH THESE DAYS ARE IN.

              The strip showed MON 28, TUE 29, WED 30, THU 1, FRI 2 -- and a
              week that crosses a month boundary is exactly the week where
              bare numbers stop meaning anything. It says the month, and both
              months when the week spans two. */}
          {/* The arrows sit beside the month, not either side of the days:
              on a phone the 44px tap size made arrows plus seven days wider
              than the screen, and Saturday and Sunday spilled off it. */}
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2 text-[13px] font-semibold text-muted-foreground">
            <span>{monthSpan(week)}</span>
            <span className="flex gap-2">
                <button type="button" aria-label="Previous week" onClick={() => setWeekOf(addDays(from, -7))}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40 disabled:shadow-none">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                    <button type="button" aria-label="Next week" onClick={() => setWeekOf(addDays(from, 7))}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40 disabled:shadow-none">
                  <ChevronLeft className="h-4 w-4 rotate-180" />
                </button>
                </span>
          </div>
          {/* The week, one day to press. */}
          <div className="flex items-center px-1.5 py-3">
            {/* SEVEN DAYS, NO SCROLLING.

                This was a horizontal scroller, and on a 390px phone the two
                arrow buttons leave about 300px for seven cells with a 44px
                minimum -- so Friday and Saturday were cut off at the edge,
                behind a scrollbar that is hidden. Arrows to move the week AND
                a hidden sideways scroll inside it is two ways to do one thing,
                and the invisible one wins by accident.

                The cells shrink to fit instead: min-w-0 and flex-1 let all
                seven share whatever is left, which at 390px is about 42px
                each -- enough for "MON" over "28", which is all they carry. */}
            <div className="flex min-w-0 flex-1 justify-between gap-0.5">
              {week.map((d) => {
                const active = d === day
                const dt = new Date(d + 'T00:00:00')
                return (
                  <button key={d} type="button" onClick={() => setDay(active ? null : d)} aria-pressed={active}
                    className={cn(
                      'flex !min-h-0 !min-w-0 flex-1 flex-col items-center rounded-lg border px-0 py-2 transition-colors',
                      /* THE TINT IS THE HIGHLIGHT. A selected day was filled solid
                         and its wording turned white, so the day you are looking at
                         was the one day you could not read at a glance -- reversed
                         out of a saturated block at 10.5px. A tint and a border say
                         'this one' perfectly well and leave the words alone. */
                      active ? 'border-primary bg-primary/10 font-semibold' : 'border-transparent hover:bg-muted',
                    )}>
                    <span className={cn('text-[10.5px] font-semibold uppercase', active ? 'text-primary' : 'text-muted-foreground')}>
                      {WEEKDAY[dt.getDay()]}
                    </span>
                    <span className="mt-0.5 text-[16px] font-bold tabular-nums">{dt.getDate()}</span>
                    <span className={cn('mt-1 h-1.5 w-1.5 rounded-full',
                      hasWork.has(d) ? (active ? 'bg-primary-foreground' : 'bg-primary') : 'bg-transparent')} />
                  </button>
                )
              })}
            </div>
          </div>
          {/* A way out, not a banner announcing itself.

              This was a full-width strip of primary-coloured text along the
              foot of the card, left aligned under a centred week -- it read as
              a warning bar rather than the small convenience it is. Centred,
              quieted, and given the calendar icon so it is recognised before
              it is read. */}
          {day && (
            <div className="flex justify-center border-t px-4 py-2">
              <button
                type="button"
                onClick={() => setDay(null)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <CalendarDays className="h-3.5 w-3.5" />
                Show all days
              </button>
            </div>
          )}
        </Card>

        {/* The kinds of work, as the teacher chose them. */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {[{ value: '', label: 'All' }, ...WORK_KINDS].map((k) => {
            const n = k.value ? count(k.value) : onDay.length
            const active = kind === k.value
            return (
              <button key={k.value || 'all'} type="button" onClick={() => setKind(k.value)} aria-pressed={active}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12.5px] font-semibold transition-colors',
                  active ? 'border-primary bg-primary/10 font-semibold text-primary' : 'bg-card text-muted-foreground hover:text-foreground',
                )}>
                {k.label} ({n})
              </button>
            )
          })}
        </div>

        <p className="text-[14px] font-semibold">
          {dayTitle}
          <span className="ml-2 font-normal text-muted-foreground">
            {shown.length === 0 ? 'nothing set' : `${shown.length} ${shown.length === 1 ? 'task' : 'tasks'}`}
          </span>
        </p>

        {isLoading ? <SkeletonTiles count={3} /> : error ? <ErrorState error={error} /> : shown.length === 0 ? (
          <Card>
            <EmptyState
              title={day ? (kind ? `No ${kindLabel(kind).toLowerCase()} on this day` : 'Nothing set on this day') : (kind ? `No ${kindLabel(kind).toLowerCase()} yet` : 'Nothing set yet')}
              body={canPublish ? 'Press Set homework to give this class some work. Days with work have a dot under the date.' : 'Days with work have a dot under the date.'}
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {shown.map((h) => (
              <article key={rowKey(h)} className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge>{kindLabel(h.kind)}</Badge>
                    {h.subject && <span className="text-[12.5px] font-semibold text-primary">{h.subject}</span>}
                    {manyChildren && h.student_name && (
                      <span className="rounded-md bg-accent px-2 py-0.5 text-[12px] font-semibold">{h.student_name}</span>
                    )}
                  </div>
                  {canPublish ? (
                    <span className={cn('shrink-0 rounded-md bg-muted px-2 py-0.5 text-[12px] font-medium tabular-nums',
                      h.submissions === 0 ? 'text-muted-foreground' : h.submissions >= h.strength ? 'text-success' : 'text-foreground')}>
                      <Users className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />{h.submissions} / {h.strength} turned in
                    </span>
                  ) : h.submitted ? (
                    <Badge tone="success"><CheckCircle2 className="mr-1 h-3 w-3" />Done</Badge>
                  ) : h.due_on ? (
                    <Badge tone={h.overdue ? 'danger' : dueSoon(h.due_on) ? 'warning' : 'neutral'}>
                      {h.overdue ? `Overdue, due ${formatDate(h.due_on)}` : dueIn(h.due_on)}
                    </Badge>
                  ) : null}
                </div>
                <h3 className="mt-2 text-[15px] font-semibold leading-snug">{h.title}</h3>
                {!day && <p className="mt-0.5 text-[12px] text-muted-foreground">Set on {formatDate(h.assigned_on.slice(0, 10))}</p>}
                {h.instructions && <p className="mt-1 text-[13.5px] text-muted-foreground">{h.instructions}</p>}
                {!!h.files?.length && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {h.files.map((f) => (
                      <button key={f.file_id} type="button" onClick={() => setViewFile({ file_id: f.file_id, name: f.name })}
                        className="inline-flex max-w-full items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-[12px] hover:bg-muted">
                        <Paperclip className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{f.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
                  <span className="text-[12px] text-muted-foreground">
                    {canPublish
                      ? [h.class_name && `${h.class_name}${h.section_name ? '-' + h.section_name : ''}`, h.due_on && (h.overdue ? `was due ${formatDate(h.due_on)}` : dueIn(h.due_on))].filter(Boolean).join(' · ')
                      : h.teacher ? `Set by ${h.teacher}` : ''}
                  </span>
                  <div className="flex gap-2">
                    {!canPublish && !h.submitted && (
                      <Button size="sm" variant="secondary" onClick={() => { setAnswer(''); setAttached(null); setViewing(rowKey(h)) }}>
                        <CheckCircle2 className="h-3.5 w-3.5" /> Done
                      </Button>
                    )}
                    <Button size="sm" onClick={() => setViewing(rowKey(h))}>{canPublish ? 'View submissions' : 'Open'}</Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {viewing && (() => {
          const h = all.find((x) => rowKey(x) === viewing)
          if (!h) return null
          return (
            <HomeworkSheet
              h={h}
              onViewFile={setViewFile}
              showRegister={canPublish}
              canSubmit={!canPublish && !h.submitted}
              pending={submit.isPending}
              error={submit.error}
              answer={answer}
              onAnswer={setAnswer}
              attached={attached}
              onAttach={setAttached}
              onSubmit={() => submit.mutate(h)}
              onClose={() => setViewing(null)}
            />
          )
        })()}
      </PageBody>
    </>
  )
}



/**
 * Setting work.
 *
 * The subject is chosen by name; the server resolves it to the class-subject
 * link. A teacher knows they teach Class 6 maths — they do not know, and
 * should not have to look up, the row that joins those two together.
 */
/** One task, nearly full screen.

    Portalled to the body rather than rendered in the list. The list is a
    scrolling box with its own max height, and a panel inside it inherits that
    clip — the very thing this exists to escape.

    Two controls, because there are two things a person wants from here. Back
    returns to the list, which is where they came from and what the browser's
    own back button will NOT do (this opened no route). Done hands the work in,
    so a child who has just read the instructions does not have to find the row
    again to act on them.
*/
function HomeworkSheet({
  onViewFile,
  showRegister,
  h, canSubmit, pending, error, answer, onAnswer, attached, onAttach, onSubmit, onClose,
}: {
  h: Homework
  canSubmit: boolean
  pending: boolean
  error: unknown
  answer: string
  onAnswer: (v: string) => void
  attached: UploadedFile | null
  onAttach: (f: UploadedFile | null) => void
  onSubmit: () => void
  onClose: () => void
  /* Set only where somebody may read the attachment in place. The sheet is
     shown to families too, and their copy uses the same handler. */
  onViewFile?: (f: ViewableFile) => void
  /* The class's register, for whoever set the work. A teacher opening a piece
     of homework is asking who has done it — the sheet showed the question and
     a wall of white below it. */
  showRegister?: boolean
}) {
  /* The shared Dialog: Back on a phone, Escape, the dim and the focus trap
     all close it the one way. Focus lands on the task, not the answer box,
     so a child reading the question is not handed a keyboard first. */
  return (
    <Dialog
      onClose={onClose}
      size="xl"
      label={h.title}
      footer={
        <>
          <Button size="sm" variant="secondary" className="mr-auto" onClick={onClose}>
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          {h.submitted ? (
            <Badge tone="success">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Done
            </Badge>
          ) : canSubmit ? (
            /* Enabled only when there is something to send. Done used to close
               the sheet and open the answer box back in the list behind it,
               which is why there was no way to type or attach anything from
               here: the form was on the screen this one covers. */
            <Button
              size="sm"
              disabled={pending || (!answer.trim() && !attached)}
              onClick={onSubmit}
            >
              <Send className="h-3.5 w-3.5" />
              {pending ? 'Sending…' : 'Done'}
            </Button>
          ) : null}
        </>
      }
    >
        <div data-autofocus tabIndex={-1} className="outline-none">
          <p className="text-[18px] font-medium leading-snug">{h.title}</p>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13.5px] text-muted-foreground">
            {h.student_name && <span className="font-medium text-foreground">For {h.student_name}</span>}
            {h.subject && <span>{h.subject}</span>}
            {h.class_name && (
              <span>
                {h.class_name}
                {h.section_name && `-${h.section_name}`}
              </span>
            )}
            <span>set {formatDate(h.assigned_on)}</span>
            <span className={h.overdue ? 'text-destructive' : undefined}>
              {h.due_on ? `${h.overdue ? 'was due' : 'due'} ${formatDate(h.due_on)}` : 'no due date'}
            </span>
            {h.teacher && <span>set by {h.teacher}</span>}
          </p>

          {h.instructions ? (
            <p className="mt-5 whitespace-pre-wrap text-[15px] leading-relaxed">{h.instructions}</p>
          ) : (
            <p className="mt-5 text-[14px] text-muted-foreground">
              No further instructions were given.
            </p>
          )}

          {!!h.files?.length && (
            <div className="mt-6">
              <p className="mb-2 text-[13px] text-muted-foreground">Worksheets</p>
              <div className="flex flex-wrap gap-2">
                {h.files.map((f) => (
                  <button
                    key={f.file_id}
                    type="button"
                    onClick={() => onViewFile?.({ file_id: f.file_id, name: f.name })}
                    className="inline-flex items-center gap-1.5 rounded-[3px] border px-3 py-2 text-[14px] text-primary hover:bg-accent"
                  >
                    <Paperclip className="h-4 w-4" />
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Who has done it, on the sheet itself.

              A teacher opening a piece of homework is asking exactly one
              question — who has turned it in — and the sheet answered it with
              a screen of white space and a button somewhere else. */}
          {showRegister && (
            <div className="mt-6">
              <Register homeworkId={h.id} />
            </div>
          )}

          {/* ANSWERING IT, HERE.

              The sheet showed the task and offered Done, and the box to write
              in was on the list underneath. So a child read the question,
              pressed Done, and the sheet vanished — which is not what Done
              means anywhere else.

              Same two ways to answer as the list: type it, or photograph the
              page. Either alone is enough; an empty submission tells a teacher
              nothing, which is why the button stays disabled until there is
              one. */}
          {canSubmit && (
            <div className="mt-6 border-t pt-5">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Your answer</span>
                <Textarea
                  value={answer}
                  onChange={onAnswer}
                  rows={5}
                  placeholder="Type your answer, or attach a photo of the page below."
                />
              </label>
              <div className="mt-3 max-w-sm">
                <FilePicker
                  value={attached}
                  onChange={onAttach}
                  purpose="homework_submission"
                  label="Attach your work"
                  hint="A photo of the page is fine."
                />
              </div>
              <FormNotice error={error} />
            </div>
          )}

          {h.submitted && (h.my_answer || h.my_file_id) && (
            <div className="mt-6 border-t pt-4">
              <p className="text-[13px] text-muted-foreground">What you sent</p>
              {h.my_answer && <p className="mt-1 whitespace-pre-wrap text-[15px]">{h.my_answer}</p>}
              {h.my_file_id && (
                <a
                  href={`/api/v1/files/${h.my_file_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-[14px] text-primary"
                >
                  <Paperclip className="h-4 w-4" />
                  {h.my_file_name ?? 'your file'}
                </a>
              )}
            </div>
          )}
        </div>
    </Dialog>
  )
}

function Compose({ canPublish, onClose }: { canPublish: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  // The section and subject lists are staff-only. Gating them on canPublish is
  // redundant with the composer only opening for a teacher, and worth stating
  // anyway: it records at the point of use which data a family may not read,
  // and keeps a future refactor from quietly issuing a 403 on a child's screen.
  const { data: sections } = useQuery({
    queryKey: ['sections', 'mine'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections?mine=true'),
    enabled: canPublish,
  })
  const { data: subjects } = useQuery({
    queryKey: ['subjects','mine'],
    /* What this person can actually set, not the whole prospectus. A Maths
       teacher offered Sanskrit is offered a filter that only ever returns
       nothing; a class teacher still gets every subject their section takes,
       because they answer for the whole diary. */
    queryFn: () => api.get<List<Subject>>('/api/v1/academics/subjects?mine=true'),
    enabled: canPublish,
  })
  const [f, setF] = useState({
    section_id: '',
    subject_id: '',
    title: '',
    instructions: '',
    due_on: tomorrow(),
    kind: 'homework',
  })
  /* The worksheet. Uploaded first, linked on publish — the file store checks
     the size and refuses a program before this screen ever sees an id. */
  const [sheet, setSheet] = useState<UploadedFile | null>(null)

  const toast = useToast()

  const publish = useMutation({
    mutationFn: () => api.post('/api/v1/homework', {
      ...f,
      file_ids: sheet ? [sheet.file_id] : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['homework'] })
      toast.ok('Homework published to the class and their parents')
      onClose()
    },
  })

  return (
    <Card>
      <CardHeader
        title="Set homework"
        description="Visible to the class and their parents the moment it is published."
      />
      <form
        className="px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          publish.mutate()
        }}
      >
        <FormGrid>
          <Field label="Type of work" required hint="Parents filter the diary by this.">
            <Select
              value={f.kind}
              onChange={(x) => setF({ ...f, kind: x })}
              options={WORK_KINDS}
            />
          </Field>
          <Field label="Section" required>
            <Select
              value={f.section_id}
              onChange={(x) => setF({ ...f, section_id: x })}
              placeholder="Choose a section you teach"
              options={(sections?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.class_name}-${s.name}`,
              }))}
            />
          </Field>
          <Field label="Subject" required>
            <Select
              value={f.subject_id}
              onChange={(x) => setF({ ...f, subject_id: x })}
              placeholder="Choose a subject"
              options={(subjects?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
          <Field label="Name of the work" required wide>
            <Input
              value={f.title}
              onChange={(x) => setF({ ...f, title: x })}
              placeholder="Exercise 4.2, sums 1 to 8"
            />
          </Field>
          <Field label="Instructions" wide hint="Anything the parent should know when they check the diary.">
            <Input
              value={f.instructions}
              onChange={(x) => setF({ ...f, instructions: x })}
              placeholder="Show every step. Bring the graph sheet."
            />
          </Field>
          <Field label="Due on">
            <Input type="date" value={f.due_on} onChange={(x) => setF({ ...f, due_on: x })} />
          </Field>
          <Field
            label="Worksheet"
            hint="The sheet, the reading, a photo of the board. Optional."
            wide
          >
            <FilePicker
              value={sheet}
              onChange={setSheet}
              purpose="homework_attachment"
              label="Attach the sheet"
            />
          </Field>
        </FormGrid>
        <FormNotice error={publish.error} />
        <div className="mt-4 flex items-center gap-2">
          <Button type="submit" disabled={publish.isPending || !f.section_id || !f.title.trim()}>
            {publish.isPending ? 'Publishing…' : 'Publish to the class'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}

function tomorrow() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Who did it, and who did not.
 *
 * Built from the enrolment register rather than from the submissions, because
 * the children being looked for are precisely the ones with no submission row
 * — a query over submissions cannot return a child who never made one.
 *
 * Roll order, because that is the order the teacher's own mark list is in.
 */
function Register({ homeworkId }: { homeworkId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['homework-submissions', homeworkId],
    queryFn: () =>
      api.get<List<Submitter>>(`/api/v1/homework/${homeworkId}/submissions`),
  })

  if (isLoading) return <div className="pt-3"><SkeletonTable columns={5} /></div>
  if (error) return <div className="pt-3"><ErrorState error={error} /></div>

  const rows = data?.items ?? []
  const done = rows.filter((x) => x.status !== 'pending')

  return (
    <div className="mt-3 rounded-md border bg-muted/30">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5">
        <span className="text-[13px] font-medium">Submission register</span>
        <span className="text-[13px] text-muted-foreground">
          {done.length} of {rows.length} turned in
          {rows.length - done.length > 0 && ` · ${rows.length - done.length} still owing`}
        </span>
      </div>
      <Table wide head={['Roll', 'Name', 'Status', 'What they turned in', 'When']}>
        {rows.map((x) => (
          <tr key={x.student_id} className="border-t">
            <Td className="tabular-nums">{x.roll_no ?? '-'}</Td>
            <Td>{x.full_name}</Td>
            <Td>
              {x.status === 'pending' ? (
                <Badge tone="warning">Not turned in</Badge>
              ) : (
                <Badge tone="success">{x.status}</Badge>
              )}
            </Td>
            <Td>
              {/* The work itself, beside the tick.

                  A register that says only who pressed the button is a
                  register of button presses; the teacher opened it to mark
                  something. */}
              {x.text_answer && (
                <span className="block max-w-md whitespace-pre-wrap">{x.text_answer}</span>
              )}
              {/* Whose hands it came from, where that is not the child's.

                  A parent may hand work in now, and a teacher marking it is
                  entitled to know which of the thirty came that way — that is
                  the whole of what the old rule was protecting. */}
              {x.submitted_by && (
                <span className="mt-0.5 block text-[12px] text-muted-foreground">
                  handed in by {x.submitted_by}
                </span>
              )}
              {x.file_id && (
                <a
                  href={`/api/v1/files/${x.file_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {x.file_name ?? 'their file'}
                </a>
              )}
              {!x.text_answer && !x.file_id && (
                <span className="text-muted-foreground">&mdash;</span>
              )}
            </Td>
            <Td className="text-muted-foreground">
              {x.submitted_at ? formatDate(x.submitted_at.slice(0, 10)) : '-'}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  )
}

interface Submitter {
  file_id?: string
  file_name?: string
  /* Present only where a guardian handed it in. Absent means the child. */
  submitted_by?: string
  student_id: string
  roll_no?: string
  full_name: string
  status: string
  submitted_at?: string
  text_answer?: string
}
