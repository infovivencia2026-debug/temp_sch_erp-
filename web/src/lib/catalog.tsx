import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
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

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api.get<CatalogResponse>('/api/v1/catalog'),
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
 * Resolves the active role from the URL, falling back to the first role the
 * user holds. A URL naming a role they do not hold resolves to the fallback
 * rather than rendering an empty shell.
 */
export function useActiveRole(): ApiRole {
  const { roleKey } = useParams()
  const catalog = useCatalog()
  return useMemo(() => {
    const match = catalog.roles.find((r) => r.key === roleKey)
    return match ?? catalog.roles[0]
  }, [catalog.roles, roleKey])
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
  const role = useActiveRole()
  return useMemo(() => {
    const section = role?.sections.find((s) => s.slug === sectionSlug)
    const feature = section?.features.find((f) => f.slug === featureSlug)
    return { section, feature }
  }, [role, sectionSlug, featureSlug])
}

/** Looks up a feature across the active role by section + feature slug. */
export function useFeature(sectionSlug?: string, featureSlug?: string) {
  const role = useActiveRole()
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
