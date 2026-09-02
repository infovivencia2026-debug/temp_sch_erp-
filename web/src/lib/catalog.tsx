import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useParams } from 'react-router-dom'
import { api } from './api'
import type { Scope, Tier } from '@/catalog.gen'

/* The server decides what this user can see. The generated catalog.gen.ts is
   only a type/shape reference for the client — never the authority — so
   revoking a grant takes effect on next load with no client release. */

export interface ApiFeature {
  key: string
  slug: string
  name: string
  summary: string
  scope: Scope
  tier: Tier
  in_scope: boolean
  live: boolean
}

export interface ApiSection {
  slug: string
  name: string
  /** The workspace this group belongs to — the level the sidebar lists. */
  workspace: string
  features: ApiFeature[]
}

export interface ApiRole {
  key: string
  name: string
  sections: ApiSection[]
}

export interface CatalogResponse {
  /* True while a required setup step is outstanding, and the reason most of
     the sections are missing from this response. Said on screen rather than
     leaving somebody to wonder where the product went. */
  setup_required?: boolean
  active_role: string
  roles: ApiRole[]
  scope: {
    platform_admin: boolean
    all_campuses: boolean
    campuses: number
    departments: number
    sections: number
    students: number
  }
  implemented: string[]
}

const CatalogContext = createContext<CatalogResponse | null>(null)

/* Whether the head is looking at the whole school or at their own desk.

   A principal holds every permission this product defines bar the two platform
   ones, so every screen already opens for them — what they lacked was a route
   to one that lives in somebody else's workspace. This is that route, and it
   is a mode rather than the default: thirteen workspaces in the switcher is
   not a day's work, it is an inspection.

   Remembered per browser, so a head who turned it on to check the fee counter
   does not find it off again after a reload — and it is off for everybody who
   has not asked, including the same head on their own machine tomorrow if they
   turn it off. */
const ALL_ROLES = 'erp.all_roles'

export function allRolesOn(): boolean {
  try {
    return localStorage.getItem(ALL_ROLES) === '1'
  } catch {
    // A browser that refuses storage gets the ordinary view, which is the
    // right thing to fall back to.
    return false
  }
}

export function setAllRoles(on: boolean) {
  try {
    if (on) localStorage.setItem(ALL_ROLES, '1')
    else localStorage.removeItem(ALL_ROLES)
  } catch {
    /* nothing to remember it in; the toggle lasts this page */
  }
  // The whole navigation is built from the catalogue, so it has to come again.
  window.location.reload()
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['catalog', allRolesOn()],
    queryFn: () => api.get<CatalogResponse>(
      '/api/v1/catalog' + (allRolesOn() ? '?all_roles=1' : '')),
    staleTime: 5 * 60_000,
  })

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
        Loading workspace…
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-[13px] text-destructive">
            {error instanceof Error ? error.message : 'Could not load your workspace.'}
          </p>
          <button
            onClick={() => location.reload()}
            className="mt-3 rounded-md bg-ink px-3 py-1.5 text-[13px] text-ink-foreground"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return <CatalogContext.Provider value={data}>{children}</CatalogContext.Provider>
}

export function useCatalog(): CatalogResponse {
  const ctx = useContext(CatalogContext)
  if (!ctx) throw new Error('useCatalog must be used inside CatalogProvider')
  return ctx
}

/**
 * The role the CHROME should draw itself as: from the URL where the URL names
 * one the account holds, and otherwise the first role the account holds.
 *
 * The fallback is kept deliberately, and is only correct for chrome. Anything
 * choosing what to RENDER at a URL must use useResolvedRole below, which
 * refuses to substitute a workspace the address bar did not name. See the long
 * note under it for what the substitution used to do to a URL.
 */
export function useActiveRole(): ApiRole {
  /* Read from the address, not from route params.

     useParams only answers inside the route that declares :roleKey, and the
     Shell — which draws the sidebar, the workspace name and the whole
     navigation — renders OUTSIDE the route tree. So it always got undefined
     and fell back to roles[0].

     Invisible while everybody held one role. The moment a principal switched
     to Faculty the address bar said /faculty/… and the sidebar still said
     Institution Admin, with the principal's own menu under it: they had
     reached another workspace and could not see it.

     The first path segment is the workspace by construction — every screen is
     /role/section/feature — so reading it works wherever this hook is called
     from. */
  const catalog = useCatalog()
  // Both hooks called unconditionally: `??` would make the second one
  // conditional on the first's value, which React forbids.
  const { role } = useResolvedRole()
  return role ?? catalog.roles[0]
}

