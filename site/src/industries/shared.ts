import {
  BadgeCheck, Banknote, BarChart3, Briefcase, Building, CalendarClock, ClipboardList,
  Gauge, Handshake, Landmark, Lock, Plug, Receipt, Settings, ShoppingCart, Users, Wallet,
} from 'lucide-react'
import { type ModuleDef, t, customTab } from './types'

/* ---------------------------------------------------------------------------
   Every vertical in the suite shares the same back office: a ledger, payables,
   receivables, costing, tax, people, procurement and a commercial desk. These
   come straight from the common rows of the industry feature matrices, so they
   are defined once here and folded into each industry registry.

   The only thing that varies is naming — a hospital calls its counterparty a
   payer, a factory calls it a customer — so the labels are parameterised.
   --------------------------------------------------------------------------- */

export interface CommonOpts {
  /** What this industry calls the party that pays it. */
  customer: string
  /** Plural form used in tab labels. */
  customers: string
  /** What a revenue line is attached to (project, shipment, encounter, order). */
  jobLabel: string
}

export const GROUPS_TAIL = ['Finance', 'People', 'Supply Chain', 'Commercial', 'Intelligence', 'System']

/* ------------------------------------------------------------------ Finance */
export function financeModules(o: CommonOpts): ModuleDef[] {
  return [
    {
      id: 'ledger', label: 'General Ledger', icon: Landmark, group: 'Finance',
      primaryAction: 'New journal',
      tabs: [
        t('Chart of accounts', ['code:Account Code', 'text:Account@Cash & Bank,Trade Receivables,Trade Payables,Revenue,Direct Cost,Employee Benefits,Depreciation,Taxes,Retained Earnings', 'text:Type@Asset,Liability,Income,Expense,Equity', 'dept:Cost Centre', 'money:Balance', 'status:Status@Active,Frozen,Archived'], 46),
        t('Journal entries', ['id:Voucher No', 'date:Posting Date', 'text:Journal@Sales,Purchase,Payment,Receipt,Contra,Provision,Depreciation', 'text:Narration@Monthly accrual,Vendor settlement,Client receipt,Reclassification,Provision reversal', 'money:Debit', 'money:Credit', 'status:Status@Draft,Posted,Reversed'], 52),
        t('Multi-currency', ['code:Currency@USD,EUR,AED,GBP,SGD', 'text:Exposure@Receivable,Payable,Bank Balance', 'money:Foreign Value', 'money:INR Value', 'pct:Rate Movement', 'status:Revaluation@Pending,Posted'], 18),
        t('Period close', ['text:Period@Apr 2026,May 2026,Jun 2026,Jul 2026,Aug 2026', 'text:Checklist@Bank reconciliation,Inventory cut-off,Accruals,Depreciation run,Inter-company,Tax provision', 'person:Owner', 'date:Due', 'status:Status@Open,In Progress,Completed,Locked'], 30),
        t('Trial balance', ['code:Account Code', 'text:Head@Assets,Liabilities,Income,Expenses', 'money:Opening', 'money:Debit', 'money:Credit', 'money:Closing'], 40),
      ],
    },
    {
      id: 'payables', label: 'Accounts Payable', icon: Receipt, group: 'Finance',
      primaryAction: 'Record invoice',
      tabs: [
        t('Vendor invoices', ['id:Invoice No', 'vendor:Vendor', 'date:Invoice Date', 'datefuture:Due Date', 'money:Amount', 'money:Tax', 'status:Status@Received,Under Verification,Approved,Paid,On Hold,Disputed'], 54),
        t('Three-way match', ['id:Invoice No', 'vendor:Vendor', 'code:PO Ref', 'code:GRN Ref', 'money:PO Value', 'money:Invoice Value', 'status:Match@Matched,Quantity Variance,Price Variance,Blocked'], 34),
        t('Payment runs', ['id:Run ID', 'date:Run Date', 'int:Invoices', 'money:Total Value', 'text:Mode@NEFT,RTGS,Cheque,UPI', 'person:Approved By', 'status:Status@Draft,Approved,Released,Failed'], 22),
        t('Expense claims', ['id:Claim ID', 'person:Employee', 'dept:Department', 'text:Category@Travel,Lodging,Fuel,Client Entertainment,Site Allowance,Tools', 'money:Claimed', 'money:Approved', 'status:Status@Submitted,Under Review,Approved,Rejected,Reimbursed'], 40),
        t('Ageing', ['vendor:Vendor', 'money:Current', 'money:31-60 Days', 'money:61-90 Days', 'money:90+ Days', 'money:Total', 'status:Risk@Low,Medium,High'], 28),
      ],
    },
    {
      id: 'receivables', label: 'Accounts Receivable', icon: Wallet, group: 'Finance',
      primaryAction: `Raise invoice`,
      tabs: [
        t(`${o.customer} invoices`, ['id:Invoice No', 'company:' + o.customer, 'program:' + o.jobLabel, 'date:Invoice Date', 'datefuture:Due Date', 'money:Amount', 'money:Received', 'status:Status@Draft,Sent,Part Paid,Paid,Overdue,Disputed'], 56),
        t('Collections', ['id:Invoice No', 'company:' + o.customer, 'money:Outstanding', 'int:Days Overdue', 'text:Last Action@Reminder Sent,Call Made,Escalated,Payment Promised,Legal Notice', 'person:Owner', 'status:Stage@Follow-up,Escalated,Promised,Settled,Written Off'], 42),
        t('Credit limits', ['company:' + o.customer, 'money:Credit Limit', 'money:Exposure', 'pct:Utilisation', 'text:Terms@Advance,15 Days,30 Days,45 Days,60 Days', 'status:Status@Within Limit,Near Limit,Breached,Blocked'], 30),
        t('Revenue recognition', ['program:' + o.jobLabel, 'text:Method@Point in Time,Over Time,Milestone', 'money:Contract Value', 'pct:Recognised', 'money:Recognised Value', 'money:Unbilled', 'status:Status@Open,Closed'], 26),
        t('Ageing', ['company:' + o.customer, 'money:Current', 'money:31-60 Days', 'money:61-90 Days', 'money:90+ Days', 'money:Total', 'status:Risk@Low,Medium,High'], 28),
      ],
    },
    {
      id: 'costing', label: 'Costing & Budgets', icon: Gauge, group: 'Finance',
      primaryAction: 'Create budget',
      tabs: [
        t('Cost centres', ['code:Centre Code', 'dept:Cost Centre', 'person:Owner', 'money:Budget', 'money:Actual', 'pct:Utilisation', 'status:Status@Healthy,Watch,Overrun'], 34),
        t('Budget vs actual', ['dept:Head', 'text:Period@Q1 FY27,Q2 FY27,Q3 FY27,Q4 FY27', 'money:Budget', 'money:Actual', 'money:Variance', 'pct:Variance Pct', 'status:Flag@Favourable,On Track,Adverse'], 44),
        t('Profitability', ['program:' + o.jobLabel, 'money:Revenue', 'money:Direct Cost', 'money:Overhead', 'money:Margin', 'pct:Margin %', 'status:Health@Strong,Acceptable,Thin,Loss Making'], 32),
        t('Cash flow forecast', ['text:Week@Week 32,Week 33,Week 34,Week 35,Week 36,Week 37', 'money:Opening', 'money:Inflow', 'money:Outflow', 'money:Closing', 'status:Position@Comfortable,Tight,Deficit'], 18),
      ],
    },
    {
      id: 'tax', label: 'Tax & Compliance', icon: BadgeCheck, group: 'Finance',
      tabs: [
        t('Tax codes', ['code:Tax Code', 'text:Tax@GST 5%,GST 12%,GST 18%,GST 28%,TDS 194C,TDS 194J,RCM', 'pct:Rate', 'text:Applies To@Goods,Services,Works Contract,Import', 'status:Status@Active,Inactive'], 22),
        t('Statutory filings', ['text:Return@GSTR-1,GSTR-3B,TDS 26Q,TDS 24Q,PF ECR,ESI,Professional Tax', 'text:Period@Jun 2026,Jul 2026,Aug 2026', 'datefuture:Due Date', 'money:Liability', 'person:Owner', 'status:Status@Pending,Filed,Late Filed,Under Query'], 36),
        t('e-Invoicing', ['id:Invoice No', 'company:' + o.customer, 'money:Value', 'code:IRN', 'date:Generated', 'status:Status@Generated,Pending,Cancelled,Failed'], 40),
        t('Input credit', ['vendor:Vendor', 'text:Period@Jun 2026,Jul 2026', 'money:Credit Claimed', 'money:Credit Matched', 'money:Mismatch', 'status:Status@Matched,Partially Matched,Not Reflected'], 30),
      ],
    },
  ]
}

