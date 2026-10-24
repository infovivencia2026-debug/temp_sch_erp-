import { useSessionIfAny } from '@/lib/session'

/* What the signed-in vendor login may do on the console, so a screen hides
   the controls the server would refuse. Mirrors VENDOR_ROLES in
   worker/src/identity.ts, which is what actually decides: seller_admin and
   super_admin do everything; each area role does its own part. */

export type VendorAction =
  | 'act_in_school'   // open a school as its administrator
  | 'suspend'         // suspend, reactivate, change a plan
  | 'bulk'            // bulk plan change, reminder, announcement
  | 'setup'           // new school, branding, administrator password
  | 'groups_features' // school groups and feature switches

const AREA: Record<string, VendorAction[]> = {
  billing: ['suspend', 'bulk'],
  onboarding: ['setup'],
  sales: [],
  support_lead: [],
}

export function vendorCan(roles: string[], action: VendorAction): boolean {
  if (roles.includes('seller_admin') || roles.includes('super_admin')) return true
  return roles.some((r) => AREA[r]?.includes(action))
}

export function useVendorCan(): (action: VendorAction) => boolean {
  const roles = useSessionIfAny()?.user?.roles ?? []
  // An older server reports every platform login as platform_admin: treat it as the operator it was.
  const legacy = roles.length === 1 && roles[0] === 'platform_admin'
  return (action) => legacy || vendorCan(roles, action)
}
