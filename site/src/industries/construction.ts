import {
  Boxes, Building2, ClipboardCheck, Coins, FileSpreadsheet, HardHat, LayoutDashboard,
  Ruler, ScrollText, ShieldAlert, Timer, Truck, Users, Wallet,
} from 'lucide-react'
import { CONSTRUCTION_VOCAB } from '@/data/industryVocab'
import { commonModules, GROUPS_TAIL } from './shared'
import { funnelSeries, series } from './kit'
import { customTab, t, type IndustryDef, type ModuleDef } from './types'

/* ---------------------------------------------------------------------------
   Construction ERP — projects, estimation, site execution, subcontracting,
   client billing (RA bills), HSE and statutory compliance, on top of the shared
   finance/people/procurement back office.
   --------------------------------------------------------------------------- */

const CORE: ModuleDef[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview', custom: 'industry-dashboard', tabs: [] },

  {
    id: 'projects', label: 'Projects', icon: Building2, group: 'Project Delivery',
    primaryAction: 'Create project',
    tabs: [
      t('Project master', ['id:Project Code', 'program:Project', 'company:Client', 'campus:Site', 'money:Contract Value', 'date:Start', 'datefuture:Completion', 'status:Status@Planning,Mobilised,In Progress,On Hold,Handover,Closed'], 26),
      t('Site master', ['code:Site Code', 'campus:Site', 'program:Project', 'person:Site In-charge', 'int:Headcount', 'city:City', 'status:Status@Active,Mobilising,Demobilised'], 20),
      t('Work breakdown', ['code:WBS Code', 'program:Project', 'course:Activity', 'text:Level@L1,L2,L3', 'money:Budgeted Cost', 'pct:Weightage', 'status:Status@Not Started,In Progress,Completed'], 56),
      t('BOQ', ['code:Item Code', 'program:Project', 'course:Item Description', 'text:Unit@Cum,Sqm,Rmt,MT,Nos,Kg', 'int:BOQ Quantity', 'money:Rate', 'money:Amount', 'status:Status@Approved,Under Revision,Extra Item'], 60),
      t('Budgets', ['program:Project', 'dept:Head', 'money:Budget', 'money:Committed', 'money:Actual', 'pct:Utilisation', 'status:Flag@Within Budget,Watch,Overrun'], 34),
      t('Milestones', ['program:Project', 'text:Milestone@Foundation complete,Structure topped out,MEP rough-in,Finishes complete,Handover', 'datefuture:Planned', 'date:Forecast', 'pct:Progress', 'status:Status@On Track,At Risk,Delayed,Achieved'], 30),
    ],
  },
  {
    id: 'planning', label: 'Planning & Schedule', icon: Timer, group: 'Project Delivery',
    primaryAction: 'Add activity',
    tabs: [
      customTab('Gantt', 'con-gantt'),
      t('Activity schedule', ['code:Activity ID', 'program:Project', 'course:Activity', 'date:Baseline Start', 'datefuture:Baseline Finish', 'int:Duration (Days)', 'pct:Progress', 'status:Status@Not Started,In Progress,Completed,Delayed'], 60),
      t('Progress vs baseline', ['program:Project', 'course:Activity', 'pct:Planned %', 'pct:Actual %', 'int:Variance (Days)', 'status:Flag@Ahead,On Track,Slipping,Critical'], 48),
      t('Resource histogram', ['program:Project', 'text:Resource@Mason,Carpenter,Bar Bender,Electrician,Plumber,Helper,Operator', 'int:Planned', 'int:Deployed', 'int:Gap', 'sem:Phase', 'status:Status@Balanced,Shortage,Surplus'], 42),
      t('Look-ahead', ['program:Project', 'course:Activity', 'text:Week@Week 32,Week 33,Week 34', 'person:Responsible', 'text:Constraint@Material,Drawing,Approval,Manpower,Weather,None', 'status:Readiness@Ready,Constrained,Blocked'], 40),
      t('Delay register', ['id:Delay ID', 'program:Project', 'text:Cause@Client Drawing,Weather,Material Shortage,Labour,Approval,Design Change', 'int:Days Lost', 'money:Cost Impact', 'status:Status@Under Review,Notified,Accepted,Rejected'], 26),
    ],
  },
  {
    id: 'estimation', label: 'Estimation & Tenders', icon: Ruler, group: 'Project Delivery',
    primaryAction: 'New bid',
    tabs: [
      t('Tenders', ['id:Tender No', 'company:Client', 'program:Project', 'source:Source', 'money:Tender Value', 'datefuture:Submission Date', 'status:Status@Identified,Bid Preparation,Submitted,Technically Qualified,Won,Lost'], 32),
      t('Rate analysis', ['code:Item Code', 'course:Item', 'text:Unit@Cum,Sqm,Rmt,MT,Nos', 'money:Material Rate', 'money:Labour Rate', 'money:Machinery Rate', 'money:Total Rate'], 48),
      t('Bid estimation', ['id:Tender No', 'program:Project', 'money:Direct Cost', 'money:Overheads', 'pct:Margin', 'money:Bid Value', 'person:Estimator', 'status:Status@Draft,Reviewed,Approved,Submitted'], 28),
      t('Submission tracking', ['id:Tender No', 'company:Client', 'datefuture:Due', 'text:Mode@Online Portal,Physical,Email', 'money:EMD', 'person:Owner', 'status:Status@In Progress,Submitted,Opened,Awarded,Rejected'], 26),
      t('Win/loss', ['id:Tender No', 'company:Client', 'money:Our Bid', 'money:L1 Bid', 'pct:Variance', 'text:Reason@Price,Technical,Experience,Timeline,Withdrew', 'status:Outcome@Won,Lost,Cancelled'], 24),
    ],
  },
  {
    id: 'site', label: 'Site Operations', icon: HardHat, group: 'Site Execution',
    primaryAction: 'Log DPR',
    tabs: [
      t('Daily progress', ['id:DPR No', 'campus:Site', 'date:Date', 'course:Activity', 'int:Quantity Done', 'text:Unit@Cum,Sqm,Rmt,MT,Nos', 'text:Weather@Clear,Rain,Extreme Heat', 'status:Status@Submitted,Verified,Reopened'], 60),
      t('Labour deployment', ['campus:Site', 'date:Date', 'vendor:Contractor', 'text:Trade@Mason,Carpenter,Bar Bender,Electrician,Plumber,Helper', 'int:Deployed', 'int:Present', 'int:Man-hours', 'status:Status@Normal,Short,Excess'], 56),
      t('Machinery log', ['code:Asset No', 'text:Machine@Excavator,Tower Crane,Concrete Pump,Transit Mixer,Batching Plant,JCB,Vibratory Roller', 'campus:Site', 'date:Date', 'int:Running Hours', 'int:Idle Hours', 'money:Fuel Cost', 'status:Status@Working,Idle,Breakdown,Under Service'], 46),
      t('Site instructions', ['id:SI No', 'program:Project', 'person:Issued By', 'text:Subject@Rework instruction,Sequence change,Safety directive,Material substitution,Stop work', 'date:Issued', 'status:Status@Open,Acknowledged,Complied,Escalated'], 30),
      t('Drawings', ['code:Drawing No', 'program:Project', 'text:Discipline@Architectural,Structural,MEP,Electrical,Plumbing', 'text:Revision@R0,R1,R2,R3', 'date:Issued', 'status:Status@Good for Construction,Under Review,Superseded,Hold'], 44),
    ],
  },
  {
    id: 'materials', label: 'Site Materials', icon: Boxes, group: 'Site Execution',
    primaryAction: 'Raise indent',
    tabs: [
      t('Indents', ['id:Indent No', 'campus:Site', 'text:Material@Cement,TMT Steel,Aggregate,Sand,Bricks,Tiles,Paint,Conduits', 'int:Quantity', 'text:Unit@MT,Bags,Cum,Nos,Ltr', 'datefuture:Required By', 'status:Status@Raised,Approved,PO Issued,Delivered,Closed'], 48),
      t('Issue & consumption', ['id:Issue No', 'campus:Site', 'text:Material@Cement,TMT Steel,Aggregate,Sand,Bricks,Tiles,Paint', 'course:Consumed For', 'int:Quantity Issued', 'date:Date', 'person:Issued To'], 56),
      t('Reconciliation vs BOQ', ['program:Project', 'text:Material@Cement,TMT Steel,Aggregate,Sand,Bricks', 'int:Theoretical', 'int:Actual', 'pct:Variance', 'money:Value Impact', 'status:Flag@Within Norm,Excess Consumption,Under Investigation'], 34),
      t('Site stock', ['campus:Site', 'text:Material@Cement,TMT Steel,Aggregate,Sand,Bricks,Tiles,Paint,Consumables', 'int:Opening', 'int:Received', 'int:Issued', 'int:Closing', 'status:Status@Healthy,Low Stock,Out of Stock,Excess'], 44),
      t('Shuttering & scaffolding', ['code:Asset No', 'text:Item@MS Plate,Prop,Span,Cuplock,Ply Sheet,Beam Clamp', 'campus:Site', 'int:Issued Qty', 'int:Returned Qty', 'date:Issued On', 'status:Status@At Site,Returned,Damaged,Lost'], 38),
    ],
  },
  {
    id: 'subcontracts', label: 'Subcontracting', icon: Users, group: 'Contracts & Billing',
    primaryAction: 'Issue work order',
    tabs: [
      t('Work orders', ['id:WO No', 'vendor:Subcontractor', 'program:Project', 'course:Scope', 'money:WO Value', 'date:Issued', 'datefuture:Completion', 'status:Status@Issued,In Progress,Completed,Terminated'], 42),
      t('Measurement book', ['id:MB Entry', 'vendor:Subcontractor', 'course:Item', 'text:Unit@Cum,Sqm,Rmt,MT,Nos', 'int:Measured Quantity', 'money:Rate', 'money:Amount', 'status:Status@Recorded,Checked,Certified,Disputed'], 56),
      t('RA bills — subcontractor', ['id:Bill No', 'vendor:Subcontractor', 'program:Project', 'int:Bill Number', 'money:Gross Amount', 'money:Net Payable', 'date:Submitted', 'status:Status@Submitted,Under Certification,Certified,Paid,On Hold'], 46),
      t('Retention & deductions', ['vendor:Subcontractor', 'money:Gross Billed', 'money:Retention Held', 'money:TDS', 'money:Advance Recovered', 'money:Net Paid', 'status:Release@Held,Partially Released,Released'], 36),
      t('Contractor compliance', ['vendor:Subcontractor', 'text:Document@Labour Licence,PF Registration,ESI,Insurance,Safety Training', 'datefuture:Valid Till', 'status:Status@Valid,Expiring,Expired,Not Submitted'], 34),
    ],
  },
  {
    id: 'billing', label: 'Client Billing', icon: Coins, group: 'Contracts & Billing',
    primaryAction: 'Generate RA bill',
    tabs: [
      t('RA bills', ['id:RA Bill No', 'company:Client', 'program:Project', 'int:Bill Number', 'money:Gross Value', 'money:Certified Value', 'date:Submitted', 'status:Status@Draft,Submitted,Under Certification,Certified,Paid,Disputed'], 44),
      t('Variations & extras', ['id:Variation No', 'program:Project', 'course:Item', 'text:Type@Extra Item,Deviation,Substitution,Omission', 'money:Claimed Value', 'money:Approved Value', 'status:Status@Submitted,Under Review,Approved,Rejected'], 34),
      t('Escalation claims', ['id:Claim No', 'program:Project', 'text:Basis@Steel Index,Cement Index,Fuel Index,Labour Index', 'text:Period@Q1 FY27,Q2 FY27,Q3 FY27', 'money:Claimed', 'money:Admitted', 'status:Status@Submitted,Under Review,Admitted,Rejected'], 26),
      t('Certification & payment', ['id:RA Bill No', 'company:Client', 'money:Certified', 'money:Received', 'int:Days Outstanding', 'datefuture:Expected Receipt', 'status:Status@Awaiting Certification,Certified,Part Received,Received,Overdue'], 40),
      t('Retention receivable', ['company:Client', 'program:Project', 'money:Retention Held', 'datefuture:Release Due', 'text:Stage@On Completion,After DLP', 'status:Status@Held,Claimed,Released'], 24),
    ],
  },
  {
    id: 'quality', label: 'Quality & Safety', icon: ShieldAlert, group: 'Quality & Compliance',
    primaryAction: 'Log incident',
    tabs: [
      t('Quality checklists', ['id:Checklist No', 'program:Project', 'course:Activity', 'text:Stage@Pre-pour,In-process,Final', 'person:Inspected By', 'date:Date', 'status:Result@Passed,Passed with Observation,Failed,Pending'], 48),
      t('Non-conformance', ['id:NCR No', 'program:Project', 'text:Nature@Dimensional deviation,Material defect,Workmanship,Documentation,Process deviation', 'person:Raised By', 'date:Raised', 'money:Rework Cost', 'status:Status@Open,Under Correction,Closed,Escalated'], 36),
      t('Safety incidents', ['id:Incident No', 'campus:Site', 'text:Type@Near Miss,First Aid,Lost Time Injury,Property Damage,Fire', 'date:Date', 'text:Severity@Low,Medium,High,Critical', 'person:Reported By', 'status:Status@Reported,Under Investigation,Closed'], 32),
      t('Toolbox talks', ['campus:Site', 'date:Date', 'text:Topic@Working at height,Electrical safety,Excavation safety,PPE compliance,Hot work,Emergency response', 'person:Conducted By', 'int:Attendance', 'status:Status@Completed,Scheduled,Missed'], 40),
      t('Material testing', ['program:Project', 'text:Test@Cube Test,Slump Test,Steel Tensile,Soil Compaction,Bitumen Extraction', 'grade:Grade', 'date:Sample Date', 'pct:Result vs Spec', 'status:Result@Passed,Failed,Awaited'], 42),
    ],
  },
  {
    id: 'compliance', label: 'Statutory Compliance', icon: ScrollText, group: 'Quality & Compliance',
    tabs: [
      t('Labour compliance', ['campus:Site', 'text:Item@Labour Licence,BOCW Registration,Wage Register,PF Remittance,ESI Remittance,Muster Roll', 'datefuture:Valid Till', 'person:Owner', 'status:Status@Compliant,Renewal Due,Expired,Under Query'], 34),
      t('Permits & NOCs', ['id:Permit No', 'program:Project', 'text:Permit@Building Plan Approval,Environment Clearance,Fire NOC,Height Clearance,Tree Cutting,Road Cutting', 'text:Authority@Municipal Corporation,Pollution Board,Fire Department,Airport Authority', 'datefuture:Valid Till', 'status:Status@Obtained,Applied,Expiring,Expired'], 30),
      t('Bank guarantees', ['id:BG No', 'company:Client', 'text:Type@Performance,Advance,Retention,EMD', 'money:Value', 'text:Bank@SBI,HDFC,ICICI,Axis,Bank of Baroda', 'datefuture:Expiry', 'status:Status@Live,Expiring,Released,Invoked'], 28),
      t('Insurance', ['program:Project', 'text:Policy@Contractors All Risk,Workmen Compensation,Third Party Liability,Plant & Machinery', 'money:Sum Insured', 'money:Premium', 'datefuture:Expiry', 'status:Status@Active,Renewal Due,Lapsed'], 24),
    ],
  },
  {
    id: 'plant', label: 'Plant & Equipment', icon: Truck, group: 'Site Execution',
    primaryAction: 'Add asset',
    tabs: [
      t('Asset register', ['code:Asset No', 'text:Asset@Excavator,Tower Crane,Concrete Pump,Transit Mixer,JCB,Roller,DG Set', 'campus:Deployed At', 'text:Ownership@Owned,Hired,Leased', 'money:Book Value', 'date:Acquired', 'status:Status@Working,Idle,Breakdown,Disposed'], 40),
      t('Hire charges', ['vendor:Hirer', 'text:Machine@Excavator,Crane,Pump,Mixer,JCB', 'campus:Site', 'int:Hours/Days', 'money:Rate', 'money:Amount', 'status:Status@Verified,Under Verification,Disputed'], 34),
      t('Maintenance', ['code:Asset No', 'text:Type@Preventive,Breakdown,Overhaul', 'date:Date', 'money:Cost', 'person:Attended By', 'datefuture:Next Due', 'status:Status@Completed,In Progress,Overdue'], 38),
      t('Fuel log', ['code:Asset No', 'campus:Site', 'date:Date', 'int:Litres', 'money:Amount', 'int:Running Hours', 'status:Efficiency@Normal,High Consumption,Under Review'], 46),
    ],
  },
]

