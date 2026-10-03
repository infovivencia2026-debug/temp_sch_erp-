/* WHAT THE DEVICE KEEPS SO THE APP OPENS WITH NO SIGNAL.

   One small store under every saved screen: the react-query cache
   (query-persist-idb.ts) and the boot snapshot (offline-boot.ts) both live
   here. Three properties, each for a reason a school has:

   ENCRYPTED AT REST. A phone is lost on a bus, a staffroom laptop is shared.
   Every value is sealed with AES-GCM under a key the page cannot read out:
   the native shell's keystore key when the app provides one
   (ErpShell.storeKey, docs/native-shell.md -- Android Keystore, iOS
   Keychain, Electron safeStorage), otherwise a WebCrypto key generated
   non-extractable and kept as an opaque CryptoKey object. Wiping deletes the
   key with the data, so anything that survived on disk is unreadable.

   CAPPED. A phone has little room. Past MAX_BYTES the least recently used
   entries go first.

   WIPED on sign-out and when the server says the session was ended from
   elsewhere (session.wipe). */

export const MAX_BYTES = 25 * 1024 * 1024

export interface Meta { k: string; size: number; at: number }
export interface Sealed { k: string; iv: Uint8Array; data: ArrayBuffer }

/** Where the bytes go. IndexedDB in the app; memory in tests. */
export interface Backend {
  get(k: string): Promise<Sealed | undefined>
  put(rec: Sealed, meta: Meta): Promise<void>
  touch(meta: Meta): Promise<void>
  del(k: string): Promise<void>
  index(): Promise<Meta[]>
  clear(): Promise<void>
  loadKey(): Promise<CryptoKey | undefined>
  saveKey(key: CryptoKey): Promise<void>
}

export interface LocalStore {
  get<T>(k: string): Promise<T | undefined>
  set(k: string, v: unknown): Promise<void>
  del(k: string): Promise<void>
  keys(): Promise<string[]>
  wipe(): Promise<void>
  /** Bytes held, for the settings screen and tests. */
  size(): Promise<number>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The shell's keystore key, when there is a shell that holds one. */
function shellKey(): Uint8Array | undefined {
  try {
    const raw = typeof window !== 'undefined' ? window.ErpShell?.storeKey?.() : undefined
    if (!raw) return undefined
    const bytes = b64ToBytes(raw)
    return bytes.length === 32 ? bytes : undefined
  } catch {
    return undefined
  }
}

export function createLocalStore(backend: Backend, maxBytes = MAX_BYTES): LocalStore {
  let keyP: Promise<CryptoKey> | undefined
  let idx: Map<string, Meta> | undefined

  function key(): Promise<CryptoKey> {
    keyP ??= (async () => {
      const fromShell = shellKey()
      if (fromShell) {
        return crypto.subtle.importKey('raw', fromShell as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
      }
      const have = await backend.loadKey()
      if (have) return have
      const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await backend.saveKey(made)
      return made
    })()
    keyP.catch(() => { keyP = undefined })
    return keyP
  }

  async function index(): Promise<Map<string, Meta>> {
    if (!idx) idx = new Map((await backend.index()).map((m) => [m.k, m]))
    return idx
  }

  async function evict(keep: string) {
    const m = await index()
    let total = 0
    for (const v of m.values()) total += v.size
    if (total <= maxBytes) return
    const oldest = [...m.values()].filter((v) => v.k !== keep).sort((a, b) => a.at - b.at)
    for (const v of oldest) {
      if (total <= maxBytes) break
      total -= v.size
      m.delete(v.k)
      await backend.del(v.k)
    }
  }

  /* Monotonic, so two writes in the same millisecond still order. */
  let last = 0
  const tick = () => (last = Math.max(last + 1, Date.now()))

  return {
    async get<T>(k: string) {
      const rec = await backend.get(k)
      if (!rec) return undefined
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource }, await key(), rec.data)
        const m = await index()
        const meta = m.get(k)
        if (meta) {
          meta.at = tick()
          void backend.touch(meta).catch(() => {})
        }
        return JSON.parse(dec.decode(plain)) as T
      } catch {
        /* Sealed under a key that is gone (a wipe, a reinstall of the app
           with a fresh keystore): unreadable, so it goes. */
        await this.del(k)
        return undefined
      }
    },
    async set(k, v) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), enc.encode(JSON.stringify(v)))
      const meta = { k, size: data.byteLength, at: tick() }
      await backend.put({ k, iv, data }, meta)
      ;(await index()).set(k, meta)
      await evict(k)
    },
    async del(k) {
      ;(await index()).delete(k)
      await backend.del(k)
    },
    async keys() {
      return [...(await index()).keys()]
    },
    async wipe() {
      idx = new Map()
      keyP = undefined
      await backend.clear()
    },
    async size() {
      let total = 0
      for (const v of (await index()).values()) total += v.size
      return total
    },
  }
}

