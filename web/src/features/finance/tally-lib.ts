import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * What the two Tally screens share.
 *
 * They are one feature with two entry points, so the types, the query keys and
 * the base paths live here rather than being restated in each screen. The
 * alternative — a connector that believes the mapping is complete and an export
 * that disagrees — is the exact failure the single backend was built to avoid,
 * and it would come straight back if each screen kept its own copy of the
 * shapes.
 */

/** The accountant's half, inside the /finance group. */
export const tallyExportBase = '/api/v1/finance/tally'
/** The vendor's half, under /admin. Platform permission, not a school's. */
export const tallyConnectorBase = '/api/v1/admin/tally/connector'

export const tallyQk = {
  all: ['tally'] as const,
  connector: ['tally', 'connector'] as const,
  accounts: (fy: string) => ['tally', 'connector', 'accounts', fy] as const,
  gateway: ['tally', 'connector', 'gateway'] as const,
  settings: ['tally', 'settings'] as const,
  runs: ['tally', 'runs'] as const,
  validate: (from: string, to: string, types: string, incl: boolean) =>
    ['tally', 'validate', from, to, types, incl] as const,
}

export interface TallySettings {
  company_name: string
  default_fy_start_year?: number
  fy_label?: string
  delivery: string
  is_enabled: boolean
  updated_at?: string
}

export interface TallyDelivery {
  key: string
  label: string
  live_push: boolean
}

export interface TallyAccount {
  id: string
  code: string
  name: string
  type: string
  tally_ledger_name?: string
  tally_parent_group?: string
  cost_centre?: string
  vouchers: number
}

export interface TallyVoucherType {
  voucher_type: string
  tally_voucher_type: string
}

export interface TallyConnector {
  settings: TallySettings
  voucher_types: TallyVoucherType[]
  mapped_accounts: number
  postable_accounts: number
  unmapped_accounts: number
  deliveries: TallyDelivery[]
  erp_voucher_types: string[]
  live_push_available: boolean
  live_push_note: string
}

export interface TallyGateway {
  gateway_url: string
  notes: string
  has_credentials: boolean
  live_push_available: boolean
  note: string
  updated_at?: string
}

export interface TallyExportSettings {
  settings: TallySettings
  fy: number
  fy_label: string
  suggested_from: string
  suggested_to: string
  unmapped_accounts: number
  configured: boolean
  deliveries: TallyDelivery[]
  live_push_available: boolean
  live_push_note: string
}

export interface TallyUnmappedAccount {
  account_id: string
  code: string
  name: string
  vouchers: number
}

export interface TallyUnmappedVoucherType {
  voucher_type: string
  vouchers: number
}

export interface TallyRun {
  id: string
  from_date: string
  to_date: string
  voucher_types: string[]
  company_name: string
  delivery: string
  voucher_count: number
  total_paise: number
  exported_at: string
  exported_by?: string
  confirmed_at?: string
}

export interface TallyValidation {
  ok: boolean
  blocking: string[]
  warnings: string[]
  company_name: string
  from_date: string
  to_date: string
  voucher_count: number
  total_paise: number
  unmapped_accounts: TallyUnmappedAccount[]
  unmapped_voucher_types: TallyUnmappedVoucherType[]
  already_exported: number
  new_vouchers: number
  overlapping_runs: TallyRun[]
}

export interface TallyExportCreated {
  run_id: string
  voucher_count: number
  total_paise: number
  company_name: string
  download_url: string
  note: string
}

/**
 * Every Tally mutation invalidates the whole domain.
 *
 * Saving a mapping changes what the export screen may do, and the two screens
 * are read by different people at the same desk. Narrower invalidation would
 * leave the export believing an account is still unmapped after somebody in
 * the next tab mapped it.
 */
export function useTallyMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  onDone?: (result: TResult, args: TArgs) => void,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, args) => {
      qc.invalidateQueries({ queryKey: tallyQk.all })
      onDone?.(result, args)
    },
  })
}

export function useTallyConnector() {
  return useQuery({
    queryKey: tallyQk.connector,
    queryFn: () => api.get<TallyConnector>(tallyConnectorBase),
  })
}

export function useTallyExportSettings() {
  return useQuery({
    queryKey: tallyQk.settings,
    queryFn: () => api.get<TallyExportSettings>(`${tallyExportBase}/settings`),
  })
}

/** The ERP voucher types, labelled the way a person reads them. */
export const VOUCHER_TYPE_LABELS: Record<string, string> = {
  journal: 'Journal',
  receipt: 'Receipt',
  payment: 'Payment',
  contra: 'Contra',
  purchase: 'Purchase',
  sales: 'Sales',
  depreciation: 'Depreciation',
  opening: 'Opening',
  closing: 'Closing',
}

export const voucherTypeLabel = (k: string) => VOUCHER_TYPE_LABELS[k] ?? k
