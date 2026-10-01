import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { optimisticOptions, undoableDelete, type OptimisticConfig, type UndoableConfig } from './optimistic'

type List = { items: { id: string; read: boolean }[] }

function setup(mutationFn: (v: string) => Promise<unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  qc.setQueryData<List>(['notes'], { items: [{ id: 'a', read: false }, { id: 'b', read: false }] })
  qc.setQueryData<List>(['notes', 'unread'], { items: [{ id: 'a', read: false }] })
  const toast = { ok: vi.fn(), error: vi.fn() }
  const retry = vi.fn()
  const cfg: OptimisticConfig<string> = {
    mutationFn,
    queryKeys: [['notes']],
    apply: (old, id) => ({ items: (old as List).items.map((n) => (n.id === id ? { ...n, read: true } : n)) }),
    failure: "Couldn't mark it read",
  }
  const obs = new MutationObserver(qc, optimisticOptions(qc, cfg, toast, retry))
  return { qc, toast, retry, obs }
}

describe('optimistic mutations', () => {
  it('draws the change before the server answers, on every entry under the key', async () => {
    let release!: () => void
    const { qc, obs } = setup(() => new Promise<void>((r) => { release = r }))
    const p = obs.mutate('a')
    await new Promise((r) => setTimeout(r, 0))
    expect(qc.getQueryData<List>(['notes'])!.items[0].read).toBe(true)
    expect(qc.getQueryData<List>(['notes', 'unread'])!.items[0].read).toBe(true)
    expect(qc.getQueryData<List>(['notes'])!.items[1].read).toBe(false)
    release()
    await p
  })

  it('puts everything back and offers Retry when the server refuses', async () => {
    const { qc, obs, toast, retry } = setup(() => Promise.reject(new Error('Forbidden')))
    await obs.mutate('a').catch(() => {})
    expect(qc.getQueryData<List>(['notes'])!.items[0].read).toBe(false)
    expect(qc.getQueryData<List>(['notes', 'unread'])!.items[0].read).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
    const [msg, again] = toast.error.mock.calls[0]
    expect(msg).toContain("Couldn't mark it read")
    expect(msg).toContain('Forbidden')
    again()
    expect(retry).toHaveBeenCalledWith('a')
  })

  it('invalidates the keys once settled, so the next read is the server', async () => {
    const { qc, obs } = setup(() => Promise.resolve({ ok: true }))
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await obs.mutate('b')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['notes'] })
    expect(qc.getQueryState(['notes'])!.isInvalidated).toBe(true)
  })
})

describe('undoable delete', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setupUndo(mutationFn: (id: string) => Promise<unknown>, delayMs = 5000) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData<List>(['notes'], { items: [{ id: 'a', read: false }, { id: 'b', read: false }] })
    const toast = { ok: vi.fn(), error: vi.fn() }
    const cfg: UndoableConfig<string> = {
      mutationFn,
      queryKeys: [['notes']],
      apply: (old, id) => ({ items: (old as List).items.filter((n) => n.id !== id) }),
      undo: 'Note deleted',
      failure: "Couldn't delete it",
      delayMs,
    }
    return { qc, toast, remove: undoableDelete(qc, cfg, toast) }
  }

  it('takes the row out at once and sends nothing until the Undo window has passed', async () => {
    const fn = vi.fn(() => Promise.resolve({}))
    const { qc, toast, remove } = setupUndo(fn)
    await remove('a')
    expect(qc.getQueryData<List>(['notes'])!.items.map((n) => n.id)).toEqual(['b'])
    expect(toast.ok).toHaveBeenCalledWith('Note deleted', expect.any(Function))
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4999)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledWith('a')
    expect(qc.getQueryState(['notes'])!.isInvalidated).toBe(true)
  })

  it('Undo puts the row back and the server is never asked', async () => {
    const fn = vi.fn(() => Promise.resolve({}))
    const { qc, toast, remove } = setupUndo(fn)
    await remove('a')
    const undo = toast.ok.mock.calls[0][1] as () => void
    undo()
    expect(qc.getQueryData<List>(['notes'])!.items.map((n) => n.id)).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(6000)
    expect(fn).not.toHaveBeenCalled()
    // A late Undo, after the delete went, is a no-op rather than a resurrection.
  })

  it('a refusal after the window puts the row back with Retry', async () => {
    const fn = vi.fn<(id: string) => Promise<unknown>>(() => Promise.reject(new Error('Forbidden')))
    const { qc, toast, remove } = setupUndo(fn, 10)
    await remove('b')
    await vi.advanceTimersByTimeAsync(20)
    expect(qc.getQueryData<List>(['notes'])!.items.map((n) => n.id)).toEqual(['a', 'b'])
    expect(toast.error).toHaveBeenCalledTimes(1)
    const [msg, again] = toast.error.mock.calls[0]
    expect(msg).toContain("Couldn't delete it")
    expect(msg).toContain('Forbidden')
    fn.mockImplementation(() => Promise.resolve({}))
    again()
    await vi.advanceTimersByTimeAsync(0)
    expect(qc.getQueryData<List>(['notes'])!.items.map((n) => n.id)).toEqual(['a'])
  })

  it('a tab going away sends the delete early rather than losing it', async () => {
    const fn = vi.fn(() => Promise.resolve({}))
    const { remove } = setupUndo(fn)
    await remove('a')
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
