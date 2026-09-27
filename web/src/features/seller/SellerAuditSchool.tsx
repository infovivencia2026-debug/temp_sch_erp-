import { SellerAuditLog } from './SellerAuditLog'

/** Settings → Security, for a school's own administrator: what the vendor did in and to this school. */
export function SellerAuditSchool() {
  return <SellerAuditLog base="/api/v1/admin/security/seller-audit" showSchool={false} title="Actions by the software provider" />
}
