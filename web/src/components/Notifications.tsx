import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayHistory } from '@/lib/overlay-history'
import { useFeatureHref, useFeatureHrefAny } from '@/features/bento/bento-kit'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Award, Bell, UserPlus, BookOpen, Bus, CalendarCheck, CalendarClock, Camera, Image as ImageIcon, IndianRupee, Megaphone, MessageSquare, Play, Type, X, Images, ChevronRight, Video } from 'lucide-react'
import StatusRings from '@/features/comms/status/StatusRings'
import SchoolGallery from '@/features/comms/status/SchoolGallery'
import StatusComposer from '@/features/comms/status/StatusComposer'
import type { AddMode } from '@/features/comms/status/status-api'
import { useStatusFeed } from '@/features/comms/status/status-api'
import type { StatusItem } from '@shared/api/feature_class_status'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import NotificationRow, { channelOf } from '@/components/NotificationRow'
import { useOptimisticMutation } from '@/lib/optimistic'
import { useOpenState } from '@/lib/motion'
import { useActiveRole } from '@/lib/catalog'
import { Button, Dialog, GlassIconButton } from '@/components/ui'
import { dropFromFeed, noteShown, pendingFirst, statusPostIdOf } from '@/lib/notification-shown'
import { noteDestination, type NoteHrefs } from '@/lib/notification-link'

/* The bell in the header, and the panel it opens.

   Notices used to be a menu entry of their own, which meant a family had to
   go looking for something the school had already decided was urgent. The
   feed itself is not new — /api/v1/portal/notifications runs its delivery
   pass on read, so a screen opened after a fortnight away is not empty.

   The button hides itself for anyone the endpoint refuses. Staff have no
   family feed, and a bell that opens on "you are not allowed to see this" is
   worse than no bell.

   WHY A DRAWER AND NOT A DROPDOWN. It was a 22rem menu hanging off the bell,
   capped at 60vh, which is enough to show that there are notifications and not
   enough to read them: a two-line body was clipped to one, the day was a
   YYYY-MM-DD stamp because nothing longer fitted, and there was no room to say
   what KIND of thing had happened. A notification is a message from the
   school, and this is the only place most families will ever read one. It gets
   the side of the screen.

   Anchored to the window rather than to the bell, so it is the same panel at
   every width and does not have to be measured away from the right edge. */

export interface Note {
  id: string
  kind: string
  title: string
  body?: string
  link?: string
  student_name?: string
  created_at: string
  read_at?: string
  /** Work owed (server-computed): stays until done, shown "Pending". */
  pending?: boolean
}

/* What sort of thing happened, at a glance.

   With one line per row there was no space for this and the title had to carry
   it — "Fee due: term 2" rather than "Term 2". A mark down the left lets the
   eye sort a fortnight's feed into fees, homework and notices without reading
   a word, which is what somebody catching up actually does first. */
/* The school gallery under each staff workspace that has it. */
const GALLERY_KEYS = ['activity_coord', 'admissions', 'board_member', 'counsellor', 'discipline_officer', 'driver', 'exam_controller', 'faculty', 'finance', 'front_office', 'hod', 'hostel_warden', 'hr', 'institution_admin', 'it_admin', 'librarian', 'lms_admin', 'nurse', 'operations', 'transport_manager'].map((r) => `${r}.school_gallery.school_gallery`)

const KINDS: Record<string, { icon: typeof Bell; label: string }> = {
  fee: { icon: IndianRupee, label: 'Fees' },
  fees: { icon: IndianRupee, label: 'Fees' },
  homework: { icon: BookOpen, label: 'Homework' },
  timetable: { icon: CalendarClock, label: 'Timetable' },
  message: { icon: MessageSquare, label: 'Message' },
  notice: { icon: Megaphone, label: 'Notice' },
  // Class Status: opens the home with the viewer on that post (/?status=<id>).
  status: { icon: Camera, label: 'Status' },
  // A post pinned to the school gallery: opens the gallery on that post.
  gallery: { icon: Images, label: 'Gallery' },
}

/* The server's kinds are finer than a reader's: fee_due and fee_overdue are
   both "Fees", report_card and result both "Results". Matched by what the
   kind starts with, so a new variant lands in its family, with its icon,
   instead of showing a bell and its own raw name. */
const FAMILIES: [RegExp, { icon: typeof Bell; label: string }][] = [
  [/^fee|^payment/, { icon: IndianRupee, label: 'Fees' }],
  [/^enquir|^admission/, { icon: UserPlus, label: 'Admissions' }],
  [/^homework/, { icon: BookOpen, label: 'Homework' }],
  [/^attendance|^absen|^leave/, { icon: CalendarCheck, label: 'Attendance' }],
  [/^report_card|^result|^exam/, { icon: Award, label: 'Results' }],
  [/^transport|bus/, { icon: Bus, label: 'Bus' }],
  [/digest/, { icon: Bell, label: 'Daily report' }],
  [/^lms|^lesson/, { icon: BookOpen, label: 'Lessons' }],
  [/message|^chat/, { icon: MessageSquare, label: 'Messages' }],
]

