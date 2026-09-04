import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import type { ListItem } from './AppearanceDialog'

/* THE SETTINGS LIST AS A PHONE SCREEN, NOT AN ADMIN TABLE.

   Every row carried the same weight: one flat list, one rule between each
   pair, every entry as loud as every other, and then a screen and a half of
   empty ground underneath it. A flat list of nine is a table of contents, and
   a table of contents is what you build when you have not decided what matters.

   Three changes carry almost all of the difference, and none of them is
   decoration:

   GROUPING, so the eye lands on four short lists instead of scanning nine
   equal rows. Personalisation is what somebody came here to change; account
   and privacy is what they came here to check; the school's own settings are
   neither and belong between them.

   A VALUE ON THE RIGHT, because half these rows already have an answer and
   were not showing it. "Appearance  Focus" and "Dock  Compact" tell you
   whether you need to open the row at all, which is the one thing a settings
   list can do that a menu cannot.

   AN ICON WITH A GROUND. A 16px glyph floating in a 56px row reads as a bullet
   point. In a 34px tinted box it reads as an object belonging to the row, and
   it gives the eye a left edge to run down.

   WHAT IS DELIBERATELY NOT HERE. No colour on the rows themselves: the swatch
   on Colour is the only coloured thing, and it earns it by being the value
   rather than an ornament. And no toggles inline yet, however much a binary
   setting deserves one -- the sections behind these rows own their own state
   and lifting a switch up here means two places that can disagree about it.
*/

/** Which card each section belongs on, in the order the cards appear. */
const GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Personalisation', ids: ['appearance', 'colour', 'dock', 'dashboard'] },
  { title: 'School and communication', ids: ['school', 'communication', 'messaging'] },
  { title: 'Account and privacy', ids: ['account', 'security', 'privacy', 'people', 'access'] },
]

export function SettingsGroups({ items, values, onOpen, accent }: {
  items: ListItem[]
  values?: Partial<Record<string, string>>
  onOpen: (id: string) => void
  /** The current accent, drawn as the value of the Colour row. */
  accent?: string
}) {
  const byId = new Map(items.map((i) => [i.id, i]))
  const used = new Set<string>()

  const cards = GROUPS.map((g) => {
    const rows = g.ids.map((id) => byId.get(id)).filter(Boolean) as ListItem[]
    rows.forEach((r) => used.add(r.id))
    return { title: g.title, rows }
  }).filter((c) => c.rows.length > 0)

  /* Anything the groups above do not name still has to appear.

     The sections come from the catalogue and depend on what a role holds, so
     a list written here can only ever be a guess at what exists. Everything
     unclaimed lands in one last card rather than vanishing, which is the
     difference between a grouping that is wrong and a screen that has silently
     lost a setting somebody needs. */
  const rest = items.filter((i) => !used.has(i.id))

  return (
    <div className="space-y-6">
      <ProfileCard onOpen={onOpen} />
      {cards.map((c) => (
        <Group key={c.title} title={c.title}>
          {c.rows.map((r) => (
            <Row key={r.id} item={r} value={values?.[r.id]}
                 swatch={r.id === 'colour' ? accent : undefined}
                 onClick={() => onOpen(r.id)} />
          ))}
        </Group>
      ))}
      {rest.length > 0 && (
        <Group title="More">
          {rest.map((r) => (
            <Row key={r.id} item={r} value={values?.[r.id]} onClick={() => onOpen(r.id)} />
          ))}
        </Group>
      )}
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      {/* Small, muted, spaced. A section label is read once on the way past;
          at the weight of a heading it competes with the rows under it. */}
      <h2 className="mb-2 px-1 text-[11.5px] font-semibold uppercase tracking-[0.07em]
                     text-muted-foreground">
        {title}
      </h2>
      {/* One card, one hairline, rules only BETWEEN rows. A border on every
          row draws a line under the last one as well, which is what makes a
          list look like a table rather than a card. */}
      <div className="overflow-hidden rounded-[14px] border bg-card">
        <div className="divide-y">{children}</div>
      </div>
    </section>
  )
}