const DASH: IndustryDef['dashboard'] = {
  greeting: 'Project controls · 12 live projects across 6 sites',
  primaryAction: { label: 'New RA bill', to: '/billing' },
  kpis: [
    { label: 'Live projects', value: '12', delta: '+2', up: true, icon: Building2, to: '/projects' },
    { label: 'Order book', value: '₹1,842 Cr', delta: '+9.4%', up: true, icon: FileSpreadsheet, to: '/projects' },
    { label: 'Billed YTD', value: '₹412 Cr', delta: '+6.1%', up: true, icon: Coins, to: '/billing' },
    { label: 'Certified & unpaid', value: '₹68.4 Cr', delta: '-4.2%', up: true, icon: Wallet, to: '/receivables' },
    { label: 'Schedule adherence', value: '87.2%', delta: '-1.8%', up: false, icon: Timer, to: '/planning' },
    { label: 'Labour on site', value: '3,184', delta: '+214', up: true, icon: Users, to: '/site' },
    { label: 'Open NCRs', value: '34', delta: '-7', up: true, icon: ClipboardCheck, to: '/quality' },
    { label: 'Safe man-hours', value: '1.42 M', delta: '+112 K', up: true, icon: ShieldAlert, to: '/quality' },
  ],
  secondary: [
    { label: 'Active sites', value: '6', icon: HardHat },
    { label: 'Subcontractors', value: '84', icon: Users },
    { label: 'Plant utilisation', value: '78.4%', icon: Truck },
    { label: 'Material variance', value: '2.1%', icon: Boxes },
    { label: 'Tenders in bid', value: '9', icon: Ruler },
    { label: 'Permits expiring', value: '4', icon: ScrollText },
  ],
  trend: {
    title: 'Physical vs financial progress',
    subtitle: 'Monthly, all live projects',
    data: series(4101, [{ key: 'physical', min: 62, max: 94, decimals: 1 }, { key: 'financial', min: 55, max: 88, decimals: 1 }]),
    keys: [{ key: 'physical', label: 'Physical %' }, { key: 'financial', label: 'Financial %' }],
  },
  mix: {
    title: 'Order book by segment',
    subtitle: 'Contract value, ₹ crore',
    data: [
      { name: 'Residential', value: 468 }, { name: 'Commercial', value: 392 },
      { name: 'Infrastructure', value: 524 }, { name: 'Industrial', value: 246 },
      { name: 'Institutional', value: 132 }, { name: 'Retrofit', value: 80 },
    ],
  },
  funnel: {
    title: 'Tender funnel',
    subtitle: 'Identified → submitted → won',
    data: funnelSeries(4202, ['identified', 'submitted', 'won'], [14, 26], [0.5, 0.72]),
    keys: [{ key: 'identified', label: 'Identified' }, { key: 'submitted', label: 'Submitted' }, { key: 'won', label: 'Won' }],
  },
  money: {
    title: 'Billing vs cost',
    subtitle: '₹ crore, monthly',
    data: series(4303, [{ key: 'billed', min: 28, max: 52, decimals: 2 }, { key: 'cost', min: 20, max: 42, decimals: 2 }]),
    keys: [{ key: 'billed', label: 'Billed' }, { key: 'cost', label: 'Cost incurred' }],
  },
  progress: {
    title: 'Project completion',
    subtitle: '% of contract value executed',
    unit: '%',
    rows: [
      { name: 'Sector 62 IT Park', done: 74, total: 100 },
      { name: 'Riverside Residency P2', done: 46, total: 100 },
      { name: 'Metro Line 4 — Viaduct', done: 88, total: 100 },
      { name: 'Hosur Road Flyover', done: 32, total: 100 },
      { name: 'Coastal Highway Pkg 3', done: 61, total: 100 },
    ],
  },
  approvals: [
    { id: 'RA-0148', type: 'RA bill', detail: 'Sector 62 IT Park — Bill 14', value: '₹8.42 Cr', age: '2 days' },
    { id: 'PR-2291', type: 'Purchase requisition', detail: '420 MT TMT steel — Riverside P2', value: '₹3.16 Cr', age: '1 day' },
    { id: 'VO-0087', type: 'Variation order', detail: 'Façade substitution — Metro Line 4', value: '₹64,80,000', age: '5 hours' },
    { id: 'WO-0412', type: 'Work order', detail: 'Blockwork subcontract — Kalyan Block C', value: '₹1.94 Cr', age: '3 days' },
    { id: 'EX-1130', type: 'Expense claim', detail: 'Site mobilisation — Coastal Package', value: '₹2,84,000', age: '6 hours' },
  ],
  alerts: [
    { tone: 'red', title: '4 subcontractor labour licences expired', detail: 'Riverside and Kalyan sites — work stoppage risk' },
    { tone: 'amber', title: 'Cement consumption 6.8% above BOQ norm', detail: 'Hosur Road Flyover — reconciliation pending' },
    { tone: 'amber', title: '₹18.4 Cr certified but unpaid beyond 60 days', detail: 'NHAI and PWD Karnataka' },
    { tone: 'blue', title: 'Tower crane TC-04 due for third-party inspection', detail: 'Sector 62 site — 9 days remaining' },
  ],
  activityVerbs: [
    'certified RA bill for', 'approved a variation on', 'logged the daily progress report for',
    'raised a material indent at', 'closed an NCR on', 'issued a work order to',
    'recorded machinery hours at', 'updated the look-ahead schedule for', 'released retention to',
    'submitted a tender for', 'verified the measurement book of', 'cleared a safety observation at',
  ],
  recent: {
    title: 'Recent RA bills',
    action: 'Open billing',
    to: '/billing',
    rows: [
      { id: 'RA-0148', name: 'Sector 62 IT Park', sub: 'DLF Developers · Bill 14', stage: 'Certified' },
      { id: 'RA-0147', name: 'Metro Line 4 — Viaduct', sub: 'Bengaluru Metro Rail · Bill 22', stage: 'Under Certification' },
      { id: 'RA-0146', name: 'Coastal Highway Pkg 3', sub: 'NHAI · Bill 9', stage: 'Paid' },
      { id: 'RA-0145', name: 'Riverside Residency P2', sub: 'Godrej Properties · Bill 6', stage: 'Submitted' },
      { id: 'RA-0144', name: 'Kalyan Township Block C', sub: 'Prestige Estates · Bill 11', stage: 'Disputed' },
      { id: 'RA-0143', name: 'Whitefield Data Centre', sub: 'Embassy Group · Bill 4', stage: 'Certified' },
      { id: 'RA-0142', name: 'Hosur Road Flyover', sub: 'PWD Karnataka · Bill 3', stage: 'Under Certification' },
      { id: 'RA-0141', name: 'Airport Terminal Expansion', sub: 'Adani Infra · Bill 17', stage: 'Paid' },
    ],
  },
  tasks: [
    { title: 'Certify Riverside P2 bill 6', due: 'Today', done: false },
    { title: 'Close 3 open NCRs at Kalyan site', due: 'Tomorrow', done: false },
    { title: 'Renew Coastal Package CAR policy', due: '14 Aug', done: false },
    { title: 'Approve July plant hire charges', due: 'Completed', done: true },
    { title: 'Submit Metro Line 4 escalation claim', due: '18 Aug', done: false },
  ],
  announcements: [
    { title: 'Revised steel rate contract effective 1 Sep 2026', by: 'Procurement', time: '2h ago', pinned: true },
    { title: 'Monsoon work protocol issued for all coastal sites', by: 'HSE Cell', time: 'Yesterday', pinned: true },
    { title: 'Client certification cycle moved to fortnightly', by: 'Commercial', time: '2 days ago', pinned: false },
    { title: 'New BOQ template rolled out for all tenders', by: 'Estimation', time: '4 days ago', pinned: false },
  ],
  events: [
    { name: 'Client review — Sector 62', date: '12 Aug 2026', venue: 'Site Office' },
    { name: 'Metro Line 4 slab pour', date: '14 Aug 2026', venue: 'Pier P-14' },
    { name: 'Third-party crane inspection', date: '17 Aug 2026', venue: 'Sector 62 Site' },
    { name: 'Coastal Highway package review', date: '21 Aug 2026', venue: 'Mangaluru' },
    { name: 'Safety week kick-off', date: '24 Aug 2026', venue: 'All sites' },
    { name: 'Tender submission — Airport P2', date: '28 Aug 2026', venue: 'Online Portal' },
    { name: 'Quarterly cost review', date: '31 Aug 2026', venue: 'Head Office' },
  ],
  calendar: { 12: ['Client review'], 14: ['Slab pour'], 17: ['Crane inspection'], 21: ['Package review'], 24: ['Safety week'], 28: ['Tender submission'], 31: ['Cost review'] },
  ranking: {
    title: 'Site productivity',
    subtitle: 'Output against planned man-hours',
    rows: [
      { name: 'Sector 62', value: 94 }, { name: 'Riverside', value: 81 },
      { name: 'Metro Depot', value: 88 }, { name: 'Hosur Road', value: 67 },
      { name: 'Kalyan', value: 76 }, { name: 'Coastal', value: 72 },
    ],
  },
}

