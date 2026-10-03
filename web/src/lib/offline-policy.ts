/* WHICH WRITES MAY WAIT FOR THE NETWORK.

   A queued write is sent later, possibly hours later, possibly after the
   server has moved on. That is fine for a register tick, a chat message or a
   diary note: the person's intent is still the intent tomorrow, and the
   server's answer decides if anything conflicts.

   It is not fine for money, identity or anything announced to families:
   a payment, issuing a login or a password, publishing results, an
   admission. A person must not believe those happened until the server says
   so. They are never queued, and their buttons say "Needs internet" while
   the device is offline (Button `needsNetwork`).

   Paths are matched after /api/v1. Anything not listed is not queued: a new
   screen's writes fail loudly offline until somebody decides they are safe. */

const NEVER = [
  /pay|payment|fee|invoice|receipt|refund|payroll|salary|wallet|upi/i,
  /login|password|credential|session|otp|invite|access/i,
  /publish|result|report-card|marksheet/i,
  /admission|enrol|enquir|application/i,
  /^\/(admin|seller|users)\b/,
]

const ALLOWED: RegExp[] = [
  // attendance marking
  /^\/attendance(\/|$|\?)/,
  /^\/classroom\/attendance(\/|$|\?)/,
  // homework set, submitted, marked
  /^\/homework(\/|$|\?)/,
  /^\/lms\/assignments\/[^/]+\/(grade|return)$/,
  /^\/portal\/lms\/assignments\/[^/]+\/submit$/,
  // chat and messages
  /^\/chat\//,
  /^\/portal\/messages(\/|$|\?)/,
  /^\/comms\/counselor\/threads\/[^/]+\/messages$/,
  // notes, remarks, diary
  /^\/teaching\/(remarks|ptm-notes)(\/|$)/,
  /^\/students\/notes(\/|$)/,
  /^\/portal\/diary(\/|$)/,
  // class status posts (media go up separately)
  /^\/status\/posts(\/|$)/,
  // LMS "I finished this"
  /^\/portal\/lms\/lessons\/[^/]+\/complete$/,
  // leave requests
  /^\/workflow\/leave$/,
  /^\/portal\/leave(\/|$)/,
  // the person's own settings
  /^\/portal\/preferences(\/|$)/,
  /^\/me\/(preferences|settings|appearance)(\/|$)/,
]

function apiPath(path: string): string {
  const p = path.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  return p.startsWith('/api/v1') ? p.slice('/api/v1'.length) : p
}

/** Whether a write to this path may be kept on the device and sent later. */
export function mayQueue(method: string, path: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return false
  const p = apiPath(path)
  if (NEVER.some((r) => r.test(p))) return false
  return ALLOWED.some((r) => r.test(p))
}
