/* ONE CONTRACT FOR EVERY NATIVE SHELL.

   The Android app, the iOS app and the desktop app all wrap this same site
   and expose `window.ErpShell`. This file is the contract (docs/native-shell.md
   says the same in prose, per platform). Every member is optional: a browser
   has none, an older app build has some, and the site feature-detects each
   one through `can()` rather than asking which platform it is on.

   Calls into the shell are synchronous and return at once. Answers that take
   time (a photo picked, a file saved for offline, a share from another app,
   a deep link, the network coming and going) come back as one DOM event,
   `erp-shell`, with `detail: { type, ... }`. iOS and desktop deliver it with
   window.dispatchEvent; Android with evaluateJavascript. */

export interface PickedFile {
  name: string
  type: string
  /** base64 of the bytes; files are capped by the shell at 20 MB. */
  data: string
}

export type ShellEvent =
  | { type: 'picked'; id: string; files: PickedFile[] }
  | { type: 'share'; files: PickedFile[]; text?: string }
  | { type: 'downloaded'; id: string; url: string; ok: boolean; local?: string }
  | { type: 'deeplink'; path: string }
  | { type: 'connectivity'; online: boolean }
  | { type: 'push'; token: string }

export interface ErpShell {
  /** 'android' | 'ios' | 'desktop'. */
  platform?: string
  /** Contract version; 2 is everything below. */
  contract?: number

  // --- since version 1 ---------------------------------------------------
  setAtTop?(v: boolean): void
  setGestureLock?(on: boolean): void
  /** App lock with the phone's fingerprint or face (features/portal/AppLock.tsx). */
  setAppLock?(on: boolean): void
  appLockEnabled?(): boolean
  biometricsAvailable?(): boolean
  haptic?(kind: string): void
  /** The device's push token (FCM / APNs), or null until there is one. */
  pushToken?(): string | null
  print?(): void
  setPageColor?(css: string): void

  // --- version 2 ---------------------------------------------------------
  /** 32 random bytes, base64, kept in the platform keystore (Android
      Keystore, iOS Keychain, Electron safeStorage). Seals lib/local-store.ts. */
  storeKey?(): string | null
  /** Delete what the shell keeps for this person: offline files, queued
      uploads, its copy of the outbox. Called on a remote wipe. */
  wipe?(): void
  /** The number on the app icon (launcher badge, iOS badge, dock / taskbar). */
  setBadge?(n: number): void
  /** A system notification, for shells without server push (desktop). */
  notify?(title: string, body: string, href: string): void
  /** Camera, document scan or file picker; answered by a 'picked' event. */
  pickFile?(id: string, kind: 'camera' | 'scan' | 'file', accept: string): void
  /** Open in the system browser or the app that owns the link. */
  openExternal?(url: string): void
  /** Save a lesson file or video for offline; answered by 'downloaded'. */
  download?(id: string, url: string, name: string): void
  /** The local address of a saved file, or null. */
  downloaded?(url: string): string | null
  removeDownload?(url: string): void
  /** The writes waiting in the outbox, as JSON, so the shell can send them
      in the background (WorkManager, BGTaskScheduler) with the same
      idempotency keys. The page's own replay then gets the stored answer. */
  outboxChanged?(json: string): void
  /** Generic app: the school this install is pointed at, as JSON
      { code, name, host }, and a way back to the school picker. */
  school?(): string | null
  switchSchool?(): void
  /** Generic app, from the /start screen: keep this school's app.json and
      open it. */
  setSchool?(json: string): void
}

declare global {
  interface Window {
    ErpShell?: ErpShell
  }
}

export function shell(): ErpShell | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.ErpShell
  } catch {
    return undefined
  }
}

/** Whether this shell offers one capability. */
export function can<K extends keyof ErpShell>(k: K): boolean {
  const s = shell()
  return !!s && typeof s[k] === 'function'
}

/** Listen for one kind of answer from the shell. */
export function onShell<T extends ShellEvent['type']>(
  type: T,
  fn: (e: Extract<ShellEvent, { type: T }>) => void,
): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<ShellEvent>).detail
    if (d && d.type === type) fn(d as Extract<ShellEvent, { type: T }>)
  }
  window.addEventListener('erp-shell', h)
  return () => window.removeEventListener('erp-shell', h)
}

let seq = 0
const nextId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`

function toFile(p: PickedFile): File {
  const bin = atob(p.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], p.name, { type: p.type || 'application/octet-stream' })
}

/** A photo, a scanned page or a file from the native picker. Undefined when
    the shell has no picker; the caller then uses an ordinary file input. */
export function pickNative(kind: 'camera' | 'scan' | 'file', accept = '*/*'): Promise<File[]> | undefined {
  const s = shell()
  if (!s?.pickFile) return undefined
  const id = nextId()
  return new Promise((resolve) => {
    const off = onShell('picked', (e) => {
      if (e.id !== id) return
      off()
      resolve(e.files.map(toFile))
    })
    s.pickFile!(id, kind, accept)
  })
}

/** Save a file for offline use in the shell's own cache. */
export function saveForOffline(url: string, name: string): Promise<boolean> {
  const s = shell()
  if (!s?.download) return Promise.resolve(false)
  const id = nextId()
  return new Promise((resolve) => {
    const off = onShell('downloaded', (e) => {
      if (e.id !== id) return
      off()
      resolve(e.ok)
    })
    s.download!(id, new URL(url, location.href).href, name)
  })
}

/** Shared into the app from another app, waiting for the person to choose
    where it goes (components/ShareInbox.tsx). */
export interface Shared { files: File[]; text?: string; target?: 'status' }
let shared: Shared | null = null
const shareListeners = new Set<() => void>()
export function takeShared() {
  const s = shared
  shared = null
  shareListeners.forEach((fn) => fn())
  return s
}
export function peekShared() {
  return shared
}
/** The person chose where the shared files go; that screen takes them. */
export function aimShared(target: Shared['target']) {
  if (shared) shared = { ...shared, target }
  shareListeners.forEach((fn) => fn())
}
export function onShared(fn: () => void) {
  shareListeners.add(fn)
  return () => {
    shareListeners.delete(fn)
  }
}

/** Wires the shell's events into the app. Called once from main. */
export function startShell(navigate: (path: string) => void) {
  if (typeof window === 'undefined') return
  onShell('connectivity', (e) => window.dispatchEvent(new Event(e.online ? 'online' : 'offline')))
  onShell('deeplink', (e) => {
    if (e.path.startsWith('/') && !e.path.startsWith('//')) navigate(e.path)
  })
  onShell('share', (e) => {
    shared = { files: e.files.map(toFile), text: e.text }
    shareListeners.forEach((fn) => fn())
  })
}