/* THE SAME QUESTION, ANSWERED HONESTLY, FOR THE ONE CALLER THAT ROUTES ON IT.

   useActiveRole above ends `?? catalog.roles[0]`, and for the chrome that is
   the right answer: the sidebar, the workspace switcher and the launcher all
   have to draw something, and drawing the account's first workspace is a
   better failure than drawing nothing. For anything that DECIDES WHAT TO
   RENDER it was the wrong answer, and it was wrong in the same shape as the
   feature-level bug fixed in useFeature below.

   What it did: the first path segment is the workspace by construction, so
   /faculty/anything on an account that holds only institution_admin found no
   match, fell to roles[0], and quietly activated Institution Admin. The
   address bar still read /faculty. The sidebar read Institution Admin. Every
   screen under it resolved against the principal's catalogue, so a link
   copied out of somebody else's workspace did not fail, it silently became a
   different workspace's screen with the original URL still on display. On a
   school mid-setup, whose catalogue is deliberately cut down, this is how a
   URL for a workspace nobody holds still rendered a working product and left
   the reader believing they were somewhere they were not.

   WHY useParams AND NOT THE PATH is the whole of the fix. The fallback is
   legitimate and must stay legitimate for "/" (Home picks roles[0] itself),
   for /account, for /go/..., and for the Shell, which renders OUTSIDE the
   route tree and would otherwise lose its sidebar the moment anybody typed an
   unknown first segment. All of those have no :roleKey, because none of them
   matched a route that declares one. Only the three catalogue routes do. So
   `roleKey` being present is exactly the statement "the URL explicitly named
   a workspace", and only then is refusing to substitute another one correct.

   Returning role: undefined here is what lets RoleIndex and FeatureRoute say
   so, the same way returning undefined from useFeature is what finally let
   "That feature is not in your workspace" appear on screen. */
export function useResolvedRole(): { role: ApiRole | undefined; named: boolean } {
  const { roleKey } = useParams()
  const { pathname } = useLocation()
  const catalog = useCatalog()
  return useMemo(() => {
    if (roleKey) {
      // Named outright. Held or refused; never swapped for another.
      return { role: catalog.roles.find((r) => r.key === roleKey), named: true }
    }
    /* Off the catalogue routes. Read the first segment anyway, because the
       Shell asks this question from outside the route tree and would
       otherwise always get the fallback and always draw the wrong sidebar --
       which is the bug the comment below was written for. */
    const fromPath = pathname.split('/').filter(Boolean)[0]
    return {
      role: catalog.roles.find((r) => r.key === fromPath) ?? catalog.roles[0],
      named: false,
    }
  }, [catalog.roles, roleKey, pathname])
}

/* Usable means built, and in the caller's scope.

   The catalogue carries every feature a role is granted, built or not, because
   the roadmap toggle needs them. Anything that *chooses* a feature on the
   user's behalf has to skip the unbuilt ones, or landing on a workspace drops
   you on a placeholder that nothing in the navigation would have offered. */
export function usable(f: ApiFeature) {
  return f.live && f.in_scope
}

/** The first feature a role can actually open, searched across its sections. */
export function firstUsable(role: ApiRole | undefined) {
  if (!role) return undefined
  for (const section of role.sections) {
    const feature = section.features.find(usable)
    if (feature) return { section, feature }
  }
  return undefined
}

/* What the navigation called the thing you are looking at.

   Screens name themselves in their own PageHead, and those names drifted from
   the menu: a principal clicked "Certificates & transfers" under Students and
   landed on a page whose breadcrumb read "Administration / Certificates".
   Three different names for one screen — the one in the menu, the one in the
   heading, and the one search matches on — and only the catalogue's is used by
   anything other than the eye.

   So a screen can ask what it was called. Deliberately exact and silent: no
   falling back to the first feature of the section the way `useFeature` does,
   because a wrong name confidently displayed is worse than the screen's own
   hard-coded one. A component reached from several catalogue entries — and
   most of these are — gets the right name for the entry that was opened,
   which is something a literal string in the file cannot do.

   Returns undefineds off a catalogue route (/account, an unknown role); the
   caller keeps its own words for that case. */
