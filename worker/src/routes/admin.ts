import type { Router } from '../router'
import { registerAdminUsers } from './admin/users'
import { registerAdminSecurity } from './admin/security'
import { registerPlatformConfig } from './admin/platform_config'
import { registerAdminInbox } from './admin/inbox'
import { registerAdminOps } from './admin/admin_ops'
import { registerMessaging } from './admin/messaging'
import { registerMessagePlans } from './admin/msg_plans'
import { registerWhatsApp } from './admin/whatsapp'
import { registerSendDirect } from './admin/send_direct'
import { registerTallyConnector } from './admin/tally_connector'
import { registerPeriodCloses } from './admin/period_close'
import { registerReportDigest } from './admin/report_digest'
import { registerConnectors } from './admin/connectors'
import { registerPlatformGateways } from './admin/platform_gateways'
import { registerPlatformSignals } from './admin/platform_signals'
import { registerIntegrationsIndex } from './admin/integrations_index'
import { registerLoose } from './admin/loose'

/* /admin and /admin/inbox of internal/api/api.go, composed from the
   modules under admin/. Platform-level reads go to CONTROL. */
export function registerAdmin(r: Router): void {
  registerAdminUsers(r)
  registerAdminSecurity(r)
  registerPlatformConfig(r)
  registerAdminInbox(r)
  registerAdminOps(r)
  registerMessaging(r)
  registerMessagePlans(r)
  registerWhatsApp(r)
  registerSendDirect(r)
  registerTallyConnector(r)
  registerPeriodCloses(r)
  registerReportDigest(r)
  registerConnectors(r)
  registerPlatformGateways(r)
  registerPlatformSignals(r)
  registerIntegrationsIndex(r)
  registerLoose(r)
}
