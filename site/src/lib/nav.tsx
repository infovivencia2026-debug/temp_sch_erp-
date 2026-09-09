import { forwardRef } from 'react'
import {
  Link as RouterLink, NavLink as RouterNavLink, useNavigate as useRouterNavigate,
  useParams, type LinkProps, type NavLinkProps,
} from 'react-router-dom'
import { getActiveIndustryId, INDUSTRY_MAP } from '@/industries'

/* ---------------------------------------------------------------------------
   Every URL carries its vertical: /construction/projects/boq. That makes a
   link shareable and the back button truthful, but it would also mean writing
   the industry into 100-odd `to=` strings across the app.

   Instead these wrappers prefix an app-absolute path with the active industry
   at render time, so module code keeps writing `/projects` and never has to
   know which vertical it is running in. Import Link, NavLink and useNavigate
   from here rather than from react-router-dom.
   --------------------------------------------------------------------------- */

/** Paths that must stay outside a vertical. */
const isGlobal = (p: string) => p === '/' || p.startsWith('/?') || p.startsWith('/#')

export function industryPath(to: string, industryId = getActiveIndustryId()): string {
  if (!to.startsWith('/') || isGlobal(to)) return to
  const first = to.split('/')[1]?.split('?')[0]
  // Already scoped — don't double-prefix.
  if (first && INDUSTRY_MAP[first]) return to
  return `/${industryId}${to}`
}

/** The vertical named by the current URL, or null on the home page. */
export function useIndustryParam(): string | null {
  const { industryId } = useParams()
  return industryId && INDUSTRY_MAP[industryId] ? industryId : null
}

type To = string | { pathname: string; search?: string }

const resolve = (to: To): To =>
  typeof to === 'string' ? industryPath(to) : { ...to, pathname: industryPath(to.pathname) }

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(({ to, ...rest }, ref) => (
  <RouterLink ref={ref} to={resolve(to as To) as LinkProps['to']} {...rest} />
))
Link.displayName = 'Link'

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(({ to, ...rest }, ref) => (
  <RouterNavLink ref={ref} to={resolve(to as To) as NavLinkProps['to']} {...rest} />
))
NavLink.displayName = 'NavLink'

/** navigate() that scopes app-absolute paths the same way Link does. */
export function useNavigate() {
  const navigate = useRouterNavigate()
  return (to: To | number, opts?: { replace?: boolean }) => {
    if (typeof to === 'number') return navigate(to)
    return navigate(resolve(to) as any, opts)
  }
}
