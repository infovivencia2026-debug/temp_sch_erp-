import { lazy } from 'react'
import Bundle from '@/components/Bundle'

/* The finance workspace, grouped by the job rather than by the screen.
 *
 * Forty-five catalogue entries became eleven. Nothing was deleted: every screen
 * below is the same screen it was, reached through an entry that names what
 * somebody came to do. A cashier opening "Take fee payment" is no longer
 * choosing between that and fee structure versioning.
 *
 * Each tab is loaded on first open, so an entry with six screens behind it
 * costs one screen to look at.
 */

const Defaulters = lazy(() => import('./Defaulters'))
const LateFineRules = lazy(() => import('./LateFineRules'))
const PDCRegister = lazy(() => import('./PDCRegister'))

const FeeStructureVersions = lazy(() => import('./FeeStructureVersions'))
const DemandGeneration = lazy(() => import('./DemandGeneration'))
const Concessions = lazy(() => import('./Concessions'))
const ReceiptSeries = lazy(() => import('./ReceiptSeries'))

const CanteenTerminal = lazy(() => import('./CanteenTerminal'))
const SchoolStore = lazy(() => import('./SchoolStore'))

const GrantInAid = lazy(() => import('./GrantInAid'))
const ScholarshipReconciliation = lazy(() => import('./ScholarshipReconciliation'))
const GovernmentClaims = lazy(() => import('./GovernmentClaims'))
const LoanAssistance = lazy(() => import('./LoanAssistance'))

const Payroll = lazy(() => import('../payroll/Payroll'))
const BankingPayouts = lazy(() => import('./BankingPayouts'))

const Payables = lazy(() => import('./Payables'))
const PettyCash = lazy(() => import('./PettyCash'))
const Expenses = lazy(() => import('./Expenses'))

const Budgets = lazy(() => import('./Budgets'))
const FixedAssets = lazy(() => import('./FixedAssets'))

const BankReconciliation = lazy(() => import('./BankReconciliation'))
const StudentBankAccounts = lazy(() => import('./StudentBankAccounts'))

const CashBooks = lazy(() => import('./CashBooks'))
const GeneralLedger = lazy(() => import('./GeneralLedger'))
const ChartOfAccounts = lazy(() => import('./ChartOfAccounts'))
const TaxAudit = lazy(() => import('./TaxAudit'))
const YearClosing = lazy(() => import('./YearClosing'))
const TallyExport = lazy(() => import('./TallyExport'))

// Late payers first: this entry is opened to chase somebody, and the fine rules
// and the cheque register are what you set up once so the chasing works.
export function UnpaidFees() {
  return (
    <Bundle
      tabs={[
        { key: 'defaulters', label: 'Who has not paid', Screen: Defaulters },
        { key: 'fines', label: 'Late fine rules', note: 'What a late payment costs, and after how long.', Screen: LateFineRules },
        { key: 'cheques', label: 'Cheques', note: 'Post-dated cheques and the ones that bounced.', Screen: PDCRegister },
      ]}
    />
  )
}

export function FeeSetup() {
  return (
    <Bundle
      tabs={[
        { key: 'structure', label: 'Fee structure', note: 'Tuition, lab, transport and the rest, per class.', Screen: FeeStructureVersions },
        { key: 'invoices', label: 'Raise the demand', note: 'Turn the structure into invoices for the year.', Screen: DemandGeneration },
        { key: 'concessions', label: 'Concessions & refunds', Screen: Concessions },
        { key: 'receipts', label: 'Receipt numbering', note: 'The GST-compliant series receipts are issued from.', Screen: ReceiptSeries },
      ]}
    />
  )
}

export function CampusSales() {
  return (
    <Bundle
      tabs={[
        { key: 'cafeteria', label: 'Cafeteria', Screen: CanteenTerminal },
        { key: 'store', label: 'Store & uniforms', Screen: SchoolStore },
      ]}
    />
  )
}

// Money from outside the school, kept away from tuition on purpose: a grant
// that lands in the fee ledger is a grant nobody can account for separately
// when the giver asks how it was spent.
export function DonationsAndAid() {
  return (
    <Bundle
      tabs={[
        { key: 'grants', label: 'Grant-in-aid', Screen: GrantInAid },
        { key: 'scholarships', label: 'Scholarships', note: 'NSP disbursements matched against students.', Screen: ScholarshipReconciliation },
        { key: 'claims', label: 'Government claims', Screen: GovernmentClaims },
        { key: 'loans', label: 'Education loans', Screen: LoanAssistance },
      ]}
    />
  )
}

export function SalaryPayout() {
  return (
    <Bundle
      tabs={[
        { key: 'payroll', label: 'The payroll run', note: 'What HR calculated, before the money moves.', Screen: Payroll },
        { key: 'payouts', label: 'Release the money', note: 'The bank file, and what has already gone out.', Screen: BankingPayouts },
      ]}
    />
  )
}

export function VendorsAndPettyCash() {
  return (
    <Bundle
      tabs={[
        { key: 'vendors', label: 'Vendor bills', Screen: Payables },
        { key: 'petty-cash', label: 'Petty cash', Screen: PettyCash },
        { key: 'expenses', label: 'Expenses', Screen: Expenses },
      ]}
    />
  )
}

export function PropertyAndBudget() {
  return (
    <Bundle
      tabs={[
        { key: 'budget', label: 'Budget', note: 'What was planned, against what has been spent.', Screen: Budgets },
        { key: 'assets', label: 'Property & assets', note: 'Buses, computers, furniture, and what they are worth now.', Screen: FixedAssets },
      ]}
    />
  )
}

export function MatchBankRecords() {
  return (
    <Bundle
      tabs={[
        { key: 'statement', label: 'Bank statement', note: 'The passbook against what the software recorded.', Screen: BankReconciliation },
        { key: 'student-accounts', label: 'Student bank accounts', Screen: StudentBankAccounts },
      ]}
    />
  )
}

export function AccountingReports() {
  return (
    <Bundle
      tabs={[
        { key: 'daybook', label: 'Daybook & cashbook', Screen: CashBooks },
        { key: 'ledger', label: 'Ledger & trial balance', Screen: GeneralLedger },
        { key: 'accounts', label: 'Chart of accounts', Screen: ChartOfAccounts },
        { key: 'tax', label: 'Tax & audit', Screen: TaxAudit },
        { key: 'closing', label: 'Year closing', Screen: YearClosing },
        { key: 'tally', label: 'Export to Tally', note: 'One click, for the school’s accountant.', Screen: TallyExport },
      ]}
    />
  )
}