/* ------------------------------------------------------------------- People */
export function peopleModules(): ModuleDef[] {
  return [
    {
      id: 'hr', label: 'Workforce', icon: Users, group: 'People',
      primaryAction: 'Add employee',
      tabs: [
        t('Employees', ['id:Employee ID', 'person:Name', 'dept:Department', 'text:Designation@Manager,Engineer,Supervisor,Technician,Executive,Analyst,Operator', 'campus:Location', 'date:Joined', 'money:CTC', 'status:Status@Active,On Leave,Notice Period,Exited'], 60),
        t('Onboarding', ['person:New Joiner', 'dept:Department', 'date:Date of Joining', 'text:Stage@Offer Accepted,Documents Pending,Induction,Asset Handover,Completed', 'person:Buddy', 'status:Status@In Progress,Completed,Delayed'], 26),
        t('Offboarding', ['person:Employee', 'dept:Department', 'date:Last Working Day', 'text:Reason@Resignation,Contract End,Retirement,Termination', 'text:Clearance@Assets,Finance,IT,Manager', 'status:Status@In Progress,Cleared,Withheld'], 20),
        t('Documents', ['person:Employee', 'text:Document@Aadhaar,PAN,Offer Letter,Degree Certificate,Experience Letter,Medical Fitness,Police Verification', 'date:Uploaded', 'datefuture:Expires', 'status:Status@Verified,Pending,Rejected,Expiring'], 44),
        t('Org chart', ['person:Employee', 'text:Level@L1,L2,L3,L4,L5', 'person:Reports To', 'dept:Department', 'int:Span of Control', 'campus:Location'], 34),
      ],
    },
    {
      id: 'attendance', label: 'Time & Attendance', icon: CalendarClock, group: 'People',
      primaryAction: 'Mark attendance',
      tabs: [
        t('Daily attendance', ['person:Employee', 'dept:Department', 'date:Date', 'time:In', 'time:Out', 'int:Hours', 'status:Status@Present,Absent,Half Day,Week Off,On Duty'], 60),
        t('Shift schedule', ['person:Employee', 'sem:Shift', 'campus:Location', 'date:From', 'datefuture:To', 'person:Supervisor', 'status:Status@Published,Draft,Swapped'], 44),
        t('Leave requests', ['id:Request ID', 'person:Employee', 'text:Type@Casual,Sick,Earned,Comp Off,Unpaid', 'date:From', 'datefuture:To', 'int:Days', 'status:Status@Applied,Approved,Rejected,Cancelled'], 38),
        t('Overtime', ['person:Employee', 'dept:Department', 'date:Date', 'int:OT Hours', 'money:OT Amount', 'text:Rule@1.5x Weekday,2x Weekly Off,2x Holiday', 'status:Status@Claimed,Approved,Paid,Rejected'], 40),
        t('Muster roll', ['dept:Department', 'campus:Location', 'int:Deployed', 'int:Present', 'int:Absent', 'pct:Attendance', 'status:Flag@Normal,Short,Critical'], 26),
      ],
    },
    {
      id: 'payroll', label: 'Payroll & Benefits', icon: Banknote, group: 'People',
      primaryAction: 'Run payroll',
      tabs: [
        t('Payroll runs', ['id:Run ID', 'text:Month@Jun 2026,Jul 2026,Aug 2026', 'int:Headcount', 'money:Gross', 'money:Deductions', 'money:Net Payable', 'status:Status@Draft,Locked,Approved,Disbursed'], 18),
        t('Salary register', ['person:Employee', 'dept:Department', 'money:Basic', 'money:Allowances', 'money:Deductions', 'money:Net Pay', 'status:Payment@Paid,Pending,On Hold'], 56),
        t('Statutory deductions', ['person:Employee', 'money:PF', 'money:ESI', 'money:Professional Tax', 'money:TDS', 'money:Total', 'status:Remittance@Remitted,Pending'], 48),
        t('Reimbursements', ['id:Claim ID', 'person:Employee', 'text:Head@Fuel,Mobile,Medical,Travel,Uniform', 'money:Amount', 'date:Submitted', 'status:Status@Submitted,Approved,Paid,Rejected'], 34),
        t('Benefits', ['person:Employee', 'text:Benefit@Group Medical,Accident Cover,Term Life,Gratuity,Transport,Canteen', 'money:Annual Value', 'date:Effective From', 'status:Status@Active,Lapsed,Pending Enrolment'], 40),
      ],
    },
    {
      id: 'talent', label: 'Talent', icon: Briefcase, group: 'People',
      primaryAction: 'Post opening',
      tabs: [
        t('Openings', ['id:Requisition', 'text:Role@Site Engineer,Planner,Supervisor,QA Inspector,Driver,Nurse,Machine Operator,Analyst', 'dept:Department', 'campus:Location', 'int:Positions', 'date:Raised', 'status:Status@Open,On Hold,Filled,Cancelled'], 24),
        t('Candidates', ['id:Candidate ID', 'person:Candidate', 'text:Role@Site Engineer,Planner,Supervisor,QA Inspector,Driver,Nurse,Machine Operator,Analyst', 'int:Experience (Yrs)', 'source:Source', 'status:Stage@Applied,Screened,Interviewed,Offered,Joined,Dropped'], 48),
        t('Training records', ['person:Employee', 'text:Programme@Safety Induction,First Aid,Quality Basics,Equipment Handling,Compliance,Leadership', 'date:Completed', 'datefuture:Valid Till', 'pct:Score', 'status:Status@Completed,Scheduled,Overdue'], 46),
        t('Performance reviews', ['person:Employee', 'dept:Department', 'text:Cycle@H1 FY27,H2 FY26', 'rating:Rating', 'person:Reviewer', 'status:Status@Draft,Submitted,Calibrated,Shared'], 42),
      ],
    },
  ]
}