export function useRouteFeature(): { section?: ApiSection; feature?: ApiFeature } {
  const { sectionSlug, featureSlug } = useParams()
  /* The resolved role rather than the chrome's, for the same reason this hook
     is exact about slugs: a name borrowed from a workspace the URL did not
     name is a wrong name confidently displayed. */
  const { role } = useResolvedRole()
  return useMemo(() => {
    const section = role?.sections.find((s) => s.slug === sectionSlug)
    const feature = section?.features.find((f) => f.slug === featureSlug)
    return { section, feature }
  }, [role, sectionSlug, featureSlug])
}

/** Looks up a feature across the active role by section + feature slug. */
export function useFeature(sectionSlug?: string, featureSlug?: string) {
  /* AND THE ROLE HALF OF THE SAME BUG.

     This asked useActiveRole, which never returns undefined, so a URL naming
     an unheld workspace arrived here already silently rewritten to the
     account's own first workspace -- and every lookup below then succeeded
     against the wrong catalogue. useResolvedRole hands back undefined for a
     workspace the URL named and the account does not hold, and the guard on
     the next line turns that into the miss FeatureRoute already knows how to
     say out loud. */
  const { role } = useResolvedRole()
  return useMemo(() => {
    if (!role) return { section: undefined, feature: undefined }

    // An exact request is honoured as asked -- a bookmark to an unbuilt screen
    // should say so rather than silently landing somewhere else.
    if (sectionSlug && featureSlug) {
      const section = role.sections.find((s) => s.slug === sectionSlug)
      if (section) {
        const feature = section.features.find((f) => f.slug === featureSlug)
        if (feature) return { section, feature }
      }
    }

    /* AND AN EXACT REQUEST THAT MISSES IS ALSO HONOURED - AS A MISS.

       The comment above states the rule and the code below broke it. When both
       slugs were given and neither matched, this fell through to
       firstUsable(role) and returned the workspace's own front page. So a URL
       naming a feature the role does not hold rendered the dashboard, headed
       "Executive overview", while the address bar still read
       /finance/fees/take_fee_payment. Verified with a control: /zzz/zzz/zzz
       rendered the same dashboard.

       The cost was not only the wrong screen. FeatureRoute in App.tsx has an
       EmptyState reading "That feature is not in your workspace" that could
       never appear, because this hook and useActiveRole between them
       guaranteed something non-undefined for every input. The honest message
       was written, and was unreachable.

       Returning undefined here is what lets that message show. */
    if (sectionSlug && featureSlug) {
      return { section: undefined, feature: undefined }
    }

    // Anything we choose ourselves lands on something that works.
    if (sectionSlug) {
      const section = role.sections.find((s) => s.slug === sectionSlug)
      const feature = section?.features.find(usable)
      if (section && feature) return { section, feature }
    }
    const first = firstUsable(role)
    if (first) return first
    return { section: role.sections[0], feature: undefined }
  }, [role, sectionSlug, featureSlug])
}

/** What a path is called, according to the catalogue.

    From the catalogue rather than from the rendered page, because a tab and a
    pane both need their label BEFORE the screen behind it has loaded; reading
    an <h1> would leave every freshly-opened one briefly blank and then jump.
    Falls back to the last path segment made readable, so a screen outside the
    catalogue — /account, say — is still named rather than shown as a URL. */
export function screenTitle(catalog: CatalogResponse, path: string): string {
  const [, roleKey, sectionSlug, featureSlug] = path.split('?')[0].split('/')
  for (const role of catalog.roles) {
    if (roleKey && role.key !== roleKey) continue
    for (const section of role.sections) {
      if (sectionSlug && section.slug !== sectionSlug) continue
      const f = section.features.find((x) => usable(x) && x.slug === featureSlug)
      if (f) return f.name
    }
  }
  const last = path.split('?')[0].split('/').filter(Boolean).pop() ?? 'Screen'
  return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Path helper so links are built in one place. */
export function featurePath(roleKey: string, sectionSlug: string, featureSlug: string) {
  return `/${roleKey}/${sectionSlug}/${featureSlug}`
}
