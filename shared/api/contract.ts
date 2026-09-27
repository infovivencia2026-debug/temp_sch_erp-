/* The API contract's building blocks. Types only: this package has no runtime
   code and no dependencies, so the web bundle and the Worker bundle can both
   import it without either pulling anything in.

   Read docs/cloudflare-stack.md, "Adding or changing an endpoint". */

/** A whole list in one answer. Never a bare array: screens read `.items`. */
export interface List<T> { items: T[] }

/* One page of a list, and the way to the next one.

   `limit` is the size of THIS response, not a ceiling on what the caller can
   reach: follow `next_cursor` and the list continues.

   `total` is optional because counting is not free: the server sends it on
   the first page and may omit it thereafter. Absent is not zero.

   `has_more` is a fact about the rows (the server fetches one more than it
   returns), so it stays right on pages that carry no total. */
export interface Page<T> {
  items: T[]
  total?: number
  limit: number
  offset: number
  has_more: boolean
  /** Feed back as `cursor`. Empty or absent means this was the last page. */
  next_cursor?: string
}

/** The acknowledgement most writes answer with. */
export interface Ok { ok: true }

/** Query-string values as a caller may pass them; undefined/'' are dropped. */
export type QueryValue = string | number | boolean | undefined | null

/** One endpoint: what goes in, what comes out. `query` and `body` are optional. */
export interface Endpoint {
  query?: Record<string, QueryValue>
  body?: unknown
  res: unknown
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** "{id}" placeholders in a route pattern, as an object type. */
export type PathParams<P extends string> =
  P extends `${string}{${infer K}}${infer Rest}` ? { [k in K]: string } & PathParams<Rest> : unknown