/* ---- IndexedDB ---------------------------------------------------------- */

const DB = 'xulo-local'
const REC = 'rec'
const IDX = 'idx'
const KEYS = 'keys'

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

export function idbBackend(): Backend {
  let dbP: Promise<IDBDatabase> | undefined
  const db = () => {
    dbP ??= new Promise((res, rej) => {
      const open = indexedDB.open(DB, 1)
      open.onupgradeneeded = () => {
        const d = open.result
        d.createObjectStore(REC, { keyPath: 'k' })
        d.createObjectStore(IDX, { keyPath: 'k' })
        d.createObjectStore(KEYS)
      }
      open.onsuccess = () => res(open.result)
      open.onerror = () => rej(open.error)
    })
    return dbP
  }
  const tx = async (stores: string[], mode: IDBTransactionMode) => (await db()).transaction(stores, mode)
  const done = (t: IDBTransaction) => new Promise<void>((res, rej) => {
    t.oncomplete = () => res()
    t.onerror = () => rej(t.error)
    t.onabort = () => rej(t.error)
  })
  return {
    async get(k) { return req((await tx([REC], 'readonly')).objectStore(REC).get(k)) },
    async put(rec, meta) {
      const t = await tx([REC, IDX], 'readwrite')
      t.objectStore(REC).put(rec)
      t.objectStore(IDX).put(meta)
      await done(t)
    },
    async touch(meta) {
      const t = await tx([IDX], 'readwrite')
      t.objectStore(IDX).put(meta)
      await done(t)
    },
    async del(k) {
      const t = await tx([REC, IDX], 'readwrite')
      t.objectStore(REC).delete(k)
      t.objectStore(IDX).delete(k)
      await done(t)
    },
    async index() { return req((await tx([IDX], 'readonly')).objectStore(IDX).getAll()) },
    async clear() {
      const t = await tx([REC, IDX, KEYS], 'readwrite')
      t.objectStore(REC).clear()
      t.objectStore(IDX).clear()
      t.objectStore(KEYS).clear()
      await done(t)
    },
    async loadKey() { return req((await tx([KEYS], 'readonly')).objectStore(KEYS).get('aes')) },
    async saveKey(key) {
      const t = await tx([KEYS], 'readwrite')
      t.objectStore(KEYS).put(key, 'aes')
      await done(t)
    },
  }
}

/* ---- Memory (tests, and a browser with no IndexedDB) ------------------- */

export function memoryBackend(): Backend {
  const rec = new Map<string, Sealed>()
  const idx = new Map<string, Meta>()
  let k: CryptoKey | undefined
  return {
    async get(key) { return rec.get(key) },
    async put(r, m) { rec.set(r.k, r); idx.set(m.k, { ...m }) },
    async touch(m) { if (idx.has(m.k)) idx.set(m.k, { ...m }) },
    async del(key) { rec.delete(key); idx.delete(key) },
    async index() { return [...idx.values()].map((m) => ({ ...m })) },
    async clear() { rec.clear(); idx.clear(); k = undefined },
    async loadKey() { return k },
    async saveKey(key) { k = key },
  }
}

/* The one store the app uses. Undefined where nothing can be kept safely:
   no IndexedDB, or no WebCrypto (a page served over plain http). */
let shared: LocalStore | undefined | null = null
export function localStore(): LocalStore | undefined {
  if (shared !== null) return shared
  try {
    shared = typeof indexedDB !== 'undefined' && indexedDB && globalThis.crypto?.subtle
      ? createLocalStore(idbBackend())
      : undefined
  } catch {
    shared = undefined
  }
  return shared
}
