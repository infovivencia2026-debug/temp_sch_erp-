/* What a help request carries about the device, gathered here and shown to
   the person before it is sent (Help Centre > Report a problem).

   Kept in memory only: the last few client errors and the last request the
   server refused or failed, with its error reference when it had one. Nothing
   is sent anywhere until the person presses Send. */
import type { HelpDiagnostics } from '@shared/api/feature_helpdesk'
import { currentLayout } from './layout'

const errors: string[] = []
let lastFailed: HelpDiagnostics['last_failed'] | undefined

export function noteClientError(message: string): void {
  const m = message.trim().slice(0, 300)
  if (!m || errors[errors.length - 1] === m) return
  errors.push(m)
  if (errors.length > 5) errors.shift()
}

export function noteFailedRequest(path: string, status: number, ref?: string): void {
  lastFailed = { path: path.replace(/\?.*$/, '').slice(0, 200), status, ref, at: new Date().toISOString() }
}

/** The newest error reference this tab was given, for the request form to offer. */
export const lastErrorRef = (): string | undefined => lastFailed?.ref

let listening = false
export function listenForClientErrors(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('error', (e) => noteClientError(String(e.message || e.error || 'error')))
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    noteClientError(r instanceof Error ? `${r.name}: ${r.message}` : String(r))
  })
}

function browserAndOs(ua: string): { browser: string; os: string } {
  const pick = (re: RegExp) => ua.match(re)?.[1]
  const browser = (pick(/Edg\/(\d+)/) && `Edge ${pick(/Edg\/(\d+)/)}`)
    || (pick(/SamsungBrowser\/(\d+)/) && `Samsung Internet ${pick(/SamsungBrowser\/(\d+)/)}`)
    || (pick(/Firefox\/(\d+)/) && `Firefox ${pick(/Firefox\/(\d+)/)}`)
    || (pick(/Chrome\/(\d+)/) && `Chrome ${pick(/Chrome\/(\d+)/)}`)
    || (pick(/Version\/(\d+)[.\d]* .*Safari/) && `Safari ${pick(/Version\/(\d+)/)}`)
    || 'Unknown browser'
  const os = /Android (\d+)/.test(ua) ? `Android ${pick(/Android (\d+)/)}`
    : /iPhone|iPad/.test(ua) ? `iOS ${(pick(/OS (\d+)_/) ?? '')}`.trim()
    : /Windows NT/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown'
  return { browser, os }
}

/** Everything the form shows under "Sent with your request". */
export function collectDiagnostics(route: string, role: string | undefined, language: string): HelpDiagnostics {
  const { browser, os } = browserAndOs(navigator.userAgent)
  const root = document.documentElement
  const build = document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src')?.match(/index-([\w-]+)\.js/)?.[1]
  return {
    route, role, language, browser, os,
    layout: currentLayout() === 'bento' ? 'Focus' : 'Work',
    theme: root.classList.contains('dark') ? 'Dark' : 'Light',
    app_version: build ?? 'development',
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    online: navigator.onLine,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || undefined,
    client_errors: errors.length ? [...errors] : undefined,
    last_failed: lastFailed,
  }
}