function kindOf(kind: string) {
  const k = kind.toLowerCase()
  return KINDS[k] ?? FAMILIES.find(([re]) => re.test(k))?.[1] ?? { icon: Bell, label: k.replace(/[-_.]+/g, ' ') }
}

/* Days, not timestamps.

   "2026-08-19" is a date somebody has to work out the distance to. The panel
   has the room to say "Yesterday", and for anything older the day and month in
   words, which is how the message would have been spoken. */
function dayOf(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'Earlier'
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(new Date()) - midnight(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })
}

function dateOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/* The filter row: what a parent sorts a feed by. */
const FILTERS: { key: string; label: string; kinds?: string[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'message', label: 'Messages', kinds: ['message', 'chat'] },
  { key: 'academic', label: 'Academic', kinds: ['homework', 'timetable', 'exam', 'result', 'results', 'report', 'attendance', 'leave'] },
  { key: 'fees', label: 'Fees', kinds: ['fee', 'fees', 'payment'] },
  { key: 'status', label: 'Status', kinds: ['status', 'gallery'] },
  { key: 'other', label: 'Other' },
]

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/* The post a status notification is about: its link is "/?status=<id>". */
const statusPostId = (n: Note): string | null => statusPostIdOf(n)

/** The rows the bell and the teacher home panel both show (lib/notification-shown):
    a status whose post has gone is left out, and work owed leads. */
export function useShownNotes(): { items: Note[]; isLoading: boolean; error: unknown } {
  const feed = useNotificationFeed()
  const statusFeed = useStatusFeed()
  let live: Set<string> | null = null
  if (statusFeed.data) {
    live = new Set()
    for (const r of statusFeed.data.rings ?? []) for (const p of r.posts) live.add(p.id.toLowerCase())
    for (const p of statusFeed.data.gallery ?? []) live.add(p.id.toLowerCase())
  }
  const items = pendingFirst((feed.data?.items ?? []).filter((n) => noteShown(n, live)))
  return { items, isLoading: feed.isLoading, error: feed.error }
}

function seconds(n?: number): string {
  if (!n) return ''
  const s = Math.round(n)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/* A STATUS AS A MEDIA NOTIFICATION: the picture (the auth-checked ~320px
   thumbnail), a play tile with the length for a video without one, the
   accent for a text status, the type icon when nothing else is known. */
function StatusThumb({ post, read }: { post?: StatusItem; read: boolean }) {
  const [broken, setBroken] = useState(false)
  const kind = post?.media_kind
  const box = 'relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg'
  if (kind === 'text') {
    return <span className={cn(box, 'bg-primary p-1 text-center text-[9px] font-semibold leading-tight text-primary-foreground')} aria-hidden>
      <span className="line-clamp-3">{post?.caption || <Type className="size-4" />}</span>
    </span>
  }
  const video = kind === 'video'
  return (
    <span className={cn(box, post?.thumb && !broken ? 'bg-black' : read ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')} aria-hidden>
      {post?.thumb && !broken
        ? <img src={post.thumb} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
        : video ? <Play className="size-5" /> : kind === 'photo' ? <ImageIcon className="size-5" /> : <Camera className="size-5" />}
      {video && (
        <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-2 text-[10px] font-semibold text-white">
          <Play className="size-2.5 fill-current" />{seconds(post?.duration_seconds)}
        </span>
      )}
    </span>
  )
}

/** The signed-in user's own feed, shared by the bell and the home panels. */
export function useNotificationFeed() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.call('GET /portal/notifications'),
    refetchOnWindowFocus: true,
    /* Ten seconds, not a minute: a list a minute old still showed work already
       done (Yajur, 2026-10-24). The revision poll and every mutation
       (App.tsx) invalidate it anyway; this only covers a remount. */
    staleTime: 10_000,
    retry: false,
  })
}

type Feed = { items?: Note[]; unread?: number }

/** Opening a row: gone from the bell and the home panel at once, then the
    server is told (lib/notification-shown dropFromFeed). Work owed stays. */
export function useDismissNotification() {
  return useOptimisticMutation<string>({
    mutationFn: (id) => api.post(`/api/v1/portal/notifications/${id}/dismiss`, {}),
    queryKeys: [['notifications']],
    apply: (old, id) => dropFromFeed(old as Feed, id),
    failure: "Couldn't clear it",
  })
}

/** Where a notification leads: shared by the bell and the home panels, so
    both open the same screen for the same row. */
