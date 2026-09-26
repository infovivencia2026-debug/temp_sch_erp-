import type { Router } from '../router'
import { registerBackoffice } from './fees/backoffice'
import { registerCounter } from './fees/counter'
import { registerInvoicing } from './fees/invoicing'
import { registerRefunds } from './fees/refunds'
import { registerReminders } from './fees/reminders'
import { registerLedgers } from './fees/ledgers'
import { registerFeeEngine } from './fees/fee_engine'
import { registerTally } from './fees/tally'
import { registerBanking } from './fees/banking'
import { registerConcessions } from './fees/concessions'
import { registerCollections } from './fees/collections'

/* Port of the /finance and /fees chi groups (api.go 831-919).

   /finance carried RequirePermission(finance.invoices.read) on the whole
   group; every handler there is wrapped in fin() from fees/common.ts so the
   group gate survives the worker's one-permission-per-route router.

   /fees is deliberately outside that gate: a parent reads their own child's
   ledger and wallet through the same endpoints, narrowed by scope
   (studentPredicate) rather than by a second read-only copy of the query.
   Money moves (/fees/payments, wallet top-ups and adjustments) also require
   a fresh sign-in (requireFresh), as RequireFresh did. */
export function registerFees(r: Router): void {
  // /finance — order follows mountLedgers, mountFeeEngine, mountTally,
  // mountBanking, mountConcessions, mountCollections, then the three reads.
  registerLedgers(r)
  registerFeeEngine(r)
  registerTally(r)
  registerBanking(r)
  registerConcessions(r)
  registerCollections(r)
  registerBackoffice(r)

  // /fees — the counter
  registerCounter(r)
  registerInvoicing(r)
  registerReminders(r)
  registerRefunds(r)
}
