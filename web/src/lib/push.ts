import { api } from './api'

/* THE PHONE'S TOKEN, HANDED TO THE SERVER ONCE PER PERSON.

   Only inside the installed app: the bridge is absent in every browser and in
   the installable web app, so this is a no-op everywhere else and there is no
   branch to keep in step. The app owns the token; the site's only job is to
   tell the server which account is signed in on this phone, so the pump knows
   whose alerts to send here.

   Sent once per (user, token) and remembered, because the session is read on
   every launch and a PUT on every launch is noise. A new token or a new
   person both change the key and go up again. */
const KEY = 'erp.push.registered'

export function registerPushToken(userID?: string) {
  if (!userID) return
  let token: string | null = null
  try {
    token = window.ErpShell?.pushToken?.() ?? null
  } catch {
    return
  }
  if (!token) return
  const mark = `${userID}:${token}`
  try {
    if (localStorage.getItem(KEY) === mark) return
  } catch {
    /* fall through and register anyway */
  }
  api
    .put('/api/v1/me/push-token', { token, platform: 'android' })
    .then(() => {
      try {
        localStorage.setItem(KEY, mark)
      } catch {
        /* remembered next time */
      }
    })
    .catch(() => {
      /* the next launch tries again */
    })
}
