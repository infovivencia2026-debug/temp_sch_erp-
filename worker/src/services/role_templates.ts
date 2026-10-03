import { PERMISSIONS, ROLES } from './provision_seed'

/* ROLE TEMPLATES: the vendor's version of each built-in school role's
   permissions (CONTROL platform_role_templates, migration 0014). A role with
   no row uses the code's list (provision_seed ROLES). Read by provisioning
   for every new school, and pushed to existing schools from seller Controls,
   which never touches a school's role the school has customised
   (roles.customised_at) unless the vendor names that school. */

/** The roles a school is given; the vendor's own platform roles are not among them. */
export const SCHOOL_ROLES = ROLES
export const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p[0]))

/** role key -> permissions, for the roles the vendor has edited. Empty when the table is not there yet. */
export async function roleTemplates(control: D1Database): Promise<Map<string, string[]>> {
  try {
    const rows = (await control.prepare(`SELECT role_key, permissions FROM platform_role_templates`).all<{ role_key: string; permissions: string }>()).results
    const out = new Map<string, string[]>()
    for (const r of rows) {
      try {
        const p = JSON.parse(r.permissions)
        if (Array.isArray(p)) out.set(r.role_key, p.filter((x): x is string => typeof x === 'string' && PERMISSION_SET.has(x)))
      } catch { /* a broken row is ignored: the built-in list applies */ }
    }
    return out
  } catch { return new Map() }
}
