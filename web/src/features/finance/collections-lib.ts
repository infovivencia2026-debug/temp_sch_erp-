import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'

/* Shared vocabulary for the three collections screens.

   Money formatting re-exports ledger-lib's rather than defining a second one.
   A canteen cash-up sits two menu items from the cashbook, and a figure that
   groups differently on one screen than on the other is how a bursar stops
   trusting both. */

export { inr, rupees, toPaise, fyLabel, currentFY, fyOptions } from './ledger-lib'

export const collectionsBase = '/api/v1/finance/collections'

/* One query key prefix for all three screens.

   Everything under ['collections'] so a mutation anywhere invalidates the
   subtree in one line. Ringing up a sale changes the session's takings, the
   stock on the product list, the child's fee account and the day's sales
   list; a screen that invalidated only the list it happened to be looking at
   would show a shirt still on the shelf after it had been sold. */
export const collectionsKey = 'collections'

// --- settings ----------------------------------------------------------------

export interface CollectionsSettings {
  canteen_fee_head_id?: string
  canteen_fee_head_name?: string
  store_fee_head_id?: string
  store_fee_head_name?: string
  variance_tolerance_paise: number
  grant_liability_account_id?: string
  grant_liability_account_name?: string
  grant_bank_account_id?: string
  grant_bank_account_name?: string
}

export function useCollectionsSettings() {
  return useQuery({
    queryKey: [collectionsKey, 'settings'],
    queryFn: () => api.get<CollectionsSettings>(`${collectionsBase}/settings`),
  })
}

// --- counters ----------------------------------------------------------------

export type TerminalKind = 'canteen' | 'store'

export interface PosTerminal {
  id: string
  code: string
  name: string
  kind: TerminalKind
  location?: string
  is_active: boolean
  /** Set while somebody has the drawer open. */
  open_since?: string
  open_by?: string
}

export function useTerminals(kind: TerminalKind) {
  return useQuery({
    queryKey: [collectionsKey, 'terminals', kind],
    queryFn: () =>
      api.get<List<PosTerminal>>(`${collectionsBase}/terminals?kind=${kind}&active=true`),
  })
}

// --- till sessions -----------------------------------------------------------

export interface TillSession {
  id: string
  terminal_id: string
  terminal_name: string
  terminal_kind: TerminalKind
  opened_by: string
  opened_at: string
  opening_float_paise: number
  status: 'open' | 'closed'
  closed_by?: string
  closed_at?: string
  counted_cash_paise?: number
  expected_cash_paise?: number
  paid_out_paise: number
  variance_paise: number
  variance_reason?: string
  cash_sales_paise: number
  cash_returns_paise: number
  account_sales_paise: number
  sale_count: number
  return_count: number
  variance_tolerance_paise: number
}

export function useTillSessions(kind: TerminalKind, status?: string) {
  const qs = new URLSearchParams({ kind })
  if (status) qs.set('status', status)
  return useQuery({
    queryKey: [collectionsKey, 'sessions', kind, status ?? 'all'],
    queryFn: () => api.get<List<TillSession>>(`${collectionsBase}/sessions?${qs}`),
  })
}

export function useTillSession(id: string | null) {
  return useQuery({
    queryKey: [collectionsKey, 'session', id],
    queryFn: () =>
      api.get<{ session: TillSession; sales: PosSale[] }>(
        `${collectionsBase}/sessions/${id}`,
      ),
    enabled: !!id,
  })
}

export interface VarianceRow {
  session_id: string
  terminal_name: string
  terminal_kind: TerminalKind
  opened_by: string
  closed_at: string
  expected_cash_paise: number
  counted_cash_paise: number
  variance_paise: number
  variance_reason?: string
}

export interface VarianceReport {
  items: VarianceRow[]
  variance_tolerance_paise: number
  total_short_paise: number
  total_over_paise: number
  from: string
  to: string
}

export function useVarianceReport(kind: TerminalKind) {
  return useQuery({
    queryKey: [collectionsKey, 'variance', kind],
    queryFn: () =>
      api.get<VarianceReport>(`${collectionsBase}/sessions/variance?kind=${kind}`),
  })
}

/* The live expected cash for an open drawer.

   The server freezes this figure at close and that frozen one is what a
   session is judged on; this is the same arithmetic shown while the till is
   still open, so a cashier counting up is not typing into the dark. The two
   agree by construction: float in, cash out, refunds and paid-outs off.

   Account sales are deliberately absent. That money never entered the drawer. */
export function expectedCash(s: TillSession, paidOutPaise = 0) {
  return s.opening_float_paise + s.cash_sales_paise - s.cash_returns_paise - paidOutPaise
}

// --- sales -------------------------------------------------------------------

export type PaymentMode = 'cash' | 'account'

