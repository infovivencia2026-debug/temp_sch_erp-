import { describe, expect, it, vi } from 'vitest'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { optimisticOptions, type OptimisticConfig } from './optimistic'

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
