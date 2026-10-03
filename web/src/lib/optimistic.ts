import { useMemo, useRef } from 'react'
import {
  useMutation, useQueryClient, type QueryClient, type QueryKey, type UseMutationOptions,
} from '@tanstack/react-query'
import { useToast } from '@/components/Toast'
import { optimisticBegin, optimisticEnd } from '@/lib/save-feedback'

/* SHOW IT, THEN DO IT (owner, 2026-10-01: "when stuff is sent to the backend,
   fake it -- show it, then do the work in the backend").

   For the frequent, low-risk writes -- a register tick, a notification read,
   a pin, a like -- the screen changes the moment it is pressed: the cached
   answer the screen is drawing from is rewritten in place (`apply`), the
   request goes out behind it, and the server's real answer replaces the
   guess when it lands (invalidate on settle, which also carries the D1
   bookmark forward so the next read sees this write).

   If the server refuses, the cache goes back to exactly what it was and a
   quiet error says what happened, with Retry. Nothing is left lying on
   screen. While a write is in flight the hairline at the top of the window
   (FetchBar, App.tsx) runs, which is the "Saving..." for a change that has
   already been drawn.

   NOT FOR: money (fees, receipts, refunds, payroll), identity (logins,
   passwords), publishing results, admissions -- anything a person must not
   believe happened until it did. Those keep a pending button and confirm
   after the server does. */

export interface OptimisticConfig<TVars, TData = unknown> {
  mutationFn: (vars: TVars) => Promise<TData>
  /** The cached queries the change shows in. Every cached entry under each
      key (prefix match) is rewritten by `apply`. */
  queryKeys: QueryKey[] | ((vars: TVars) => QueryKey[])
  /** The cache as it will be once the server agrees. Return `old` (or
      undefined) to leave an entry alone. Must not mutate `old`. */
  apply: (old: unknown, vars: TVars, key: QueryKey) => unknown
  /** Refetched once the server answers, success or not. Defaults to queryKeys. */
  invalidate?: QueryKey[] | ((vars: TVars) => QueryKey[])
  /** Said at once, on press, when the change itself is not visible enough. */
  confirm?: string | ((vars: TVars) => string)
  /** Lead of the error line: "Couldn't mark it read". The reason follows. */
  failure?: string
  onSuccess?: (data: TData, vars: TVars) => void
  /** After the cache is put back: for local state the caller cleared on
      press (a register's unsaved draft) and now wants back. */
  onError?: (err: unknown, vars: TVars) => void
}

export interface Snapshot {
  entries: [QueryKey, unknown][]
}

function keysOf<TVars>(k: QueryKey[] | ((v: TVars) => QueryKey[]), vars: TVars): QueryKey[] {
  return typeof k === 'function' ? k(vars) : k
}

/** Rewrite every cached entry under `keys`; return what was there. */
export async function applyOptimistic<TVars>(
  qc: QueryClient,
  keys: QueryKey[],
  apply: OptimisticConfig<TVars>['apply'],
  vars: TVars,
): Promise<Snapshot> {
  // A refetch landing after the guess would overwrite it with the old answer.
  await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })))
  const entries: [QueryKey, unknown][] = []
  for (const queryKey of keys) {
    for (const [key, old] of qc.getQueriesData({ queryKey })) {
      entries.push([key, old])
      if (old === undefined) continue
      const next = apply(old, vars, key)
      if (next !== undefined && next !== old) qc.setQueryData(key, next)
    }
  }
  return { entries }
}

/** Put every entry back exactly as it was. */
export function rollback(qc: QueryClient, snap: Snapshot | undefined) {
  for (const [key, old] of snap?.entries ?? []) qc.setQueryData(key, old)
}

function reason(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message
  }
  return typeof navigator !== 'undefined' && navigator.onLine === false ? 'You are offline.' : 'The server did not accept it.'
}

interface ToastLike {
  ok: (m: string, undo?: () => void) => void
  error: (m: string, retry?: () => void) => void
}

/** A write the API layer kept for later rather than one that failed. */
export function isQueued(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'queued_offline'
}

