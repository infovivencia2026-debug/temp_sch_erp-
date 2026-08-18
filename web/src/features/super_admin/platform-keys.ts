import { lazy } from 'react'

/**
 * The platform tier, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the seventeen components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Every key below was checked against internal/catalog/catalog_gen.go before
 * being written. A key the catalogue does not carry renders the placeholder
 * instead of the screen, silently — the screen is built, wired, and simply
 * never appears.
 *
 * Two pairs share a table and not a screen, which is deliberate:
 *
 *   Branding and White-Label Branding both edit branding_profiles. One is the
 *   school administrator picking a logo and a colour; the other is whoever
 *   controls DNS deciding what portal.stjohns.edu.in points at. Two jobs, two
 *   people, two screens.
 *
 *   Franchise Management sits under the seller directory even though its
 *   catalogue key is a Super Admin one, because a chain spans tenants and only
 *   the vendor can see across them. A member school reads its own agreement
 *   through GET /platform/franchise instead.
 */
export const platformKeys = {
  // Statutory & Boards
  'super_admin.statutory_boards.board_affiliation_disclosure': lazy(() => import('./BoardAffiliation')),
  'super_admin.statutory_boards.state_board_configuration': lazy(() => import('./StateBoardConfig')),
  'super_admin.statutory_boards.district_mandal_master': lazy(() => import('./DistrictMandalMaster')),
  'super_admin.statutory_boards.sqaa_framework_management': lazy(() => import('./SQAAFramework')),
  'super_admin.statutory_boards.school_management_type': lazy(() => import('./ManagementType')),

  // Campuses & Academic Year
  'super_admin.campuses_academic_year.academic_calendar_model': lazy(() => import('./CalendarModel')),
  'super_admin.campuses_academic_year.white_label_branding': lazy(() => import('./WhiteLabel')),
  'super_admin.campuses_academic_year.franchise_management': lazy(() => import('../seller/Franchises')),

  // Institution Setup
  'super_admin.institution_setup.branding': lazy(() => import('./Branding')),

  // Platform Configuration
  'super_admin.platform_configuration.numbering_templates': lazy(() => import('./Numbering')),

  // Operations
  'super_admin.operations.data_backup_restore': lazy(() => import('./BackupRestore')),

  // Access & Security
  'super_admin.access_security.sso_mfa': lazy(() => import('./SsoMfa')),

  // The vendor's own back office
  'seller_admin.support.support_tickets': lazy(() => import('../seller/SupportTickets')),
  'seller_admin.support.impersonation_audit': lazy(() => import('../seller/Impersonation')),
  'seller_admin.usage_health.adoption_metrics': lazy(() => import('../seller/Adoption')),
  'seller_admin.usage_health.instance_health': lazy(() => import('../seller/InstanceHealth')),
  'seller_admin.entitlements.module_entitlement_matrix': lazy(() => import('../seller/Entitlements')),
}