export interface PosSaleLine {
  id: string
  line_no: number
  variant_id?: string
  item_name: string
  category: string
  variant_label?: string
  quantity: number
  unit_paise: number
  discount_paise: number
  tax_paise: number
  line_paise: number
  returned_quantity: number
}

export interface PosSale {
  id: string
  kind: 'sale' | 'return'
  channel: TerminalKind
  session_id: string
  terminal_name: string
  original_sale_id?: string
  student_id?: string
  student_name?: string
  buyer_name?: string
  sold_at: string
  sold_on: string
  payment_mode: PaymentMode
  subtotal_paise: number
  discount_paise: number
  tax_paise: number
  total_paise: number
  receipt_no: string
  invoice_id?: string
  invoice_no?: string
  sold_by?: string
  remarks?: string
  lines?: PosSaleLine[]
}

export function usePosSales(channel: TerminalKind) {
  return useQuery({
    queryKey: [collectionsKey, 'sales', channel],
    queryFn: () => api.get<List<PosSale>>(`${collectionsBase}/sales?channel=${channel}`),
  })
}

export function usePosSale(id: string | null) {
  return useQuery({
    queryKey: [collectionsKey, 'sale', id],
    queryFn: () => api.get<PosSale>(`${collectionsBase}/sales/${id}`),
    enabled: !!id,
  })
}

/** One line as the counter is building it, before it is sent. */
export interface DraftLine {
  key: string
  variantId?: string
  itemName: string
  category: string
  quantity: number
  unitPaise: number
  discountPaise: number
  taxRateBP: number
}

/* What a draft line will cost, computed the way the server computes it.

   Integer paise, and tax rounded half up on the discounted line -- the same
   expression as colResolveLines in internal/api/collections.go. Two roundings
   that disagree would show the parent one total on the screen and print
   another on the receipt, which is the defect nobody reports and everybody
   notices. */
export function draftLineTotal(l: DraftLine) {
  const gross = l.unitPaise * l.quantity
  const net = Math.max(0, gross - l.discountPaise)
  const tax = Math.floor((net * l.taxRateBP + 5000) / 10000)
  return { gross, net, tax, total: net + tax }
}

export function draftTotals(lines: DraftLine[]) {
  return lines.reduce(
    (acc, l) => {
      const t = draftLineTotal(l)
      return {
        subtotal: acc.subtotal + t.gross,
        discount: acc.discount + Math.min(l.discountPaise, t.gross),
        tax: acc.tax + t.tax,
        total: acc.total + t.total,
      }
    },
    { subtotal: 0, discount: 0, tax: 0, total: 0 },
  )
}

export const CANTEEN_CATEGORIES = [
  { value: 'meal', label: 'Meal' },
  { value: 'snack', label: 'Snack' },
  { value: 'beverage', label: 'Beverage' },
  { value: 'dessert', label: 'Dessert' },
  { value: 'fruit', label: 'Fruit' },
  { value: 'other', label: 'Other' },
]

// --- the store catalogue -----------------------------------------------------

export interface StoreProduct {
  id: string
  code: string
  name: string
  category: string
  hsn_code?: string
  tax_rate_bp: number
  sale_price_paise: number
  return_window_days?: number
  is_active: boolean
  variant_count: number
  on_hand: number
}

export interface StoreVariant {
  id: string
  product_id: string
  product_name: string
  item_id: string
  item_code: string
  size?: string
  colour?: string
  variant_note?: string
  price_paise: number
  tax_rate_bp: number
  on_hand: number
  is_active: boolean
  /** "32 / White", assembled server-side so the receipt and this agree. */
  label: string
}

export const PRODUCT_CATEGORIES = [
  { value: 'uniform', label: 'Uniform' },
  { value: 'book', label: 'Book' },
  { value: 'stationery', label: 'Stationery' },
  { value: 'sports', label: 'Sports' },
  { value: 'other', label: 'Other' },
]

export function useStoreProducts() {
  return useQuery({
    queryKey: [collectionsKey, 'products'],
    queryFn: () => api.get<List<StoreProduct>>(`${collectionsBase}/products`),
  })
}

export function useStoreVariants(productId?: string) {
  const qs = productId ? `?product_id=${productId}&active=true` : '?active=true'
  return useQuery({
    queryKey: [collectionsKey, 'variants', productId ?? 'all'],
    queryFn: () => api.get<List<StoreVariant>>(`${collectionsBase}/variants${qs}`),
  })
}

export interface InventoryItem {
  id: string
  code: string
  name: string
  on_hand: number
  /** Already some other variant's shelf. One item, one variant. */
  taken: boolean
}

/* The stores items a variant can be attached to.

   Read-only, and served by this feature rather than by the stores module so a
   finance clerk setting up a uniform price list does not need the stores
   permission. It creates nothing: the stock rows are the stores module's and
   always were, and a screen here that could make them would be a second stores
   screen with no purchase order behind it. */
