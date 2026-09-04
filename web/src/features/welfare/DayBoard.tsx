import type { ReactNode } from 'react'
import { useT } from '@/lib/i18n'
import { usePhone } from '@/lib/viewport'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from '../bento/bento-kit'
import { Facts, PersonaCard, PersonaPage, Say } from '../bento/persona-kit'
import { Widget } from '../bento/WidgetLayer'

/* ONE SMALL BOARD, FIVE TIMES.

   The nurse, the counsellor, the discipline officer, the warden and the
   activity coordinator each land on a page that answers "what is my day": two
   or three figures, each read from an endpoint the role already holds, each
   opening the screen where the work is done. None of them has a denominator
   worth drawing, so every drawing is `Facts` — the real figures around the
   headline — or a sentence saying there is nothing.

   Two compositions, not one squeezed. On a desktop the cards sit in the
   arranger's grid and can be moved and resized like every other board. On a
   phone there is no arranger: the cards stack in the order given, the anchor
   first, and each takes the width. */

export interface DayCard {
  id: string
  title: string
  /** The one-line figure under the title. */
  value: ReactNode
  change?: string
  /** Rows under the figure. Empty means `say` is shown instead. */
  facts?: { label: string; value: string }[]
  /** What to say when there is nothing to list. */
  say: string
  /** Catalogue key of the screen this card opens. Absent from the catalogue
      means the card is not a link. */
  opens?: string
  cue: string
  /** One card per board carries the coloured ground. */
  ground?: string
}

function Card({ span, card }: { span: CellSpan; card: DayCard }) {
  const to = useFeatureHref(card.opens ?? '')
  const rows = card.facts ?? []
  return (
    <PersonaCard
      span={span}
      ground={card.ground}
      title={card.title}
      value={card.value}
      change={card.change}
      to={card.opens ? to : undefined}
      cueLabel={card.cue}
    >
      {rows.length ? <Facts items={rows} srLabel={card.title} /> : <Say>{card.say}</Say>}
    </PersonaCard>
  )
}

export function DayBoard({
  dashboard,
  eyebrow,
  title,
  loading,
  failed,
  cards,
}: {
  dashboard: string
  eyebrow: string
  title: string
  loading: boolean
  failed: boolean
  cards: DayCard[]
}) {
  const t = useT()
  const phone = usePhone()
  if (loading) return <BentoLoading message={t('bento.welfare.loading')} />
  if (failed) return <BentoError message={t('bento.welfare.failed')} />

  if (phone) {
    return (
      <PersonaPage eyebrow={eyebrow} title={title}>
        {cards.map((c) => (
          <Card key={c.id} span="one" card={c} />
        ))}
      </PersonaPage>
    )
  }
  return (
    <PersonaPage eyebrow={eyebrow} title={title} dashboard={dashboard}>
      {cards.map((c, i) => (
        <Widget key={c.id} id={c.id} label={c.title} size={i === 0 ? 'large' : 'small'} index={i}>
          {(span) => <Card span={span} card={c} />}
        </Widget>
      ))}
    </PersonaPage>
  )
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Today, as the server writes dates: YYYY-MM-DD in the browser's own day. */
export function today(): string {
  return ymd(new Date())
}

/** Seven days back, same shape. */
export function weekAgo(): string {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return ymd(d)
}
