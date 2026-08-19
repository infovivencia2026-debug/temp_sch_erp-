import { Field, Select } from '@/components/ui'
import type { ChildBusRow } from './child-bus'
import { childOptions, needsChildChoice } from './transport-prefs'

/* Which child a setting applies to.

   Both preference screens ask the same question and must ask it the same way,
   including not asking it: a family with one child on one bus is shown
   nothing at all here, because "all my children" and "Aarav" are the same
   answer for them and offering both invents a decision. */
export function ChildScope({
  rows,
  value,
  onChange,
  mixed,
}: {
  rows: ChildBusRow[]
  value: string
  onChange: (v: string) => void
  mixed: boolean
}) {
  if (!needsChildChoice(rows)) return null
  return (
    <Field
      label="Applies to"
      hint={
        mixed
          ? 'Your children are not all on the same setting at the moment, so the numbers below are one child’s. Saving with "All my children" gives every one of them the same setting.'
          : 'Saving against one child leaves your other children on whatever they have now.'
      }
    >
      <Select value={value} onChange={onChange} options={childOptions(rows)} />
    </Field>
  )
}
