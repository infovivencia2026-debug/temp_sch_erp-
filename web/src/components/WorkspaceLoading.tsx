import { readSchoolMark } from '@/lib/brand'
import './workspace-loading.css'

/* The workspace opening (workspace-loading.css says why and how).

   Rendered by SessionProvider for the one request that decides who this is,
   and for 400ms after it answers so the app fades in under it rather than
   snapping.

   WHITE LABEL. It wears the school, not the product: the school's logo and
   name as the last session on this device left them (lib/brand.ts
   readSchoolMark). A device that has never signed in shows no name at all,
   only the light, rather than the product's name to a school's families. */
export function WorkspaceLoading({
  leaving = false,
  label = 'Opening your workspace',
}: {
  leaving?: boolean
  /** The line under the rule: what is being waited for. */
  label?: string
}) {
  const mark = readSchoolMark()
  /* White unless this person has chosen a theme that is dark. A first visit,
     or someone who never picked, gets white whatever their machine prefers. */
  let dark = false
  try {
    const raw = localStorage.getItem('erp.theme')
    const t = raw ? JSON.parse(raw) : null
    dark = t === 'dark' || (t === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)
  } catch { /* private mode: white */ }
  const initials = mark?.name
    .split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
  return (
    <div
      className="ws-opening"
      data-leaving={leaving ? '' : undefined}
      data-dark={dark ? '' : undefined}
      role="status"
      aria-live="polite"
      aria-label={leaving ? undefined : label}
    >
      <span className="ws-glow" aria-hidden="true" />
      <div className="ws-mark">
        {mark && (
          <div className="ws-logo" aria-hidden="true">
            {mark.logo ? <img src={mark.logo} alt="" /> : <span>{initials}</span>}
          </div>
        )}
        {mark && <p className="ws-word">{mark.name}</p>}
        <div className="ws-rule" aria-hidden="true" />
        <p className="ws-sub">{label}</p>
      </div>
    </div>
  )
}