/* ------------------------------------------------------------- Supply chain */
export function procurementModules(): ModuleDef[] {
  return [
    {
      id: 'sourcing', label: 'Sourcing', icon: Handshake, group: 'Supply Chain',
      primaryAction: 'Add vendor',
      tabs: [
        t('Vendor master', ['id:Vendor Code', 'vendor:Vendor', 'text:Category@Material,Service,Equipment,Manpower,Transport', 'city:City', 'phone:Contact', 'rating:Rating', 'status:Status@Approved,Provisional,Blacklisted,Under Review'], 44),
        t('RFQ', ['id:RFQ No', 'text:Requirement@Cement supply,Steel supply,Equipment hire,Annual maintenance,Consumables,Transport contract', 'date:Issued', 'datefuture:Closing', 'int:Vendors Invited', 'int:Quotes Received', 'status:Status@Open,Under Evaluation,Awarded,Cancelled'], 26),
        t('Quote comparison', ['id:RFQ No', 'vendor:Vendor', 'money:Quoted Value', 'int:Lead Time (Days)', 'text:Terms@Advance,30 Days,45 Days,60 Days', 'rating:Technical Score', 'status:Recommendation@L1 Recommended,Negotiate,Rejected'], 38),
        t('Contracts', ['id:Contract No', 'vendor:Vendor', 'text:Type@Rate Contract,Annual Maintenance,Supply,Service,Manpower', 'money:Value', 'date:Start', 'datefuture:Expiry', 'status:Status@Active,Expiring,Expired,Terminated'], 32),
        t('Scorecards', ['vendor:Vendor', 'pct:On-time Delivery', 'pct:Quality Acceptance', 'pct:Documentation', 'rating:Overall', 'status:Band@Preferred,Acceptable,Improvement Needed,Exit'], 30),
      ],
    },
    {
      id: 'purchasing', label: 'Purchasing', icon: ShoppingCart, group: 'Supply Chain',
      primaryAction: 'Raise requisition',
      tabs: [
        t('Requisitions', ['id:PR No', 'dept:Requested By Dept', 'person:Raised By', 'text:Item@Cement,Steel,Spares,Consumables,Safety Gear,IT Hardware,Medicines,Packaging', 'int:Quantity', 'money:Estimated Value', 'status:Status@Draft,Pending Approval,Approved,Rejected,Converted'], 48),
        t('Purchase orders', ['id:PO No', 'vendor:Vendor', 'date:PO Date', 'datefuture:Delivery By', 'money:PO Value', 'pct:Received', 'status:Status@Released,Partially Received,Received,Short Closed,Cancelled'], 52),
        t('Goods receipt', ['id:GRN No', 'code:PO Ref', 'vendor:Vendor', 'date:Received On', 'int:Quantity', 'int:Accepted', 'int:Rejected', 'status:Status@Accepted,Partially Accepted,Rejected,Under Inspection'], 46),
        t('Approval workflow', ['id:Document', 'text:Type@Requisition,Purchase Order,Contract,Payment', 'money:Value', 'person:Pending With', 'text:Level@L1 — Dept Head,L2 — Finance,L3 — Director', 'int:Ageing (Days)', 'status:Status@Pending,Approved,Rejected,Escalated'], 34),
      ],
    },
  ]
}