/** The mutation options, built without React so they can be tested. */
export function optimisticOptions<TVars, TData>(
  qc: QueryClient,
  cfg: OptimisticConfig<TVars, TData>,
  toast: ToastLike,
  retry: (vars: TVars) => void,
): UseMutationOptions<TData, unknown, TVars, Snapshot> {
  return {
    mutationFn: cfg.mutationFn,
    onMutate: async (vars) => {
      optimisticBegin()
      const snap = await applyOptimistic(qc, keysOf(cfg.queryKeys, vars), cfg.apply, vars)
      if (cfg.confirm) toast.ok(typeof cfg.confirm === 'function' ? cfg.confirm(vars) : cfg.confirm)
      return snap
    },
    onError: (err, vars, snap) => {
      /* Kept on the device for the outbox to send (lib/outbox.ts): the change
         stays on screen, with the outbox list showing it as waiting. */
      if (isQueued(err)) return
      rollback(qc, snap)
      cfg.onError?.(err, vars)
      toast.error(`${cfg.failure ?? "Couldn't save that"}, so it was put back. ${reason(err)}`, () => retry(vars))
    },
    onSuccess: (data, vars) => cfg.onSuccess?.(data, vars),
    onSettled: (_d, err, vars) => {
      optimisticEnd()
      if (isQueued(err)) return
      const keys = keysOf(cfg.invalidate ?? cfg.queryKeys, vars)
      return Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))).then(() => undefined)
    },
  }
}

export function useOptimisticMutation<TVars = void, TData = unknown>(cfg: OptimisticConfig<TVars, TData>) {
  const qc = useQueryClient()
  const toast = useToast()
  // `retry` needs the mutation's own mutate, which exists only after the hook runs.
  const ref = useMemo(() => ({ mutate: (_v: TVars) => {} }), [])
  const m = useMutation(optimisticOptions(qc, cfg, toast, (v) => ref.mutate(v)))
  ref.mutate = m.mutate
  return m
}

/* GONE AT ONCE, SENT IN A MOMENT.

   A delete that can be taken back needs no "Are you sure?": the row goes
   the instant it is pressed, a toast says so with Undo beside it, and the
   request leaves only once the Undo has been left unpressed. Undo puts the
   cache back exactly as it was and nothing was ever sent. Only for the
   low-risk lists -- a note, a status post, a pin -- where the worst case of
   a wrong press is five seconds of a row being absent.

   The delay is this window's, so a tab closed inside it would lose the
   delete the person watched happen: `pagehide` sends it early instead. A
   refetch landing inside the window (another screen invalidating the same
   key) can draw the row again until the delete lands; that is a flicker,
   not a lie, and the honest order -- shown, then done -- is kept. */
export const UNDO_MS = 5000

export interface UndoableConfig<TVars, TData = unknown> extends OptimisticConfig<TVars, TData> {
  /** The toast line Undo sits beside: "Note deleted". */
  undo: string | ((vars: TVars) => string)
  delayMs?: number
}

/** The remover, built without React so it can be tested. */
export function undoableDelete<TVars, TData>(
  qc: QueryClient,
  cfg: UndoableConfig<TVars, TData>,
  toast: ToastLike,
): (vars: TVars) => Promise<void> {
  const delay = cfg.delayMs ?? UNDO_MS
  const remove = async (vars: TVars) => {
    const snap = await applyOptimistic(qc, keysOf(cfg.queryKeys, vars), cfg.apply, vars)
    let settled = false
    const send = async () => {
      if (settled) return
      settled = true
      window.removeEventListener('pagehide', send)
      clearTimeout(timer)
      optimisticBegin()
      try {
        const data = await cfg.mutationFn(vars)
        cfg.onSuccess?.(data, vars)
      } catch (err) {
        if (isQueued(err)) return
        rollback(qc, snap)
        cfg.onError?.(err, vars)
        toast.error(`${cfg.failure ?? "Couldn't delete that"}, so it was put back. ${reason(err)}`, () => void remove(vars))
      } finally {
        optimisticEnd()
        const keys = keysOf(cfg.invalidate ?? cfg.queryKeys, vars)
        await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })))
      }
    }
    const timer = setTimeout(() => void send(), delay)
    window.addEventListener('pagehide', send)
    toast.ok(typeof cfg.undo === 'function' ? cfg.undo(vars) : cfg.undo, () => {
      if (settled) return
      settled = true
      window.removeEventListener('pagehide', send)
      clearTimeout(timer)
      rollback(qc, snap)
    })
  }
  return remove
}

export function useUndoableDelete<TVars = void, TData = unknown>(cfg: UndoableConfig<TVars, TData>) {
  const qc = useQueryClient()
  const toast = useToast()
  // The latest config is read at press time, never a stale closure's.
  const ref = useRef(cfg)
  ref.current = cfg
  return useMemo(() => {
    const live: UndoableConfig<TVars, TData> = {
      get mutationFn() { return ref.current.mutationFn },
      get queryKeys() { return ref.current.queryKeys },
      get apply() { return ref.current.apply },
      get invalidate() { return ref.current.invalidate },
      get failure() { return ref.current.failure },
      get onSuccess() { return ref.current.onSuccess },
      get onError() { return ref.current.onError },
      get undo() { return ref.current.undo },
      get delayMs() { return ref.current.delayMs },
    }
    return undoableDelete(qc, live, toast)
  }, [qc, toast])
}
