import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/* The child's face, wherever a child is listed.
 *
 * A class teacher knows thirty children by sight and not by admission number.
 * A list of names is exactly where picking the wrong child is easiest and
 * costliest — publishing one card, marking one absence, raising one bill
 * against a name that looked close enough.
 *
 * Where no photograph is on file it falls back to initials on a colour drawn
 * from the child's own id, so the column is never a row of empty grey circles.
 * The colour carries no meaning; it exists so two adjacent rows do not look
 * like the same person.
 */

// A fixed set that reads on both themes, picked by id rather than at random so
// a child keeps the same colour on every screen and between sessions.
const TONES = [
  'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100',
  'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
  'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-100',
  'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-100',
  'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-100',
]

function toneFor(seed: string) {
  let n = 0
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0
  return TONES[n % TONES.length]
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function StudentAvatar({
  name,
  photoFileId,
  seed,
  size = 32,
  /* Selection lives on the face rather than beside it.
   *
   * The tick box and the photograph want the same square of a crowded row, and
   * of the two the photograph is the one that tells you who this is. So the
   * avatar is the control: it shows a tick when chosen and a ring on hover, in
   * the way any photo grid that supports selection behaves. Passing no
   * onSelect leaves it a plain picture. */
  selected,
  onSelect,
  className,
}: {
  name: string
  photoFileId?: string | null
  seed?: string
  size?: number
  selected?: boolean
  onSelect?: (next: boolean) => void
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  const show = photoFileId && !broken

  const face = (
    <span
      className={cn(
        'relative inline-flex flex-none items-center justify-center overflow-hidden rounded-full',
        !show && toneFor(seed ?? name),
        className,
      )}
      style={{ width: size, height: size }}
    >
      {show ? (
        <img
          src={`/api/v1/files/${photoFileId}`}
          alt=""
          className="h-full w-full object-cover"
          /* A photograph whose file has been removed leaves a broken-image
             icon in every row of the register, which looks like the list is
             broken rather than the file. Fall back to the initials. */
          onError={() => setBroken(true)}
        />
      ) : (
        <span
          className="font-medium leading-none"
          style={{ fontSize: Math.max(10, Math.round(size * 0.36)) }}
        >
          {initials(name)}
        </span>
      )}
      {selected && (
        <span className="absolute inset-0 flex items-center justify-center bg-primary/85">
          <Check className="h-4 w-4 text-primary-foreground" aria-hidden />
        </span>
      )}
    </span>
  )

  if (!onSelect) return face

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={!!selected}
      aria-label={`Select ${name}`}
      onClick={() => onSelect(!selected)}
      className={cn(
        'rounded-full outline-none ring-offset-2 ring-offset-background transition',
        'hover:ring-2 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-primary',
        selected && 'ring-2 ring-primary',
      )}
    >
      {face}
    </button>
  )
}
