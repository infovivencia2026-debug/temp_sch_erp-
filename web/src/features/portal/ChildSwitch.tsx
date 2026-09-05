import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortalChild } from './use-children'

/* WHICH CHILD, IN ONE CONTROL ON EVERY PARENT SCREEN.

   The home board and the classic portal each drew their own segmented control
   of first names. On a desktop that is the right thing: two or three pills
   beside the title, the other child one click away. On a phone the same pills
   sat in a header that is one line tall by design, took the width the title
   needed, and with three children wrapped under it; a parent asked where the
   switch was, because a row of first names does not read as one.

   So one component, two shapes. Above the phone breakpoint it is the pills it
   always was. On a phone it is a single small button that says "Switch child"
   with the current first name and a chevron, and opens the phone's own
   picker: a native select, which the WebView renders as the platform sheet,
   needs no positioning, and is what a thumb expects. The two shapes are
   swapped by CSS so there is no layout jump on resize and no phone guessing
   in JavaScript.

   Only a guardian of more than one child ever sees either. A parent of one
   has nothing to switch to and is not shown a control that does nothing. */
export function ChildSwitch({
  kids,
  activeId,
  onChoose,
  label,
  switchLabel,
}: {
  kids: Pick<PortalChild, 'student_id' | 'full_name'>[]
  activeId: string | null | undefined
  onChoose: (id: string) => void
  /** Accessible name for the group and the select. */
  label: string
  /** The one word on the phone button, e.g. "Switch child". */
  switchLabel: string
}) {
  if (kids.length < 2) return null
  const first = (name: string) => name.split(' ')[0]
  const current = kids.find((c) => c.student_id === activeId) ?? kids[0]
  return (
    <>
      <div role="group" aria-label={label} className="parent-switch hidden sm:inline-flex">
        {kids.map((c) => (
          <button
            key={c.student_id}
            type="button"
            aria-pressed={c.student_id === activeId}
            onClick={() => onChoose(c.student_id)}
            className={cn('parent-switch__item', c.student_id === activeId && 'is-on')}
          >
            {first(c.full_name)}
          </button>
        ))}
      </div>
      {/* The phone shape: one small button, and the select laid over it so
          the tap opens the platform picker. The visible text is the button's;
          the select is transparent and full-size on top of it. */}
      <label className="parent-switch-small sm:hidden">
        <span className="parent-switch-small__label">{switchLabel}</span>
        <span className="parent-switch-small__name">{first(current.full_name)}</span>
        <ChevronDown className="parent-switch-small__chev" aria-hidden="true" />
        <select
          aria-label={label}
          value={current.student_id}
          onChange={(e) => onChoose(e.target.value)}
          className="parent-switch-small__select"
        >
          {kids.map((c) => (
            <option key={c.student_id} value={c.student_id}>
              {c.full_name}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}
