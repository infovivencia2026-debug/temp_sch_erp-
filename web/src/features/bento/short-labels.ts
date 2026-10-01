/* ONE WORD UNDER AN APP ICON (owner, 2026-10-01: "for icons in bento use
   only one word"). The full name stays in the tile's title and aria-label;
   this is only what is drawn beneath the plate.

   A curated name wins; otherwise the first meaningful word of the name,
   after dropping words that say nothing on their own (My, The, Management,
   Hub, …) and leading verbs (Take, Apply, Update, …). `shortLabels` keeps
   labels on one board distinct: a clash falls back to two words. */

const CURATED: Record<string, string> = {
  'student 360': 'Students',
  'staff 360': 'Staff',
  'class 360': 'Class',
  'admissions pipeline': 'Admissions',
  'school setup': 'Setup',
  'institution setup': 'Setup',
  'fee default': 'Defaulters',
  'fee defaulters': 'Defaulters',
  'unpaid fees & reminders': 'Defaulters',
  'approvals': 'Approvals',
  'e-learning': 'LMS',
  'lms': 'LMS',
  'lms admin': 'LMS',
  'class status': 'Status',
  'timetable': 'Timetable',
  'live bus tracking': 'Bus',
  'my bus & route': 'Bus',
  'live vehicle tracking': 'Tracking',
  'homework / classwork': 'Homework',
  'homework & academics': 'Homework',
  'homework & assignments': 'Homework',
  'fees & payments': 'Fees',
  'take fee payment': 'Collect',
  'results & report cards': 'Results',
  'marks & report cards': 'Marks',
  'exams & results': 'Exams',
  'notices & calendar': 'Notices',
  'calendar & ptm': 'Calendar',
  'all messages': 'Messages',
  'my day': 'Today',
  'student progress': 'Progress',
  'my pay': 'Payslips',
  'my run': 'Run',
  'my id card': 'ID card',
  'update my details': 'Details',
  'remarks about me': 'Remarks',
  'where the money goes': 'Spending',
  'year rollover': 'Rollover',
  'audit log': 'Audit',
  'audit trail': 'Audit',
}

const GENERIC = new Set([
  'my', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', '&', '/', '-', 'with',
  'management', 'hub', 'portal', 'records', 'record', 'centre', 'center', 'module',
  'take', 'apply', 'update', 'view', 'manage', 'all', 'online', 'digital', 'automated',
  'integration', 'overview', 'dashboard', 'school', 'this',
])

function words(name: string): string[] {
  return name
    .split(/[\s/&,()·:]+/)
    .map((w) => w.trim())
    .filter((w) => w && !GENERIC.has(w.toLowerCase()))
}

const cap = (w: string) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)

/** The one word drawn under an icon. */
export function shortLabel(name: string): string {
  const curated = CURATED[name.trim().toLowerCase()]
  if (curated) return curated
  const w = words(name)
  return w.length ? cap(w[0]) : name.trim()
}

function twoWords(name: string): string {
  const w = words(name)
  return w.length > 1 ? `${cap(w[0])} ${w[1].toLowerCase()}` : shortLabel(name)
}

/** Short labels for every icon on one board, none repeated: a clash falls
    back to two words for the icons that clash. */
export function shortLabels(names: string[]): string[] {
  const out = names.map(shortLabel)
  const count = new Map<string, number>()
  out.forEach((l) => count.set(l, (count.get(l) ?? 0) + 1))
  const two = out.map((l, i) => ((count.get(l) ?? 0) > 1 ? twoWords(names[i]) : l))
  /* Still the same after two words (two names that start alike): keep the
     full names for those, the ellipsis and title carry them. */
  const again = new Map<string, number>()
  two.forEach((l) => again.set(l, (again.get(l) ?? 0) + 1))
  return two.map((l, i) => ((again.get(l) ?? 0) > 1 && names[i] !== l ? names[i] : l))
}
