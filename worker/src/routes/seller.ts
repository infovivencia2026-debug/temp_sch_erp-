import type { Router } from '../router'
import { registerSellerTenants } from './seller/tenants'
import { registerSellerPlatform } from './seller/platform'

/* Port of the /seller group in internal/api/api.go (lines 1387-1445): the
   vendor's own back office. The Go group guarded everything with
   platform.tenants.write via r.Use; here every route carries that key and
   each handler re-checks that the caller is the platform, as the Go
   handlers did, so a school admin holding the key by accident is refused. */
export function registerSeller(r: Router): void {
  registerSellerTenants(r)
  registerSellerPlatform(r)
}