/* --------------------------------------------------------------- Commercial */
export function commercialModules(o: CommonOpts): ModuleDef[] {
  return [
    {
      id: 'crm', label: `${o.customer} CRM`, icon: Building, group: 'Commercial',
      primaryAction: `Add ${o.customer.toLowerCase()}`,
      tabs: [
        t(`${o.customers} master`, ['id:' + o.customer + ' Code', 'company:' + o.customer, 'city:City', 'person:Key Contact', 'phone:Phone', 'email:Email', 'money:Annual Value', 'status:Status@Active,Prospect,Dormant,Blacklisted'], 46),
        t('Activity log', ['company:' + o.customer, 'person:Owner', 'text:Activity@Call,Meeting,Site Visit,Email,Proposal Sent,Escalation', 'date:Date', 'text:Outcome@Positive,Neutral,Needs Follow-up,Lost', 'datefuture:Next Action'], 52),
        t('Segmentation', ['company:' + o.customer, 'text:Segment@Key Account,Growth,Mid Market,Long Tail', 'source:Channel', 'money:Revenue (YTD)', 'pct:Share of Wallet', 'status:Health@Growing,Stable,At Risk'], 34),
        t('Opportunities', ['id:Opportunity', 'company:' + o.customer, 'program:' + o.jobLabel, 'money:Estimated Value', 'pct:Win Probability', 'datefuture:Expected Close', 'status:Stage@Qualified,Proposal,Negotiation,Won,Lost'], 40),
      ],
    },
    {
      id: 'orders', label: 'Orders & Quotations', icon: ClipboardList, group: 'Commercial',
      primaryAction: 'Create quotation',
      tabs: [
        t('Quotations', ['id:Quote No', 'company:' + o.customer, 'program:' + o.jobLabel, 'money:Quoted Value', 'date:Issued', 'datefuture:Valid Till', 'status:Status@Draft,Sent,Negotiation,Accepted,Expired,Lost'], 44),
        t('Orders', ['id:Order No', 'company:' + o.customer, 'program:' + o.jobLabel, 'date:Order Date', 'datefuture:Committed Date', 'money:Order Value', 'status:Status@Confirmed,In Progress,Partially Delivered,Completed,Cancelled'], 52),
        t('Pricing rules', ['code:Rule Code', 'text:Applies To@All Customers,Key Accounts,Contract Rates,Spot', 'text:Basis@Volume Slab,Distance,Weight,Contract,List Price', 'pct:Discount', 'date:Effective From', 'status:Status@Active,Scheduled,Expired'], 28),
        t('Fulfilment status', ['id:Order No', 'company:' + o.customer, 'pct:Completion', 'datefuture:Promised', 'datefuture:Forecast', 'status:Status@On Track,At Risk,Delayed,Delivered'], 46),
      ],
    },
  ]
}

