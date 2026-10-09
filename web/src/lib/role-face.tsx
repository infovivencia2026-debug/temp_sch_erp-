import {
  Landmark, Gavel, Network, ClipboardCheck, Presentation, Library, Bus, Wrench, CarFront, Stethoscope,
  HeartHandshake, ShieldAlert, BedDouble, Trophy, Wallet, UserPlus, ConciergeBell, Server, MonitorPlay,
  GraduationCap, Baby, Store, Crown, Users, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/* ONE FACE PER ROLE (owner, 2026-10-08: "for role switch each role should
   have unique icon").

   Settings' workspace rows read their icon from the same name-matching table
   the link rows use, and one clause in it -- staff|people|user|login|
   principal|admin|board|trustee|hod|...|hr -- swallowed almost every role
   there is. A person holding six workspaces opened the switch and saw six
   identical purple squares of the same two figures, which is worse than no
   icon at all: an icon that is the same on every row is noise the eye still
   has to step over. The sidebar's own switcher had no icons whatsoever, so
   the two switchers in the product agreed only by both being unreadable.

   Keyed on the role KEY, never its name: names are editable per school
   ("Accounts & Finance" is "Accounts Dept" in one of them) and a renamed
   role must not lose its face.

   Each icon says what the job is rather than what rank it holds -- a bus for
   transport, a stethoscope for the clinic, a trophy for sports -- and the
   colours are spread far enough apart that two roles listed next to each
   other never share one. A key missing from this table has no face, and each
   caller falls back to whatever it drew before, which is what a role added
   after today will get until it is listed here. */
const ROLE_FACE: Record<string, [LucideIcon, string]> = {
  seller_admin: [Store, '#8e8e93'],
  super_admin: [Crown, '#1f2937'],
  institution_admin: [Landmark, '#007aff'],
  board_member: [Gavel, '#6d28d9'],
  hod: [Network, '#7c3aed'],
  exam_controller: [ClipboardCheck, '#ef4444'],
  faculty: [Presentation, '#0ea5e9'],
  librarian: [Library, '#a16207'],
  transport_manager: [Bus, '#ff9500'],
  operations: [Wrench, '#64748b'],
  driver: [CarFront, '#f59e0b'],
  nurse: [Stethoscope, '#ec4899'],
  counsellor: [HeartHandshake, '#14b8a6'],
  discipline_officer: [ShieldAlert, '#dc2626'],
  hostel_warden: [BedDouble, '#4f46e5'],
  activity_coord: [Trophy, '#eab308'],
  finance: [Wallet, '#34c759'],
  admissions: [UserPlus, '#06b6d4'],
  front_office: [ConciergeBell, '#0891b2'],
  hr: [Users, '#af52de'],
  it_admin: [Server, '#475569'],
  lms_admin: [MonitorPlay, '#2563eb'],
  student: [GraduationCap, '#3b82f6'],
  parent: [Baby, '#f97316'],
}

export function roleFace(key: string): [LucideIcon, string] | undefined {
  return ROLE_FACE[key]
}

/** The rounded square a settings row leads with, 30px, white glyph. */
export function RoleTile({ roleKey }: { roleKey: string }) {
  const face = roleFace(roleKey)
  if (!face) return null
  const [Icon, tint] = face
  return (
    <span
      aria-hidden="true"
      className="grid size-[30px] shrink-0 place-items-center rounded-[8px] text-white shadow-[0_1px_2px_rgb(0_0_0/0.12)] [&_svg]:size-[17px] [&_svg]:stroke-[2.1]"
      style={{ background: tint }}
    >
      <Icon />
    </span>
  )
}

/** The bare glyph a menu row leads with, in the role's own colour. The
    sidebar's menu is a list of text rows and a tinted box on each would turn
    it into a second settings screen; the colour alone is enough to tell six
    rows apart. */
export function RoleGlyph({ roleKey, className }: { roleKey: string; className?: string }) {
  const face = roleFace(roleKey)
  if (!face) return null
  const [Icon, tint] = face
  return <Icon aria-hidden className={cn('size-4 shrink-0', className)} style={{ color: tint }} />
}
