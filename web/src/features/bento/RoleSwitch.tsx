import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, UserRound } from 'lucide-react'
import { useCatalog, useActiveRole, allRolesOn, setAllRoles } from '@/lib/catalog'
import { cn } from '@/lib/utils'

/* Which desk you are sitting at, from the dock.

   Focus hides the sidebar, and the sidebar was the only place a person could
   change workspace or ask to see every role. A principal in Focus therefore
   had to leave Focus, open the sidebar, switch, and come back. The same menu
   lives on the dock now: every workspace this account holds, a tick on the
   current one, and for the head the "View every role" switch that turns the
   whole building's desks into workspaces to step into.

   Drawn only when there is something to choose: two or more workspaces, or
   an account that may ask for every role. */
export function RoleSwitch({
  className,
  style,
  phone,
}: {
  className: string
  style?: CSSProperties
  phone: boolean
}) {
  const catalog = useCatalog()
  const role = useActiveRole()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  const head = catalog.roles.some((r) => r.key === 'institution_admin')
  const canSeeEveryRole = allRolesOn() || head

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (catalog.roles.length < 2 && !canSeeEveryRole) return null

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-tip={phone ? undefined : role?.name ?? 'Workspace'}
        aria-label={`Workspace: ${role?.name ?? 'choose'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={className}
        style={style}
      >
        <UserRound style={{ width: 'var(--dock-icon, 17px)', height: 'var(--dock-icon, 17px)' }} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Workspaces"
          className={cn(
            'absolute z-[70] w-64 overflow-hidden rounded-[10px] border bg-popover py-1 text-popover-foreground shadow-[var(--lift-float)]',
            phone ? 'bottom-full left-1/2 mb-2 -translate-x-1/2' : 'bottom-full left-0 mb-2',
          )}
        >
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Workspace
          </div>
          <div className="max-h-[50vh] overflow-auto">
            {catalog.roles.map((r) => (
              <button
                key={r.key}
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate(`/${r.key}`)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-accent',
                  r.key === role?.key ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="truncate">{r.name}</span>
                {r.key === role?.key && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
              </button>
            ))}
          </div>
          {head && (
            <button
              role="menuitem"
              type="button"
              onClick={() => setAllRoles(!allRolesOn())}
              className="mt-1 flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[13.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="truncate">{allRolesOn() ? 'Show only my workspace' : 'View every role'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
