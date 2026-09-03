/* THE FILLED-IN TEMPLATE FOLDER, IF THEY HAVE ONE.
 *
 * A school that was sent docs/school-setup-templates and filled it in arrives
 * with ten files and a wizard that asks for them one at a time, each behind
 * its own step, each with its own file picker. So the wizard asks once, up
 * front: do you have the folder? Hand it over and every sheet is already
 * waiting inside the step it belongs to.
 *
 * A school that does not have it never sees any of this and the wizard is
 * exactly what it was.
 *
 * Held in a module rather than in React state because the two ends are far
 * apart: the folder is chosen at the top of the wizard, and it is read by the
 * BulkImport inside whichever panel is open. Passing it down would mean a prop
 * through every panel in PANELS, most of which import nothing.
 *
 * NOTHING IS IMPORTED BY THIS. The file is put into the step's own uploader,
 * which still does its dry run, still shows the rows and still waits to be
 * told to commit. Handing over a folder is not the same as saying yes to ten
 * imports, and a school looking at 400 children it has never seen on screen
 * should be the one to press the button.
 */

export interface PackFile {
  name: string
  text: string
}

/* Which sheet is which importer.
 *
 * Matched on the number the template's filename starts with, not on the whole
 * name: a school that renames "04-students.csv" to "04-students-final.csv" --
 * or whose browser hands over "04-students (2).csv" -- has still given us the
 * students sheet. The rest of the name is theirs.
 */
const BY_NUMBER: Record<string, { entity: string; step: string; label: string }> = {
  '01': { entity: 'classes', step: 'classes', label: 'Classes and sections' },
  '02': { entity: 'staff', step: 'staff', label: 'Staff' },
  '03': { entity: 'class_subjects', step: 'subjects', label: 'Subjects, classes and teachers' },
  '04': { entity: 'students', step: 'students', label: 'Students' },
  '05': { entity: 'periods', step: 'periods', label: 'The school day' },
  '06': { entity: 'fee_heads', step: 'fee_heads', label: 'Fee heads' },
  '07': { entity: 'fee_structures', step: 'fee_structures', label: 'Fee structures' },
  '08': { entity: 'student_history', step: 'history', label: 'Past years, per child' },
  '09': { entity: 'marks_grid', step: 'history', label: 'Past results' },
  '10': { entity: 'staff_history', step: 'history', label: 'Staff service' },
}

export interface PackEntry {
  entity: string
  step: string
  label: string
  file: PackFile
}

/** What a filename says it is, or nothing. README.txt and guide.html are in
 *  the folder too and are not sheets. */
export function identify(name: string): { entity: string; step: string; label: string } | null {
  const base = name.split(/[\/]/).pop() ?? name
  if (!/\.csv$/i.test(base)) return null
  const m = /^\s*(\d{2})\b/.exec(base)
  return m ? (BY_NUMBER[m[1]] ?? null) : null
}

let pack: PackEntry[] = []
/* An entity is taken out of the pack once its uploader has picked it up, so
   discarding a file on the import screen does not have it reappear the next
   time that step is opened. */
const taken = new Set<string>()
const listeners = new Set<() => void>()

function announce() {
  for (const fn of listeners) fn()
}

export function subscribeToPack(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function setPack(entries: PackEntry[]) {
  pack = entries
  taken.clear()
  announce()
}

export function clearPack() {
  pack = []
  taken.clear()
  announce()
}

export function packEntries(): PackEntry[] {
  return pack
}

/** The sheet waiting for this importer, if one is and it has not been taken. */
export function packFor(entity: string): PackFile | null {
  if (taken.has(entity)) return null
  return pack.find((e) => e.entity === entity)?.file ?? null
}

export function markTaken(entity: string) {
  taken.add(entity)
  announce()
}

export function wasTaken(entity: string): boolean {
  return taken.has(entity)
}

/** Reads what the folder picker or the drop handed over, keeping only the
 *  sheets we recognise and refusing anything too large to be one. */
export async function readPack(files: File[]): Promise<PackEntry[]> {
  const out: PackEntry[] = []
  for (const f of files) {
    const what = identify(f.name)
    if (!what) continue
    // A class list is kilobytes. Anything past the server's own 8 MB limit
    // would only be refused later, on a screen further from the mistake.
    if (f.size > 8 << 20) continue
    out.push({ ...what, file: { name: f.name, text: await f.text() } })
  }
  return out.sort((a, b) => a.file.name.localeCompare(b.file.name))
}
