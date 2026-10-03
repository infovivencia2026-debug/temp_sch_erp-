import { describe, it, expect } from 'vitest'
import { createLocalStore, memoryBackend } from './local-store'

describe('local store', () => {
  it('round-trips values and keeps them sealed', async () => {
    const b = memoryBackend()
    const s = createLocalStore(b)
    await s.set('x', { name: 'register' })
    expect(await s.get('x')).toEqual({ name: 'register' })
    const raw = await b.get('x')
    expect(new TextDecoder().decode(raw!.data)).not.toContain('register')
  })

  it('drops the least recently used past the cap', async () => {
    const s = createLocalStore(memoryBackend(), 300)
    await s.set('a', 'x'.repeat(100))
    await s.set('b', 'x'.repeat(100))
    await s.get('a') // a is now newer than b
    await s.set('c', 'x'.repeat(100))
    expect((await s.keys()).sort()).toEqual(['a', 'c'])
    expect(await s.size()).toBeLessThanOrEqual(300)
  })

  it('wipes data and key, so nothing old can be read', async () => {
    const b = memoryBackend()
    const s = createLocalStore(b)
    await s.set('a', 1)
    const old = await b.get('a')
    await s.wipe()
    expect(await s.keys()).toEqual([])
    expect(await b.loadKey()).toBeUndefined()
    await s.set('z', 2) // new key
    await b.put(old!, { k: 'a', size: 1, at: 0 })
    expect(await s.get('a')).toBeUndefined()
  })
})
