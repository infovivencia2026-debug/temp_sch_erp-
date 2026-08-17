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

/** Looks up a feature across the active role by section + feature slug. */
export function useFeature(sectionSlug?: string, featureSlug?: string) {
  const role = useActiveRole()
  return useMemo(() => {
    if (!role) return { section: undefined, feature: undefined }
    const section = role.sections.find((s) => s.slug === sectionSlug) ?? role.sections[0]
    if (!section) return { section: undefined, feature: undefined }
    const feature = featureSlug
      ? section.features.find((f) => f.slug === featureSlug)
      : section.features[0]
    return { section, feature }
  }, [role, sectionSlug, featureSlug])
}

/** Path helper so links are built in one place. */
export function featurePath(roleKey: string, sectionSlug: string, featureSlug: string) {
  return `/${roleKey}/${sectionSlug}/${featureSlug}`
}
