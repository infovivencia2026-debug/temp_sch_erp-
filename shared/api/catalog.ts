/* The menu: which features this user can open. internal/api/catalog.go. */

export interface CatalogFeature {
  key: string
  slug: string
  name: string
  summary: string
  /** catalog.gen.ts Scope / Tier on the web. */
  scope: string
  tier: string
  in_scope: boolean
  live: boolean
}

export interface CatalogSection {
  slug: string
  name: string
  /** The workspace this group belongs to — the level the sidebar lists. */
  workspace: string
  features: CatalogFeature[]
}

export interface CatalogRole {
  key: string
  name: string
  sections: CatalogSection[]
}

export interface CatalogResponse {
  /** True while a required setup step is outstanding (most sections are then missing). */
  setup_required?: boolean
  active_role: string
  roles: CatalogRole[]
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

export interface CatalogApi {
  'GET /catalog': { query: { all_roles?: '1' }; res: CatalogResponse }
}