export function useNotificationActions() {
  /* Clicking a notification opens the thing it is about.
   *
   * Every row carried a link and nothing used it: the panel listed what had
   * happened and left the reader to work out where it lived, which for a
   * staff message meant knowing that Communication has a Messages screen. The
   * one action a notification exists to prompt was the one thing it did not
   * do. */
  /* Rows written before links were, and any kind the server does not map,
     still land somewhere sensible for a parent: the kind names the screen.
     Each href is undefined for a reader who does not hold that screen, so
     staff see nothing they cannot open. */
  /* EVERY ROLE'S OWN MESSAGES SCREEN, NOT ONLY THE PARENT'S (owner,
     2026-10-15: "I see the notification number but no messages... every
     notification, every role should open what it is about"). A "message"
     or "chat" notification -- the one kind with no fallback at all before
     this -- had nowhere to go for anyone who was not a parent, which is
     most of the people this bell rings for: a teacher, the front office, HR,
     a librarian, each sees the identical "communication.messages" screen
     under their own role's key. Tried in this fixed order (parent first,
     since a family account is never also one of the roles below it), the
     first one this person actually holds wins. */
  const messagesHref = useFeatureHrefAny([
    'parent.messages.communication',
    'faculty.communication.messages', 'institution_admin.communication.messages', 'hod.communication.messages',
    'hr.communication.messages', 'finance.communication.messages', 'front_office.communication.messages',
    'librarian.communication.messages', 'nurse.communication.messages', 'counsellor.communication.messages',
    'admissions.communication.messages', 'exam_controller.communication.messages', 'discipline_officer.communication.messages',
    'hostel_warden.communication.messages', 'transport_manager.communication.messages', 'activity_coord.communication.messages',
    'it_admin.communication.messages', 'operations.communication.messages',
  ])
  /* A circular is read on the same screen a parent reads it on; staff who
     must acknowledge one have their own circulars desk. */
  const circularHref = useFeatureHrefAny([
    'parent.messages.communication', 'institution_admin.communication.circulars', 'activity_coord.activities.circulars',
  ])
  /* Each destination under every role that receives it, first held wins
     (lib/notification-link.ts maps the kind to the destination). */
  const hrefs: NoteHrefs = {
    messages: messagesHref,
    circular: circularHref,
    status: useFeatureHref('faculty.communication.class_status'),
    transport: useFeatureHref('parent.my_childs_bus.live_bus_tracking'),
    fee: useFeatureHrefAny(['parent.fees.fees_payments', 'student.fees.fees', 'finance.fees.take_fee_payment', 'institution_admin.standard.fee_collection']),
    attendance: useFeatureHrefAny(['parent.home.dashboard', 'student.attendance.attendance', 'faculty.attendance.take_attendance', 'hod.attendance.take_attendance']),
    homework: useFeatureHrefAny(['parent.academics.homework_academics', 'student.homework.homework_assignments', 'faculty.teaching.homework_classwork', 'hod.teaching.homework_classwork']),
    result: useFeatureHrefAny(['parent.academics.results_report_cards', 'student.exams_results.exams_grades', 'faculty.marks_report_cards.report_cards', 'hod.marks_report_cards.report_cards', 'exam_controller.examinations.report_cards', 'institution_admin.examinations.exams_results']),
    timetable: useFeatureHrefAny(['parent.academics.timetable', 'student.timetable.timetable', 'faculty.timetable.my_timetable', 'hod.timetable.my_timetable']),
    concern: useFeatureHrefAny(['faculty.communication.concerns_from_parents', 'front_office.communication.parent_concerns', 'institution_admin.communication.grievances', 'hr.welfare.staff_welfare']) ?? '/concerns',
    questionPapers: useFeatureHrefAny(['faculty.exams.question_papers', 'exam_controller.examinations.exams_papers', 'hod.exams.question_paper_approval', 'institution_admin.exams.question_paper_approval']),
    leaveApprovals: useFeatureHrefAny(['institution_admin.approvals.approvals', 'hr.leave.leave', 'hod.staff.leaves_subs', 'faculty.my_profile.student_leave_requests']),
    leaveSelf: useFeatureHrefAny(['faculty.my_profile.leave_self_service', 'hod.my_profile.leave_self_service', 'hr.my_profile.leave_self_service', 'front_office.my_profile.leave_self_service', 'finance.my_profile.leave_self_service', 'parent.leave_absence.apply_student_leave']),
    calendar: useFeatureHrefAny(['parent.school_life.calendar_ptm', 'student.notices_calendar.calendar', 'faculty.home.my_calendar', 'institution_admin.academics.school_calendar']),
    certificates: useFeatureHrefAny(['parent.documents.certificate_requests', 'student.requests.requests']),
    reports: useFeatureHrefAny(['institution_admin.standard.reports', 'board_member.reports.reports']),
    staffExits: useFeatureHrefAny(['hr.onboarding_exit.staff_joinings_exits']),
    gallery: useFeatureHrefAny(GALLERY_KEYS),
  }
  const linkFor = (n: Note): string | undefined => noteDestination(n, hrefs)
  return { linkFor }
}

export { dayOf as notificationDay, kindOf as notificationKind }