export function useInventoryItems() {
  return useQuery({
    queryKey: [collectionsKey, 'stock-items'],
    queryFn: () => api.get<List<InventoryItem>>(`${collectionsBase}/stock-items`),
  })
}

// --- grant-in-aid ------------------------------------------------------------

export const GRANT_CATEGORIES = [
  { value: 'salary', label: 'Salary' },
  { value: 'non_salary', label: 'Non-salary' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'contingency', label: 'Contingency' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'other', label: 'Other' },
]

export interface GrantHead {
  id: string
  code: string
  name: string
  category: string
  expense_account_id?: string
  expense_account_name?: string
  is_post_based: boolean
  is_active: boolean
  notes?: string
}

export function useGrantHeads() {
  return useQuery({
    queryKey: [collectionsKey, 'grant-heads'],
    queryFn: () => api.get<List<GrantHead>>(`${collectionsBase}/grants/heads`),
  })
}

export interface GrantSanction {
  id: string
  head_id: string
  head_name: string
  head_code: string
  category: string
  fy_start_year: number
  fy_label: string
  sanction_no: string
  sanction_date: string
  authority?: string
  scheme_name?: string
  sanctioned_paise: number
  sanctioned_posts?: number
  opening_unspent_paise: number
  received_paise: number
  utilised_paise: number
  /** Sanction plus carry-forward, less what is booked: what may still be spent. */
  available_paise: number
  /** Received plus carry-forward, less utilised: the cash still in hand. */
  unspent_paise: number
  /** Sanctioned but not yet released by the treasury. */
  awaited_paise: number
  utilisation_pct: number
  status: string
  receipt_count: number
  expenditure_count: number
  notes?: string
}

export function useGrantSanctions(fy: number) {
  return useQuery({
    queryKey: [collectionsKey, 'sanctions', fy],
    queryFn: () => api.get<List<GrantSanction>>(`${collectionsBase}/grants/sanctions?fy=${fy}`),
  })
}

export interface GrantReceipt {
  id: string
  received_on: string
  amount_paise: number
  mode: string
  reference_no?: string
  bank_label?: string
  voucher_no?: string
  remarks?: string
}

export interface GrantExpenditure {
  id: string
  spent_on: string
  amount_paise: number
  particulars: string
  voucher_ref?: string
  source_kind?: string
  voucher_no?: string
}

export function useGrantSanction(id: string | null) {
  return useQuery({
    queryKey: [collectionsKey, 'sanction', id],
    queryFn: () =>
      api.get<{
        sanction: GrantSanction
        receipts: GrantReceipt[]
        expenditures: GrantExpenditure[]
      }>(`${collectionsBase}/grants/sanctions/${id}`),
    enabled: !!id,
  })
}

export interface UtilisationLine {
  sanction_id: string
  head_name: string
  sanction_no: string
  opening_unspent_paise: number
  sanctioned_paise: number
  received_paise: number
  utilised_paise: number
  unspent_paise: number
}

export interface UtilisationReport {
  items: UtilisationLine[]
  fy_start_year: number
  fy_label: string
  opening_unspent_paise: number
  sanctioned_paise: number
  received_paise: number
  utilised_paise: number
  unspent_paise: number
  awaited_paise: number
}

export function useGrantUtilisation(fy: number) {
  return useQuery({
    queryKey: [collectionsKey, 'utilisation', fy],
    queryFn: () => api.get<UtilisationReport>(`${collectionsBase}/grants/utilisation?fy=${fy}`),
  })
}

export interface GrantCertificate {
  id: string
  certificate_no: string
  fy_start_year: number
  fy_label: string
  period_from: string
  period_to: string
  status: 'draft' | 'issued' | 'filed'
  issued_on?: string
  filed_on?: string
  filed_reference?: string
  opening_unspent_paise: number
  sanctioned_paise: number
  received_paise: number
  utilised_paise: number
  unspent_paise: number
  unspent_disposition: 'pending' | 'carried_forward' | 'refunded' | 'none'
  refunded_on?: string
  refund_reference?: string
  certified_by?: string
  remarks?: string
  prepared_by?: string
  line_count: number
}

export const DISPOSITION_LABEL: Record<GrantCertificate['unspent_disposition'], string> = {
  pending: 'Not yet decided',
  carried_forward: 'Carried forward',
  refunded: 'Refunded to the treasury',
  none: 'Nothing unspent',
}

export function useGrantCertificates() {
  return useQuery({
    queryKey: [collectionsKey, 'certificates'],
    queryFn: () => api.get<List<GrantCertificate>>(`${collectionsBase}/grants/certificates`),
  })
}

export function useGrantCertificate(id: string | null) {
  return useQuery({
    queryKey: [collectionsKey, 'certificate', id],
    queryFn: () =>
      api.get<{ certificate: GrantCertificate; lines: UtilisationLine[] }>(
        `${collectionsBase}/grants/certificates/${id}`,
      ),
    enabled: !!id,
  })
}
