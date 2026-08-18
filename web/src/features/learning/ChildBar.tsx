import { Field, Select } from '@/components/ui'
import { childOptions, type PortalChild } from './use-student'

/* The sibling picker, rendered only when there is a choice to make.

   Eleven screens in this folder need it and each one writing its own Select
   would be eleven chances to default to the eldest child. A student never sees
   it at all: their set is one record and being asked which of themselves they
   meant is how a portal feels like it was built for somebody else. */
export function ChildBar({
  kids,
  value,
  onChange,
}: {
  kids: PortalChild[]
  value: string
  onChange: (v: string) => void
}) {
  if (kids.length <= 1) return null
  return (
    <Field label="Child" hint="Each child has their own record; pick whose screen this is.">
      <Select
        value={value}
        onChange={onChange}
        options={childOptions(kids)}
        placeholder="Choose a child…"
      />
    </Field>
  )
}
