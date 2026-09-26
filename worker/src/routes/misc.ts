import type { Router } from '../router'
import { registerProfile } from './misc/profile'
import { registerShell } from './misc/shell'
import { registerChat } from './misc/chat'
import { registerFiles } from './misc/files'

/* The loose authenticated routes of internal/api/api.go: /profile and its
   MFA and device routes, the shell's ref-data / working-year / date-ranges /
   catalog, the store's shop window, /session/activity and /session/reauth,
   /chat, /staff-messages, /staff-remarks and /files. The assistant routes
   are archived and deliberately absent. */
export function registerMisc(r: Router): void {
  registerShell(r)
  registerProfile(r)
  registerChat(r)
  registerFiles(r)
}
