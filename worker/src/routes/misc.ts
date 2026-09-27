import type { Router } from '../router'
import { registerProfile } from './misc/profile'
import { registerShell } from './misc/shell'
import { registerChat } from './misc/chat'
import { registerFiles } from './misc/files'
import { registerAssistant } from './misc/assistant'

/* The loose authenticated routes of internal/api/api.go: /profile and its
   MFA and device routes, the shell's ref-data / working-year / date-ranges /
   catalog, the store's shop window, /session/activity and /session/reauth,
   /chat, /staff-messages, /staff-remarks and /files, and the in-app
   assistant (/assistant/*, see misc/assistant.ts). */
export function registerMisc(r: Router): void {
  registerShell(r)
  registerProfile(r)
  registerChat(r)
  registerFiles(r)
  registerAssistant(r)
}