export const CONSTRUCTION: IndustryDef = {
  id: 'construction',
  label: 'Construction',
  tagline: 'Projects, site execution and RA billing',
  blurb: 'Run tenders, WBS and BOQ, daily site progress, subcontractor measurement books and client certification on one ledger.',
  icon: HardHat,
  product: 'Vivencia BuildCloud',
  productSub: 'Construction ERP Suite',
  user: { name: 'Priya Raghavan', defaultRole: 'project-director' },
  modules: [...CORE, ...commonModules({ customer: 'Client', customers: 'Clients', jobLabel: 'Project' })],
  groupOrder: ['Overview', 'Project Delivery', 'Site Execution', 'Contracts & Billing', 'Quality & Compliance', ...GROUPS_TAIL],
  roles: [
    { id: 'project-director', label: 'Project Director', scope: 'All projects', modules: '*' },
    { id: 'project-manager', label: 'Project Manager', scope: 'Sector 62 IT Park', modules: ['dashboard', 'projects', 'planning', 'site', 'materials', 'subcontracts', 'quality', 'plant', 'analytics'] },
    { id: 'site-engineer', label: 'Site Engineer', scope: 'Sector 62 Site — Noida', modules: ['dashboard', 'site', 'materials', 'planning', 'quality', 'plant'] },
    { id: 'quantity-surveyor', label: 'Quantity Surveyor', scope: 'Commercial — North', modules: ['dashboard', 'estimation', 'billing', 'subcontracts', 'projects', 'receivables', 'analytics'] },
    { id: 'hse-manager', label: 'HSE Manager', scope: 'All sites', modules: ['dashboard', 'quality', 'compliance', 'site', 'talent'] },
    { id: 'finance-controller', label: 'Finance Controller', scope: 'Group finance', modules: ['dashboard', 'ledger', 'payables', 'receivables', 'costing', 'tax', 'payroll', 'analytics'] },
    { id: 'procurement-head', label: 'Procurement Head', scope: 'Central procurement', modules: ['dashboard', 'sourcing', 'purchasing', 'materials', 'payables', 'analytics'] },
  ],
  vocab: CONSTRUCTION_VOCAB,
  scope: {
    orgLabel: 'Company', orgs: ['Vivencia Infra Pvt Ltd', 'Vivencia Realty LLP', 'Vivencia–Kaveri JV'],
    siteLabel: 'Site', sites: CONSTRUCTION_VOCAB.campus,
    periodLabel: 'Financial year', periods: ['FY 2026–27', 'FY 2025–26', 'FY 2024–25'],
  },
  quickCreate: [
    { label: 'Create project', to: '/projects' }, { label: 'Log daily progress', to: '/site' },
    { label: 'Raise material indent', to: '/materials' }, { label: 'Issue work order', to: '/subcontracts' },
    { label: 'Generate RA bill', to: '/billing' }, { label: 'Record NCR', to: '/quality' },
    { label: 'Log safety incident', to: '/quality' }, { label: 'Raise purchase requisition', to: '/purchasing' },
    { label: 'Add vendor', to: '/sourcing' }, { label: 'Record expense claim', to: '/payables' },
  ],
  notifications: [
    { title: 'RA bill 14 certified — Sector 62 IT Park', desc: 'Client Billing · ₹8.42 Cr', time: '18m ago' },
    { title: '4 labour licences expired across 2 sites', desc: 'Statutory Compliance', time: '1h ago' },
    { title: 'Cement consumption exceeds BOQ norm', desc: 'Site Materials · Hosur Road', time: '3h ago' },
    { title: 'Tower crane TC-04 inspection due', desc: 'Plant & Equipment', time: '5h ago' },
    { title: 'Tender for Airport Terminal P2 closes in 6 days', desc: 'Estimation & Tenders', time: 'Yesterday' },
  ],
  messages: [
    { from: 'Rohan Desai', text: 'Slab pour at Pier P-14 shifted to Thursday.', time: '09:12' },
    { from: 'Meera Nair', text: 'Client wants the variation file before certification.', time: '08:40' },
    { from: 'Site Team — Kalyan', text: '3 new observations on the safety walk.', time: 'Yesterday' },
  ],
  dashboard: DASH,
  searchHint: 'Search projects, bills, indents…',
  highlights: ['Tender to RA bill in one chain', 'Measurement books and retention', 'BOQ reconciliation on every material'],
}