export default function Notifications() {
  const [open, setOpen] = useOpenState(false)
  /* Kept mounted for one animation after the close.

     Unmounting on the click is what makes a panel vanish: the drawer came in
     over half a second and left in a single frame, which reads as a glitch
     rather than as leaving. `closing` holds it on screen long enough to slide
     back out the way it came. */
  const [closing, setClosing] = useState(false)
  const [filter, setFilter] = useState('all')
  const [gallery, setGallery] = useState(false)
  /* A status picked in the drawer is written outside it: the drawer closes,
     then the composer opens on its own (it survived nothing inside the drawer). */
  const [composeReq, setComposeReq] = useState<{ file: File | null; asSchool: boolean; mode?: AddMode } | null>(null)
  const [composing, setComposing] = useState<typeof composeReq>(null)
  useEffect(() => {
    if (!composeReq) return
    const t = window.setTimeout(() => { setComposing(composeReq); setComposeReq(null) }, 450)
    return () => window.clearTimeout(t)
  }, [composeReq])
  /* The owner's design: two toggles at the foot of the drawer. */
  const [onlyUnread, setOnlyUnread] = useState(false)
  const activeRole = useActiveRole()
  const [type, setType] = useState<'messages' | 'activity' | null>(null)
  const hubStudent = useFeatureHref('student.learning.e_learning_resource_hub')
  const hubParent = useFeatureHref('parent.academics.homework_academics')
  const toHub = hubStudent ?? hubParent
  const statuses = useQuery({
    queryKey: ['notif-statuses'],
    queryFn: () => api.get<{ items: { id: string; title: string; kind: string; uploaded_by?: string; posted_on: string; posted_at?: string; seen?: boolean }[] }>('/api/v1/portal/learning/resources'),
    /* Fetched while the drawer is open, so the Activity toggle can carry its count. */
    enabled: open,
    retry: false,
  })
  
  const feed = useNotificationFeed()
  /* THE SECOND POLL, WHICH THE FIRST ONE EXISTS TO MAKE UNNECESSARY.
     *
     * This was `refetchInterval: 10_000` — precisely the per-screen interval
     * lib/live.ts opens by arguing against, and the bell is mounted in the
     * header, so it was on every screen at once. Measured: two independent
     * ten-second timers, twelve requests a minute out of an idle tab that
     * nobody was looking at, for ever.
     *
     * The revision poll already answers "has anything changed?" for the whole
     * app and invalidates everything when it has, which refetches this query
     * because it is mounted. So a notification still arrives without anybody
     * reloading — it arrives by the one mechanism the product already has,
     * rather than by a second one that duplicated it.
     *
     * `refetchOnWindowFocus` is kept, and is now one of the few queries that
     * asks for it (see App.tsx): the bell is the thing people watch after
     * being told "I have sent it", so coming back to the tab must not show a
     * stale count. The options live in useNotificationFeed. */
  /* NO MARK-ALL OR CLEAR-ALL (owner, 2026-10-19: "all notifications should go
     after viewing only; until then they will be there"). A notification
     leaves the drawer when it is opened, and not before. */
  const { linkFor } = useNotificationActions()

  /* OPENING ONE REMOVES IT, THE WAY ANSWERING A LETTER TAKES IT OFF THE PILE
     (owner, 2026-10-16: "after any message is opened it should disappear
     from the notifications"). Reading used to leave the row in place, duller
     but still there, so the only way the drawer ever shrank was the blunt
     Clear All. Opening a status post is unaffected -- that reads the post
     itself over in status-api.ts, not this table -- see openNote below. */
  const dismissOne = useDismissNotification()
  /* The message being read in full, over the drawer. */
  const [viewing, setViewing] = useState<Note | null>(null)

  const navigate = useNavigate()
  // The rings' feed (shared cache with the strip): what each status entry is about.
  const statusFeed = useStatusFeed(open || closing)
  const [statusOpen, setStatusOpen] = useState<string | null>(null)
  const statusHandled = useCallback(() => setStatusOpen(null), [])
  const postById = new Map<string, StatusItem>()
  for (const r of statusFeed.data?.rings ?? []) for (const p of r.posts) postById.set(p.id, p)
  for (const p of statusFeed.data?.gallery ?? []) postById.set(p.id, p)

  const dismiss = useCallback(() => {
    setClosing(true)
    setOpen(false)
  }, [])

  /* The phone's back gesture closes the drawer rather than the app. Routed
     through `dismiss` so a back press plays the same exit the close button
     does, instead of the panel vanishing in a frame. */
  useOverlayHistory(open, dismiss)

  useEffect(() => {
    if (!open) return
    // Escape inside the status viewer or a dialog over the drawer closes that, not the drawer.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !viewing && !document.querySelector('.story')) dismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, viewing])

  const shown = useShownNotes()
  const items = shown.items

  /* Work owed (n.pending) stays until it is done, whatever is pressed. */
  const openNote = (n: Note, keepPending = false) => {
    const drop = () => { if (!(keepPending && n.pending)) dismissOne.mutate(n.id) }
    /* A status opens the viewer at that post, over the drawer; seeing it
       is what reads the entry (POST /status/posts/{id}/view). */
    const post = statusPostId(n)
    if (post && postById.has(post)) {
      setStatusOpen(post)
      // Opened is gone, for a status too (the server also drops it on view).
      drop()
      return
    }
    if (keepPending) {
      /* View: straight to the screen it is about. Read in full only when
         there is no such screen for this reader. */
      const link = linkFor(n)
      if (link) { drop(); leaveTo(link); return }
      setViewing(n)
      drop()
      return
    }
    /* Everything else opens in full, here. A press used to shut the drawer
       and jump to a screen, so a message with no screen of its own simply
       vanished and a long one was never readable anywhere. The screen it is
       about is one button away in the dialog (`follow`). */
    setViewing(n)
    // Dismissed on open, not merely marked read: see dismissOne above.
    dismissOne.mutate(n.id)
  }
  const viewingLink = viewing ? linkFor(viewing) : undefined
  const follow = () => {
    setViewing(null)
    if (viewingLink) leaveTo(viewingLink)
    else dismiss()
  }
  /* Shut the drawer (and any dialog over it), then go to the screen. */
  function leaveTo(link: string) {
    dismiss()
    /* Two overlays shut at once, and each hands its history entry back
       asynchronously (lib/overlay-history). Going to the screen before both
       have gone would let one of those Backs eat the navigation instead. */
    if (!window.history.state?.erpOverlay) { navigate(link); return }
    const go = () => {
      window.removeEventListener('popstate', settled)
      window.clearTimeout(giveUp)
      navigate(link)
    }
    const settled = () => { if (!window.history.state?.erpOverlay) go() }
    const giveUp = window.setTimeout(go, 400)
    window.addEventListener('popstate', settled)
  }

  /* Grouped as it is read: newest day first, in the order the server sent.
     Re-sorting here would fight an endpoint that already knows what is
     urgent. */
  const listed = FILTERS.flatMap((x) => x.kinds ?? [])
  const inKinds = (kind: string, ks: string[]) => ks.some((k) => kind === k || kind.startsWith(k + '_'))
  const isMessage = (n: Note) => inKinds(n.kind, ['message', 'chat', 'parent_message', 'teacher_message'])
  /* Messages first if there are any, otherwise activity, so the drawer never
     opens on an empty side by default. */
  /* The owner's split: Messages is every notification; Activity is status
     posts (the e-learning hub's photo, video and note statuses). */
  /* An account whose roles carry no workspace (a class teacher alone, a
     school mid-setup) has no active role at all; the bell still has to draw. */
  const asParent = activeRole?.key === 'parent'
  /* THE BADGE NEVER PROMISES WHAT THE DRAWER CANNOT SHOW (owner, 2026-10-16:
     "why do I see this" -- Messages badged 3, Messages open, "Nothing in
     this filter"). The three were a daily digest, which `inToggles` below
     has always hidden from anyone not currently a parent -- the badge never
     knew that and counted them anyway. Whichever rule ever hides a kind from
     this account entirely goes here too, so nothing counted is a row the
     drawer could not produce if asked. */
  const reachable = (n: Note) => asParent || !/digest/.test(n.kind)
  /* A status entry counts while its post still has something unseen: once the
     feed is loaded, a post already seen, or one no longer shown, is not new. */
  const statusUnseen = (n: Note) => {
    const id = statusPostId(n)
    if (!id || !statusFeed.data) return true
    const post = postById.get(id)
    return !!post && !post.seen
  }
  const countFor = (v: string) => items.filter((n) => !n.read_at && reachable(n) && (v === 'activity' ? /status/.test(n.kind) && statusUnseen(n) : !/status/.test(n.kind))).length
  /* THE BELL'S OWN NUMBER, OPENED ONTO (owner, 2026-10-15: "I see the
     notification number but I don't see any messages"). The drawer always
     opened on Messages, which is right unless every one of today's unread
     rows happens to be a class-status post -- then the bell said "3" and the
     tab it landed on said nothing, with Activity, carrying the three, one
     tap away and no sign it was there. The default now looks at what is
     actually unread before choosing a side; a person's own choice (`type`)
     still wins once they have picked one. */
  const shownType = type ?? (countFor('messages') > 0 || countFor('activity') === 0 ? 'messages' : 'activity')
  const unread = countFor('messages') + countFor('activity')
  const newStatuses = (statuses.data?.items ?? []).filter((x) => !x.seen && Date.now() - new Date(x.posted_at ?? x.posted_on).getTime() < 7 * 86400000).length
  void newStatuses
  void isMessage
  /* Status updates live in Activity; Messages is everything else (the owner's rule). */
  const isStatusNote = (n: Note) => /status/.test(n.kind)
  const inToggles = (n: Note) => reachable(n) && (!onlyUnread || !n.read_at) && (shownType === 'activity' ? isStatusNote(n) : !isStatusNote(n))
  void setFilter
  const inFilter = (n: Note) => !inToggles(n) ? false : filter === 'all' ? true
    : filter === 'other' ? !inKinds(n.kind, listed)
    /* By prefix: the server sends fee_due, fee_overdue, report_card and so on. */
    : (FILTERS.find((x) => x.key === filter)?.kinds ?? []).some((k) => n.kind === k || n.kind.startsWith(k + '_') || n.kind.startsWith(k.replace(/s$/, '') + '_'))
  const groups: { day: string; notes: Note[] }[] = []
  for (const n of items.filter(inFilter)) {
    const day = dayOf(n.created_at)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.notes.push(n)
    else groups.push({ day, notes: [n] })
  }

  const shownGroups = groups

  // Refused, or this account has no feed: show nothing rather than a dead control.
  // Below every hook, so a feed that starts failing never changes the hook order.
  if (feed.error) return null

  return (
    <>
      <button
        onClick={() => (open ? dismiss() : setOpen(true))}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        data-help-anchor="bell"
        aria-expanded={open}
        // data-tip as well as title: the dock draws its own label instantly,
        // and the browser's own tooltip takes about a second to appear, so in
        // the dock the bell was the one item that looked unlabelled next to
        // eleven that were not.
        data-tip="Notifications"
        title="Notifications"
        className="relative grid h-9 w-9 md:h-10 md:w-10 place-items-center rounded-sm text-muted-foreground
                   hover:bg-surface-hover hover:text-foreground"
      >
        {/* Bigger on a phone: the owner asked for larger top-bar buttons there. */}
        <Bell className="h-[22px] w-[22px]" />
        {unread > 0 && (
          <span
            /* 12px, the smallest size text is drawn at anywhere else: at 10 the
               count was the one figure in the chrome a phone could not read.
               Placed from the glyph's centre, not the button's corner: the
               button is 32px in the desk dock and 44 on a phone, and pinned
               to the corner the badge sat squarely on the bell in the first
               and floated clear of it in the second. */
            /* TWO CHARACTERS NEED ROOM FOR TWO CHARACTERS.

               16px tall with 12px type is right for a single digit and too
               tight for "9+": the plus sat half outside the pill, which on a
               red circle reads as a rendering fault rather than a count. A
               little taller, type a little smaller, padding that grows with
               the content, and nowrap so it can never break across two lines
               inside a 17px circle. */
            /* count-pill: the figure stays 10.5px at every app text size.
               The pill around it is an optical constant in px, so scaling
               only the type burst it open at Larger. */
            className="count-pill absolute left-[calc(50%+1px)] top-[calc(50%-17px)] grid h-[17px] min-w-[17px]
                       place-items-center whitespace-nowrap rounded-full bg-destructive px-[5px]
                       font-semibold leading-none tracking-tight text-destructive-foreground
                       tabular-nums"
            aria-hidden
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {(open || closing) && createPortal(
        <div
          className={cn(
            'vv-screen-phone fixed inset-0 z-[100] flex justify-end',
            // The ground dims with the drawer rather than appearing under it.
            'transition-colors',
            open ? 'bg-[hsl(var(--scrim))]' : 'pointer-events-none bg-transparent',
          )}
          onClick={dismiss}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            data-side="right"
            data-closing={closing && !open ? '' : undefined}
            /* The drawer's own slide, not a row's entrance inside it: animationend
               bubbles, and a row finishing its rise used to unmount the drawer
               part-way through leaving. */
            onAnimationEnd={(e) => { if (e.target === e.currentTarget && !open) setClosing(false) }}
            onClick={(e) => e.stopPropagation()}
            /* THE OWNER'S MOCK: a quiet header with a count pill, a segmented
               filter, day groups with the date on the right, and each
               notification a card. No unread dot (they asked for none): an
               unread card is picked out by its border and bolder title.
               Full screen on a phone -- 100dvh, above the app header -- so it
               no longer starts under the top bar. */
            className="flex h-[100dvh] max-md:h-full w-full flex-col border-l bg-background shadow-[var(--lift-float)] sm:h-full sm:w-[400px]"
            style={{
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            {/* TWO ROWS, so the title never breaks: the name and the close on
                top, the count and the two actions under it. On a narrow drawer
                one row squeezed "Notifications" onto two lines. */}
            <header className="shrink-0 border-b bg-card px-5 pb-3 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="whitespace-nowrap text-[20px] font-bold tracking-[-0.02em]">Notifications</h2>
                <GlassIconButton label="Close notifications" size="sm" onClick={dismiss}>
                  <X className="size-[18px]" />
                </GlassIconButton>
              </div>
              {items.length > 0 && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-muted-foreground">
                    {unread > 0
                      ? <span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary">{unread} new</span>
                      : 'All caught up'}
                  </span>
                </div>
              )}
            </header>

            {/* Class Status: Add, then the rings, unseen first. Draws nothing
                when the school has it off or there is nothing to show. */}
            {shownType === 'activity' && <StatusRings compact raised openId={statusOpen} onOpenHandled={statusHandled} className="shrink-0 border-b bg-card"
              onCompose={(next) => { setComposeReq(next); dismiss() }} />}
            {shownType === 'activity' && (
              <button type="button" onClick={() => { dismiss(); window.setTimeout(() => setGallery(true), 300) }}
                /* iOS row, like Settings (owner, 2026-10-10: "change the gallery button"). */
                className="mx-4 mt-3 flex min-h-[52px] shrink-0 items-center gap-3 rounded-[14px] border bg-card px-3.5 text-left shadow-[0_1px_2px_rgba(0,0,0,.04)] transition-colors hover:bg-muted/40 active:bg-muted/60">
                <span className="grid size-[32px] shrink-0 place-items-center rounded-[9px] bg-gradient-to-br from-[#ff9f0a] via-[#ff375f] to-[#bf5af2] text-white shadow-[0_1px_3px_rgba(0,0,0,.15)]">
                  <Images className="size-[17px]" strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-normal">School gallery</span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {(() => { const n = (statusFeed.data?.gallery ?? []).filter((p) => p.media_kind !== 'text').length; return n === 1 ? '1 photo' : n ? `${n} photos & videos` : 'Photos from across the school' })()}
                  </span>
                </span>
                {/* The newest pictures, fanned like a stack of prints (owner, 2026-10-10:
                    "add something, it looks ugly"). */}
                {(() => {
                  const pics = (statusFeed.data?.gallery ?? []).filter((p) => p.media_kind !== 'text' && (p.thumb || p.url)).slice(0, 3)
                  if (!pics.length) {
                    /* No pictures yet: three soft tiles in the same fan, so the card still
                       reads as a photo album rather than a bare row. */
                    const tiles = [
                      { Icon: Images, bg: 'linear-gradient(135deg,#5ac8fa,#007aff)' },
                      { Icon: Camera, bg: 'linear-gradient(135deg,#ffcc00,#ff9500)' },
                      { Icon: Video, bg: 'linear-gradient(135deg,#ff6482,#ff2d55)' },
                    ]
                    return (
                      <span className="relative mr-1 flex h-[40px] shrink-0 items-center" aria-hidden="true">
                        {tiles.map(({ Icon, bg }, i) => (
                          <span key={i} style={{ marginLeft: i ? -12 : 0, zIndex: 3 - i, transform: `rotate(${[-6, 3, 8][i]}deg)`, background: bg }}
                            className="grid size-[36px] place-items-center rounded-[9px] border-2 border-card text-white shadow-[0_2px_6px_rgba(0,0,0,.16)]">
                            <Icon className="size-[16px]" strokeWidth={2.2} />
                          </span>
                        ))}
                      </span>
                    )
                  }
                  return (
                    <span className="relative mr-1 flex h-[40px] shrink-0 items-center" aria-hidden="true">
                      {pics.map((p, i) => (
                        <img key={p.id} src={p.thumb ?? p.url} alt="" loading="lazy"
                          style={{ marginLeft: i ? -14 : 0, zIndex: 3 - i, transform: `rotate(${[-6, 3, 8][i]}deg)` }}
                          className="size-[38px] rounded-[9px] border-2 border-card object-cover shadow-[0_2px_6px_rgba(0,0,0,.18)]" />
                      ))}
                    </span>
                  )
                })()}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              </button>
            )}

            <div className="scroll-y min-h-0 flex-1 space-y-4 overscroll-contain p-4">
              {false ? (
                statuses.isLoading ? <p className="py-16 text-center text-[13px] text-muted-foreground">Loading status updates…</p>
                : (statuses.data?.items ?? []).filter((x) => Date.now() - new Date(x.posted_at ?? x.posted_on).getTime() < 7 * 86400000).length === 0
                  ? <p className="py-16 text-center text-[13px] text-muted-foreground">No status updates this week.</p>
                  : (
                    <div className="m-stagger space-y-2">
                      {(statuses.data?.items ?? [])
                        .filter((x) => Date.now() - new Date(x.posted_at ?? x.posted_on).getTime() < 7 * 86400000)
                        .map((x) => (
                          <button key={x.id} type="button" onClick={() => { dismiss(); if (toHub) navigate(toHub) }}
                            className="flex w-full items-center gap-3.5 rounded-2xl border bg-card px-4 py-3.5 text-left transition-[transform,background-color,box-shadow,color] hover:-translate-y-px hover:bg-muted/30">
                            <span className={cn('grid size-10 shrink-0 place-items-center rounded-full text-[12px] font-bold',
                              x.seen ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary ring-2 ring-primary ring-offset-2 ring-offset-card')}>
                              {(x.uploaded_by ?? 'School').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-[13.5px] font-semibold">{x.uploaded_by ?? 'School'}</span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">{timeOf(x.posted_at ?? x.posted_on)}</span>
                              </span>
                              <span className="block truncate text-[12.5px] text-muted-foreground">{x.title}</span>
                            </span>
                          </button>
                        ))}
                    </div>
                  )
              ) : items.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
                  <p className="text-[14px] font-medium">Nothing yet</p>
                  <p className="mx-auto mt-1.5 max-w-[22rem] text-[13px] text-muted-foreground">
                    Homework, notices, fees and timetable changes appear here as
                    the school sends them.
                  </p>
                </div>
              ) : shownGroups.length === 0 ? (
                <p className="py-16 text-center text-[13px] text-muted-foreground">Nothing in this filter.</p>
              ) : (
                shownGroups.map((g) => (
                  <section key={g.day}>
                    <div className="mb-2.5 flex items-center justify-between px-1">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{g.day}</span>
                      <span className="text-[11px] font-medium text-muted-foreground">{dateOf(g.notes[0].created_at)}</span>
                    </div>
                    <div className="m-stagger space-y-2">
                      {g.notes.map((n) => {
                        const { icon: Icon, label } = kindOf(n.kind)
                        const postId = statusPostId(n)
                        if (postId) {
                          const post = postById.get(postId)
                          const chip = post?.media_kind === 'video' ? 'Video' : post?.media_kind === 'text' ? 'Text' : post ? 'Photo' : 'Status'
                          /* The title is "<poster> added a status · <audience>". */
                          /* Older rows carry the audience in the title; the
                             label is the school's and is not shown here. */
                          const [who] = n.title.split(' added a status')
                          const excerpt = post ? post.caption : n.body && !['Photo', 'Video', 'Text'].includes(n.body) ? n.body : undefined
                          return (
                            <NotificationRow key={n.id} title={who || n.title} time={timeOf(n.created_at)} label={label} icon={Icon}
                              media={<StatusThumb post={post} read={!!n.read_at} />} extra={chip} unread={!n.read_at}
                              snippet={[post?.audience, n.student_name, post?.media_kind !== 'text' ? excerpt : undefined, !post && statusFeed.data ? 'No longer showing' : undefined].filter(Boolean).join(' · ') || undefined}
                              onOpen={() => openNote(n)} onView={() => openNote(n, true)} />
                          )
                        }
                        return (
                          <NotificationRow key={n.id} title={n.title} time={timeOf(n.created_at)} label={label} icon={Icon}
                            extra={channelOf(n.body)} unread={!n.read_at} pending={n.pending}
                            snippet={[n.student_name, n.body].filter(Boolean).join(' · ') || undefined}
                            onOpen={() => openNote(n)} onView={() => openNote(n, true)} />
                        )
                      })}
                    </div>
                  </section>
                ))
              )}
            </div>
            {/* THE SWITCHER STAYS WHETHER OR NOT THERE IS ANYTHING IN IT.

                It used to be hidden whenever the list was empty, so clearing
                the messages took Unread/All and Messages/Activity off the
                screen with them -- and with the switcher gone there was no way
                to reach the other side, which was not empty. An empty tab is
                an answer; a missing tab is a dead end. */}
            <footer className="flex shrink-0 items-center gap-3.5 border-t bg-card px-5 py-4">
                <div className="flex flex-1 gap-1 rounded-full bg-muted p-1">
                  {[["unread","Unread"],["all","All"]].map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setOnlyUnread(v === 'unread')}
                      className={cn('relative min-h-[40px] flex-1 rounded-full px-3 text-[14px] font-semibold transition-[transform,background-color,box-shadow,color]',
                        (v === 'unread') === onlyUnread ? 'bg-card text-foreground shadow-[0_4px_10px_-2px_rgba(15,23,42,0.12)]' : 'text-muted-foreground hover:text-foreground')}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-1 gap-1 rounded-full bg-muted p-1">
                  {[["messages","Messages"],["activity","Activity"]].map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setType(v as 'messages' | 'activity')}
                      className={cn('relative min-h-[40px] flex-1 rounded-full px-3 text-[14px] font-semibold transition-[transform,background-color,box-shadow,color]',
                        v === shownType ? 'bg-card text-foreground shadow-[0_4px_10px_-2px_rgba(15,23,42,0.12)]' : 'text-muted-foreground hover:text-foreground')}>
                      {label}{countFor(v) > 0 && <span className="absolute -top-1 right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-white bg-[hsl(var(--sys-danger-fill))] px-[5px] text-[11px] font-bold leading-none text-white shadow-[0_2px_5px_rgba(239,68,68,0.3)]">{countFor(v)}</span>}
                    </button>
                  ))}
                </div>
            </footer>
          </aside>
        </div>,
        document.body,
      )}

      {viewing && (() => {
        const { icon: KindIcon, label: kindLabel } = kindOf(viewing.kind)
        return (
          <Dialog
            raised
            onClose={() => setViewing(null)}
            title={viewing.title}
            description={`${dayOf(viewing.created_at)}, ${timeOf(viewing.created_at)}`}
            footer={viewingLink ? (
              <>
                <Button variant="ghost" onClick={() => setViewing(null)}>Close</Button>
                <Button onClick={follow}>
                  Open {kindLabel}<ArrowUpRight className="size-4" />
                </Button>
              </>
            ) : undefined}
          >
            {/* What it is and whose it is, before what it says. */}
            <div className="mb-3.5 flex flex-wrap items-center gap-2 text-[12.5px] font-semibold">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 capitalize text-primary">
                <KindIcon className="size-3.5" aria-hidden />{kindLabel}
              </span>
              {viewing.student_name && (
                <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">{viewing.student_name}</span>
              )}
            </div>
            {viewing.body
              ? <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.65]">{viewing.body}</p>
              : <p className="text-[13.5px] text-muted-foreground">Nothing more was sent with this notification.</p>}
          </Dialog>
        )
      })()}
      {gallery && <SchoolGallery onClose={() => setGallery(false)} />}
      {composing && <StatusComposer raised file={composing.file} mode={composing.mode} asSchool={composing.asSchool} onClose={() => setComposing(null)} />}
    </>
  )
}
