import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'

/* Shared vocabulary for the three fee engine screens.

   They sit behind one API prefix because they are one argument: a structure is
   revised, the invoices already raised keep citing the version they were raised
   under, a fine computed on those invoices reads that version, and the receipt
   settling them carries a number an auditor will accept. The types below follow
   that chain, so a screen never has to reconstruct it. */

export const feeEngineBase = '/api/v1/finance/fee-engine'

/* Every query key starts with 'fee-engine' so one invalidation clears the lot.
   Activating a version changes what the fine preview will compute and what the
   structure list shows, and a screen that refreshed only its own card would
   show two disagreeing answers on one page. */
export const qk = {
  all: ['fee-engine'] as const,
  structures: ['fee-engine', 'structures'] as const,
  versions: (id: string) => ['fee-engine', 'versions', id] as const,
  rules: ['fee-engine', 'fine-rules'] as const,
  preview: (asOf: string, ruleId: string) => ['fee-engine', 'preview', asOf, ruleId] as const,
  charges: ['fee-engine', 'charges'] as const,
  series: ['fee-engine', 'series'] as const,
}

// --- fee structure versioning ------------------------------------------------

export interface VersionedStructure {
  id: string
  name: string
  class_name?: string
  academic_year?: string
  applies_to?: string
  is_active: boolean
  versions: number
  active_version?: number
  active_total_paise: number
  effective_from?: string
  draft_version?: number
  invoices_raised: number
}

export interface VersionItem {
  id: string
  fee_head_id: string
  fee_head: string
  instalment_no: number
  amount_paise: number
  due_on?: string
  /** The same head under the preceding version, so a revision reads as a change. */
  previous_paise?: number
}

export interface StructureVersion {
  id: string
  version_no: number
  status: 'draft' | 'active' | 'superseded'
  effective_from: string
  effective_to?: string
  revision_note?: string
  activated_at?: string
  activated_by?: string
  total_paise: number
  /** Invoices raised under this exact version. Non-zero means it is frozen. */
  invoice_count: number
  items: VersionItem[]
}

export interface FeeHeadOption {
  id: string
  name: string
  code: string
  is_taxable: boolean
  gst_rate_bp: number
  hsn_sac: string
}

export interface VersionHistory {
  structure: { id: string; name: string }
  items: StructureVersion[]
  heads: FeeHeadOption[]
}

export function useVersionedStructures() {
  return useQuery({
    queryKey: qk.structures,
    queryFn: () => api.get<List<VersionedStructure>>(`${feeEngineBase}/structures`),
  })
}

export function useStructureVersions(structureId: string) {
  return useQuery({
    queryKey: qk.versions(structureId),
    queryFn: () => api.get<VersionHistory>(`${feeEngineBase}/structures/${structureId}/versions`),
    enabled: !!structureId,
  })
}

// --- late fine rules ---------------------------------------------------------

export interface FineRule {
  id: string
  name: string
  campus_id?: string
  campus?: string
  fee_structure_id?: string
  fee_structure?: string
  fee_head_id?: string
  fee_head?: string
  kind: 'fixed' | 'per_day' | 'percent'
  grace_days: number
  amount_paise: number
  percent?: string
  cap_paise?: number
  compound_period: 'none' | 'weekly' | 'monthly'
  exempt_concession_kinds: string[]
  priority: number
  is_active: boolean
}

export interface FineRulesResponse {
  items: FineRule[]
  heads: FeeHeadOption[]
  kinds: string[]
  compound_periods: string[]
  concession_kinds: string[]
}

export interface FineStep {
  period: number
  basis_paise: number
  amount_paise: number
  note: string
}

export interface FineAssessment {
  invoice_id: string
  invoice_no: string
  student_id: string
  student_name: string
  rule_id?: string
  rule_name?: string
  fee_head_id?: string
  version_id?: string
  version_label?: string
  days_overdue: number
  basis_paise: number
  /** The total owed under the rule as at the as-of date. */
  amount_paise: number
  /** What applying now would add. This is the number that reaches the invoice. */
  delta_paise: number
  periods: number
  was_capped: boolean
  exempt: boolean
  reason: string
  steps?: FineStep[]
}