function Row({ item, value, swatch, onClick }: {
  item: ListItem
  value?: string
  swatch?: string
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 px-4 text-left',
        // 56px, which is the floor a thumb wants and roughly what the row
        // needs anyway once the icon has a box of its own.
        'min-h-[56px]',
        // The pressed state was missing entirely: a row that does not answer a
        // tap reads as a dead row for the moment before the screen changes.
        'transition-colors active:bg-muted',
      )}
    >
      <span
        aria-hidden
        className="grid size-[34px] shrink-0 place-items-center rounded-[10px]
                   bg-muted text-foreground/75"
      >
        <Icon className="size-[17px]" />
      </span>

      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{item.label}</span>

      {/* The value, muted so the name stays the thing being read. The swatch
          replaces it on Colour, because a colour named in words is the one
          value on this screen that words are worse at than a square. */}
      {swatch ? (
        <span
          aria-hidden
          className="size-[18px] shrink-0 rounded-full border"
          style={{ background: swatch }}
        />
      ) : value ? (
        <span className="max-w-[42%] shrink-0 truncate text-[13.5px] text-muted-foreground">
          {value}
        </span>
      ) : null}

      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  )
}

/* WHO IS SIGNED IN, AT THE TOP, WHERE EVERY PHONE PUTS IT.

   Not vanity: this product signs one person into several roles and several
   schools, and "which account am I in" is a question the old list could not
   answer at all.

   THE PICTURE IS REAL NOW. users.avatar_key has been in the baseline since the
   beginning and the profile read has always returned it; nothing ever wrote
   it, so every person in every school was drawn as their initials with no way
   to be anything else. The camera button uploads to the same file endpoint the
   student photo import uses and stores the id it returns.

   Initials stay as the fallback rather than a grey silhouette. A silhouette
   says "no picture"; initials say who this is, which is the thing the row is
   for. */
function ProfileCard({ onOpen }: { onOpen: (id: string) => void }) {
  const session = useSession()
  const qc = useQueryClient()
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const profile = useQuery({
    queryKey: ['profile', 'avatar'],
    queryFn: () => api.get<{ full_name: string; avatar_key?: string }>('/api/v1/profile'),
  })

  const name = profile.data?.full_name ?? session.user?.full_name ?? 'Signed in'
  const school = session.institution?.name
  const role = session.user?.roles?.[0]?.replace(/_/g, ' ')
  const avatar = profile.data?.avatar_key

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

  async function pick(f: File) {
    setBusy(true)
    setFailed(null)
    try {
      const form = new FormData()
      form.append('file', f)
      const up = await fetch('/api/v1/files', { method: 'POST', body: form })
      if (!up.ok) throw new Error('That picture did not upload')
      const { file_id } = (await up.json()) as { file_id: string }
      /* full_name goes with it because the endpoint rewrites the row and
         requires a name. Sending the one we just read back keeps this from
         being a rename nobody asked for. */
      await api.put('/api/v1/profile', { full_name: name, avatar_key: file_id })
      await qc.invalidateQueries({ queryKey: ['profile'] })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'That picture did not upload')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[16px] border bg-card p-4">
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => file.current?.click()}
            aria-label={avatar ? 'Change your picture' : 'Add a picture'}
            className="grid size-[72px] place-items-center overflow-hidden rounded-full
                       bg-muted text-[24px] font-semibold transition-opacity active:opacity-80"
          >
            {avatar
              ? <img src={`/api/v1/files/${avatar}`} alt="" className="size-full object-cover" />
              : initials}
          </button>
          {/* The camera sits on the picture rather than beside it, so the
              affordance is on the thing it changes. */}
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-0.5 -right-0.5 grid size-7
                       place-items-center rounded-full border-2 border-card bg-foreground
                       text-background"
          >
            <Camera className="size-3.5" />
          </span>
          <input
            ref={file}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              // Cleared first: picking the same file twice fires no change
              // event otherwise, so a failed upload could not be retried.
              e.target.value = ''
              if (f) void pick(f)
            }}
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[19px] font-semibold leading-tight">{name}</p>
          <p className="mt-0.5 truncate text-[13.5px] text-muted-foreground">
            {[school, role].filter(Boolean).join(' \u00b7 ') || 'Account and profile'}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {busy ? 'Uploading\u2026' : failed ?? (avatar ? 'Tap the photo to change it' : 'Tap the photo to add one')}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onOpen('account')}
        className="mt-3 flex w-full items-center gap-2 rounded-[10px] px-1 py-2
                   text-left text-[14px] font-medium transition-colors active:bg-muted"
      >
        <span className="flex-1">Account and profile</span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </button>
    </section>
  )
}
