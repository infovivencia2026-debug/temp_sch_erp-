import type { Router } from '../router'
import { registerSellerLifecycle } from './seller/lifecycle'
import { registerSellerTenants } from './seller/tenants'
import { registerSellerPlatform } from './seller/platform'
import { registerSchoolGroups } from './seller/groups'
import { registerSellerProvisioning } from './seller/provisioning'
import { registerSellerFeatures } from './seller/features'
import { registerSellerAnnouncements } from './seller/announcements'
import { registerSchoolHealth } from './seller/health'
import { registerSellerBilling } from './seller/billing'
import { registerSellerOnboarding } from './seller/onboarding'
import { registerSellerControls } from './seller/controls'

/* Port of the /seller group in internal/api/api.go (lines 1387-1445): the
   vendor's own back office. The Go group guarded everything with
   platform.tenants.write via r.Use; here every route carries that key and
   each handler re-checks that the caller is the platform, as the Go
   handlers did, so a school admin holding the key by accident is refused. */
export function registerSeller(r: Router): void {
  registerSellerTenants(r)
  registerSellerProvisioning(r)
  registerSellerPlatform(r)
  // School groups; also /me/groups and /groups/{id}/dashboard for group admins (checked in the handlers).
  registerSchoolGroups(r)
  registerSellerFeatures(r)
  registerSellerAnnouncements(r)
  registerSchoolHealth(r)
  // Backups, restores, exports, off-boarding and the seller audit register.
  registerSellerLifecycle(r)
  // Billing (invoices, payments, renewal reminders, past_due/suspended) and the onboarding tracker.
  registerSellerBilling(r)
  registerSellerOnboarding(r)
  // Controls: every school setting, platform and plan defaults, role templates (docs/seller-controls.md).
  registerSellerControls(r)
}
