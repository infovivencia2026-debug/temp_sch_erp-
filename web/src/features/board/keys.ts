import { screen } from '@/lib/screen'

/* The board's workspace. Four of five screens are other roles' screens read
   without their controls — the permissions on the account are what remove the
   controls, not a second copy of the screen. Only the money sheet is its own. */
export const boardMemberKeys = {
  'board_member.home.where_the_money_goes': screen(() => import('./BoardMoney')),
  'board_member.money.fee_overview': screen(() => import('../analytics/FeeOverview')),
  'board_member.money.collections_dues': screen(() => import('../finance/Dashboard')),
  'board_member.reports.reports': screen(() => import('../shared/Exports')),
  'board_member.audit.audit_trail': screen(() => import('../super_admin/AuditLog')),
}
