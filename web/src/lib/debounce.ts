import { useEffect, useState } from 'react'

/* A TYPED SEARCH IS ONE QUESTION, NOT ONE PER LETTER.

   Every search box on the app put the raw input into a query key, so typing
   "ramesh" asked the server six times and threw five answers away. On a
   server billed per request that is five bills for nothing anyone saw.

   `useDebouncedValue(value)` trails the input by a quarter of a second: it
   returns the last value that has been still for `ms`. Key the query on the
   returned value and the input stays live while the server hears only the
   pauses. The first value is returned at once, so a screen that opens with a
   search already in hand does not wait for it. */
export function useDebouncedValue<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (Object.is(settled, value)) return
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
    // `settled` is deliberately left out: it is the output, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ms])
  return settled
}