/* ------------------------------------------------------- Analytics & system */
export function platformModules(): ModuleDef[] {
  return [
    {
      id: 'analytics', label: 'Analytics', icon: BarChart3, group: 'Intelligence',
      tabs: [
        customTab('Dashboards', 'industry-analytics'),
        t('Drill-down reports', ['text:Report@Revenue by segment,Cost by centre,Utilisation,Ageing,Productivity,Compliance', 'dept:Dimension', 'text:Grain@Daily,Weekly,Monthly', 'person:Owner', 'date:Last Run', 'status:Status@Ready,Running,Failed'], 28),
        t('Scheduled delivery', ['text:Report@Daily operations summary,Weekly finance pack,Monthly MIS,Exception report', 'text:Frequency@Daily 07:00,Weekly Monday,Monthly 1st', 'email:Recipient', 'date:Last Sent', 'status:Status@Active,Paused,Failed'], 22),
        customTab('Report builder', 'report-builder'),
      ],
    },
    {
      id: 'admin', label: 'Administration', icon: Lock, group: 'System',
      tabs: [
        customTab('Roles & permissions', 'industry-roles'),
        t('Users', ['id:User ID', 'person:User', 'email:Email', 'text:Role@Administrator,Manager,Supervisor,Executive,Viewer', 'campus:Location', 'date:Last Login', 'status:Status@Active,Invited,Suspended'], 44),
        t('Audit trail', ['date:Timestamp', 'person:User', 'text:Action@Created record,Updated record,Deleted record,Exported data,Changed permission,Approved document', 'text:Module@Finance,Operations,People,Procurement,Admin', 'text:IP@10.4.2.18,10.4.2.44,49.205.11.7,103.21.58.2', 'status:Result@Success,Blocked'], 56),
        t('Notifications', ['text:Event@Approval pending,Threshold breach,Document expiry,Schedule change,Payment received', 'text:Channel@Email,SMS,In-app,WhatsApp', 'text:Audience@All users,Managers,Site teams,Finance', 'status:Status@Active,Paused'], 26),
        t('Branches', ['campus:Branch', 'city:City', 'person:Head', 'int:Users', 'date:Go Live', 'status:Status@Live,Pilot,Planned'], 18),
      ],
    },
    {
      id: 'integrations', label: 'Integrations', icon: Plug, group: 'System',
      tabs: [
        t('Connectors', ['text:System@Tally,SAP,Zoho Books,WhatsApp Business,Google Workspace,Power BI,Payment Gateway,GPS Provider', 'text:Direction@Inbound,Outbound,Two-way', 'date:Last Sync', 'pct:Success Rate', 'status:Status@Connected,Disconnected,Error,Not Configured'], 24),
        t('API keys', ['code:Key ID', 'text:Client@Mobile App,Partner Portal,BI Tool,Customer Portal', 'date:Issued', 'datefuture:Expires', 'int:Calls (30d)', 'status:Status@Active,Revoked,Expiring'], 20),
        t('Data import/export', ['id:Job ID', 'text:Job@Master import,Transaction import,Full export,Incremental export', 'person:Requested By', 'date:Run On', 'int:Records', 'status:Status@Completed,Partial,Failed,Queued'], 30),
        t('Webhooks', ['text:Event@Order created,Invoice paid,Status changed,Document approved', 'text:Endpoint@https://api.partner.io/hook,https://erp.internal/sync', 'int:Deliveries (24h)', 'status:Status@Healthy,Retrying,Failing'], 18),
      ],
    },
    {
      id: 'settings', label: 'Settings', icon: Settings, group: 'System',
      tabs: [
        t('Organisation', ['text:Setting@Legal name,GSTIN,Registered address,Financial year,Base currency,Time zone', 'text:Value@Vivencia Group,29AABCV1234F1Z5,Bengaluru,Apr–Mar,INR,IST', 'person:Updated By', 'date:Updated'], 14),
        t('Numbering series', ['text:Document@Invoice,Purchase Order,Requisition,Receipt,Journal', 'code:Prefix', 'int:Next Number', 'text:Reset@Yearly,Monthly,Never', 'status:Status@Active,Inactive'], 16),
        t('Approval matrix', ['text:Document@Requisition,Purchase Order,Invoice,Payment,Leave', 'money:Threshold', 'text:Approver@Dept Head,Finance Manager,Director,Board', 'int:Levels', 'status:Status@Active,Draft'], 20),
        t('Master data', ['text:Master@Units of measure,Tax codes,Locations,Departments,Document types', 'int:Records', 'person:Owner', 'date:Last Updated', 'status:Status@Healthy,Needs Review'], 14),
      ],
    },
  ]
}

/** The whole shared back office, in sidebar order. */
export function commonModules(o: CommonOpts): ModuleDef[] {
  return [
    ...financeModules(o),
    ...peopleModules(),
    ...procurementModules(),
    ...commercialModules(o),
    ...platformModules(),
  ]
}
