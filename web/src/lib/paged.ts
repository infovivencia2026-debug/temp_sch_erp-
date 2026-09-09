import { useMemo } from 'react'
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query'

import { api, type Page } from './api'

/* A LIST THAT REACHES ITS END, HOWEVER LONG THE LIST IS.

   Every list screen here used to ask for one page and show it: `limit=500`,
   `limit=300`, `limit=15`. The number was always a guess about how big a
   school gets, and it was always wrong in the same direction -- a roll of 345
   read as 200, and nothing on the screen said so. There is no right number.
   A school of a million children should be able to reach the millionth.

   The answer is not a bigger request. It is to stop deciding up front: ask for
   a page, and ask for the next one when the reader moves. The server pages by
   keyset (see internal/api/students.go), so page five hundred costs the same
   as page one, and the cost of a long list is spread over the reading of it
   rather than paid in a single enormous answer nobody asked for.

   This is `useInfiniteQuery` with the two conventions of our envelope wired
   in, so no screen has to remember them:

     - `next_cursor` is the page token, and an empty one is THE END. Not
       `has_more`, not arithmetic on the total: one signal, checked in one
       place.
     - `total` arrives on the first page only, so it is read off page one and
       kept, rather than re-read from a later page that never carried it and
       collapsing to undefined halfway down the list. */

export interface PagedList<T> {
  /** Every row loaded so far, in the server's order, pages concatenated. */
  rows: T[]
  /** The count across the whole filtered set, once the first page said so. */
  total?: number
  /** Nothing has arrived yet. Show a skeleton, not an empty table. */
  isLoading: boolean
  /** A page after the first is on its way. Rows stay on screen. */
  isFetchingNextPage: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
  error: unknown
  refetch: () => void
}

export function usePagedList<T>(
  /** Endpoint path without a query string, e.g. `/api/v1/students`. */
  path: string,
  /* The filter, as the server takes it. It is also the cache key, so two
     screens asking the same question share one walk -- and changing a filter
     starts a NEW walk from the first page rather than continuing the old one
     part-way down a different row set, which is the mistake a cursor makes
     silently. */
  params: Record<string, string | undefined>,
  opts?: {
    /** Rows per request. A page size; it bounds one response, nothing else. */
    pageSize?: number
    /** Don't ask at all yet (no filter chosen, no permission, closed panel). */
    enabled?: boolean
    /** Extra cache-key segments, when the path and params do not tell it all. */
    key?: QueryKey
  },
): PagedList<T> {
  const pageSize = opts?.pageSize ?? 50

  /* Sorted, and undefined dropped.

     The params object is the cache key, and `{a, b}` and `{b, a}` are the same
     question. Without this a screen that builds its filter in a different
     order on a re-render walks the list again from the top. */
  const query = useMemo(() => {
    const qs = new URLSearchParams()
    for (const k of Object.keys(params).sort()) {
      const v = params[k]
      if (v != null && v !== '') qs.set(k, v)
    }
    qs.set('limit', String(pageSize))
    return qs.toString()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params), pageSize])

  const q = useInfiniteQuery<Page<T>>({
    queryKey: ['paged', path, query, ...(opts?.key ?? [])],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams(query)
      if (pageParam) qs.set('cursor', String(pageParam))
      return api.get<Page<T>>(`${path}?${qs.toString()}`)
    },
    /* Undefined is what tells TanStack the list is finished, and it has to be
       undefined rather than '' or the query reports hasNextPage forever and a
       scroll sentinel at the bottom fetches the same last page on a loop. */
    getNextPageParam: (last) => last.next_cursor || undefined,
    enabled: opts?.enabled ?? true,
  })

  const pages = q.data?.pages
  const rows = useMemo(() => (pages ?? []).flatMap((p) => p.items), [pages])

  return {
    rows,
    // Page one, and only page one, was counted. Later pages carry no total and
    // must not be read as having said zero.
    total: pages?.[0]?.total,
    isLoading: q.isPending && !q.data,
    isFetchingNextPage: q.isFetchingNextPage,
    hasNextPage: !!q.hasNextPage,
    fetchNextPage: () => { void q.fetchNextPage() },
    error: q.error,
    refetch: () => { void q.refetch() },
  }
}