export interface FinePreview {
  items: FineAssessment[]
  as_of: string
  assessed: number
  chargeable: number
  exempt: number
  total_paise: number
}

export interface FineCharge {
  id: string
  invoice_no: string
  student_name: string
  admission_no: string
  rule_name: string
  fee_head?: string
  version?: string
  as_of: string
  days_overdue: number
  basis_paise: number
  amount_paise: number
  was_capped: boolean
  status: 'applied' | 'waived' | 'reversed'
  waived_reason?: string
  applied_at: string
  applied_by?: string
}

export function useFineRules() {
  return useQuery({
    queryKey: qk.rules,
    queryFn: () => api.get<FineRulesResponse>(`${feeEngineBase}/fine-rules`),
  })
}

/* The preview is a query, not a mutation, and that is the design.

   It computes and writes nothing, so it is safe to re-run, safe to cache, and
   safe to leave on screen while somebody reads the working. Applying is the
   only verb that costs a parent money, and it is a separate deliberate act. */
export function useFinePreview(asOf: string, ruleId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.preview(asOf, ruleId),
    queryFn: () =>
      api.get<FinePreview>(
        `${feeEngineBase}/fines/preview?as_of=${encodeURIComponent(asOf)}` +
          (ruleId ? `&rule_id=${encodeURIComponent(ruleId)}` : ''),
      ),
    enabled,
  })
}

export function useFineCharges() {
  return useQuery({
    queryKey: qk.charges,
    queryFn: () => api.get<List<FineCharge>>(`${feeEngineBase}/fines/charges`),
  })
}

// --- receipt numbering -------------------------------------------------------

export interface ReceiptSeries {
  kind: string
  prefix: string
  suffix: string
  padding: number
  next_value: number
  reset_yearly: boolean
  current_fy?: string
  format: string
  last_number?: string
  last_issued_at?: string
  /** What the next number will look like under the settings as they stand. */
  next_preview: string
}

export interface SeriesYear {
  fy: string
  issued: number
  first_seq: number
  last_seq: number
  /** Anything above zero is a hole an auditor will ask about. */
  gaps: number
}

export interface SeriesResponse {
  items: ReceiptSeries[]
  years: SeriesYear[]
  heads: FeeHeadOption[]
  current_fy: string
}

export function useReceiptSeries() {
  return useQuery({
    queryKey: qk.series,
    queryFn: () => api.get<SeriesResponse>(`${feeEngineBase}/receipt-series`),
  })
}

/** Every fee engine mutation invalidates the whole domain — see qk.all. */
export function useFeeEngineMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  onDone?: (result: TResult, args: TArgs) => void,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, args) => {
      qc.invalidateQueries({ queryKey: qk.all })
      onDone?.(result, args)
    },
  })
}

// --- presentation ------------------------------------------------------------

/** A GST rate is stored in basis points to stay integral: 1800 is 18.00%. */
export const gstPercent = (bp: number) => `${(bp / 100).toFixed(2)}%`

/** Basis points from a percentage typed into a form, without a float surprise. */
export const toBasisPoints = (v: string) => Math.round(Number(v || 0) * 100)

export const statusTone = (status: string): 'success' | 'warning' | 'neutral' =>
  status === 'active' ? 'success' : status === 'draft' ? 'warning' : 'neutral'

/** How a rule reads in one line, for a list that must be scannable. */
export function describeRule(r: FineRule, rupeesOf: (p: number) => string): string {
  const grace = r.grace_days > 0 ? `after ${r.grace_days} days` : 'from the due date'
  let charge: string
  switch (r.kind) {
    case 'per_day':
      charge = `${rupeesOf(r.amount_paise)} per day`
      break
    case 'percent':
      charge = `${Number(r.percent ?? 0)}% of the balance`
      break
    default:
      charge = rupeesOf(r.amount_paise)
  }
  const compound = r.compound_period === 'none' ? '' : `, ${r.compound_period}`
  const cap = r.cap_paise ? `, capped at ${rupeesOf(r.cap_paise)}` : ''
  return `${charge} ${grace}${compound}${cap}`
}
