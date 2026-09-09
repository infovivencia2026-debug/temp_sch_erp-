import {
  Boxes, ClipboardCheck, Cog, Factory, Gauge, GitBranch, Layers, LayoutDashboard, PackageCheck,
  Recycle, Ruler, Settings2, Timer, TrendingUp, Wallet, Wrench,
} from 'lucide-react'
import { MANUFACTURING_VOCAB } from '@/data/industryVocab'
import { commonModules, GROUPS_TAIL } from './shared'
import { funnelSeries, series } from './kit'
import { customTab, t, type IndustryDef, type ModuleDef } from './types'

/* ---------------------------------------------------------------------------
   Manufacturing ERP — item master and BOM, MPS/MRP and capacity, shop floor
   execution with OEE, subcontract job work, inventory with traceability,
   quality management, plant maintenance and product costing.
   --------------------------------------------------------------------------- */

const CORE: ModuleDef[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview', custom: 'industry-dashboard', tabs: [] },

  {
    id: 'engineering', label: 'Product Engineering', icon: GitBranch, group: 'Product & Planning',
    primaryAction: 'Add item',
    tabs: [
      t('Item master', ['code:Item Code', 'program:Item', 'text:Type@Finished Good,Sub-assembly,Raw Material,Consumable,Spare', 'text:UOM@Nos,Kg,Mtr,Ltr,Set', 'money:Standard Cost', 'text:Revision@Rev A,Rev B,Rev C', 'status:Status@Active,Under Revision,Obsolete'], 60),
      t('Bill of materials', ['program:Parent Item', 'code:Component Code', 'text:Component@Casting,Shaft,Bearing,Gasket,Fastener Set,Wiring Loom,Housing', 'int:Quantity', 'text:UOM@Nos,Kg,Mtr,Set', 'pct:Scrap Allowance', 'status:Status@Released,Draft,Superseded'], 60),
      t('Routing & work centres', ['program:Item', 'int:Operation No', 'course:Operation', 'room:Work Centre', 'int:Setup (Min)', 'int:Cycle (Min)', 'status:Status@Active,Under Revision'], 56),
      t('Engineering change orders', ['id:ECO No', 'program:Item', 'text:Change@Design revision,Material substitution,Tolerance change,Supplier change,Cost reduction', 'person:Raised By', 'date:Raised', 'status:Status@Draft,Under Review,Approved,Implemented,Rejected'], 34),
      t('Drawings & specs', ['code:Drawing No', 'program:Item', 'text:Revision@R0,R1,R2,R3', 'date:Released', 'person:Approved By', 'status:Status@Released,Under Revision,Obsolete'], 44),
    ],
  },
  {
    id: 'planning', label: 'Production Planning', icon: Layers, group: 'Product & Planning',
    primaryAction: 'Run MRP',
    tabs: [
      t('Master production schedule', ['program:Item', 'text:Period@Week 32,Week 33,Week 34,Week 35', 'int:Demand', 'int:Planned', 'int:Firm', 'campus:Plant', 'status:Status@Firm,Planned,Frozen'], 52),
      t('MRP results', ['code:Item Code', 'program:Item', 'int:Requirement', 'int:On Hand', 'int:On Order', 'int:Net Requirement', 'datefuture:Required By', 'status:Action@Create PO,Create Work Order,Reschedule,No Action'], 60),
      t('Capacity planning', ['room:Work Centre', 'campus:Plant', 'int:Available Hours', 'int:Loaded Hours', 'pct:Utilisation', 'sem:Shift', 'status:Status@Balanced,Overloaded,Underloaded'], 40),
      t('Make vs buy', ['program:Item', 'money:In-house Cost', 'money:Buy Cost', 'int:In-house Lead Time', 'int:Buy Lead Time', 'status:Recommendation@Make,Buy,Review'], 30),
      t('Production plan', ['id:Plan No', 'program:Item', 'campus:Plant', 'int:Planned Qty', 'date:Start', 'datefuture:Finish', 'status:Status@Draft,Released,In Progress,Completed'], 44),
    ],
  },
  {
    id: 'shopfloor', label: 'Shop Floor', icon: Factory, group: 'Execution',
    primaryAction: 'Create work order',
    tabs: [
      customTab('OEE board', 'mfg-oee-board'),
      t('Work orders', ['id:WO No', 'program:Item', 'campus:Plant', 'room:Line', 'int:Order Qty', 'int:Produced', 'datefuture:Due Date', 'status:Status@Released,In Progress,On Hold,Completed,Closed,Short Closed'], 58),
      t('Job cards', ['id:Job Card', 'id:WO Ref', 'course:Operation', 'room:Work Centre', 'person:Operator', 'sem:Shift', 'int:Quantity', 'status:Status@Open,In Progress,Completed,Rejected'], 60),
      t('Machine & operator log', ['code:Machine', 'room:Work Centre', 'person:Operator', 'sem:Shift', 'date:Date', 'int:Run Minutes', 'int:Idle Minutes', 'status:Status@Running,Idle,Setup,Breakdown'], 56),
      t('OEE & downtime', ['code:Machine', 'date:Date', 'pct:Availability', 'pct:Performance', 'pct:Quality', 'pct:OEE', 'text:Top Loss@Setup,Breakdown,Material Wait,Manpower,Quality Stop', 'status:Band@World Class,Acceptable,Below Target'], 52),
      t('Scrap & rework', ['id:WO Ref', 'program:Item', 'course:Operation', 'int:Scrap Qty', 'int:Rework Qty', 'text:Reason@Dimensional,Surface defect,Material,Setup error,Tool wear', 'money:Cost Impact', 'status:Disposition@Scrapped,Reworked,Use As Is,Under Review'], 48),
      t('Production output', ['campus:Plant', 'room:Line', 'date:Date', 'sem:Shift', 'int:Planned', 'int:Produced', 'pct:Achievement', 'status:Status@On Target,Below Target,Above Target'], 50),
    ],
  },
  {
    id: 'subcontracting', label: 'Job Work', icon: Cog, group: 'Execution',
    primaryAction: 'Issue challan',
    tabs: [
      t('Job work challans', ['id:Challan No', 'vendor:Job Worker', 'program:Item', 'course:Process', 'int:Sent Qty', 'date:Sent On', 'datefuture:Due Back', 'status:Status@Issued,Partially Received,Received,Overdue,Closed'], 46),
      t('Material issue', ['id:Challan Ref', 'vendor:Job Worker', 'code:Item Code', 'int:Issued Qty', 'money:Value', 'date:Issued', 'status:Status@Issued,Consumed,Returned,Written Off'], 44),
      t('Yield reconciliation', ['id:Challan Ref', 'vendor:Job Worker', 'int:Input Qty', 'int:Output Qty', 'int:Scrap Returned', 'pct:Yield', 'status:Status@Within Norm,Yield Loss,Under Investigation'], 36),
      t('Job work charges', ['vendor:Job Worker', 'course:Process', 'int:Quantity', 'money:Rate', 'money:Amount', 'date:Bill Date', 'status:Status@Submitted,Verified,Approved,Paid'], 40),
    ],
  },
  {
    id: 'inventory', label: 'Inventory', icon: Boxes, group: 'Materials',
    primaryAction: 'Stock entry',
    tabs: [
      t('Stock summary', ['code:Item Code', 'program:Item', 'text:Category@Raw Material,WIP,Finished Goods,Consumable,Spare', 'campus:Plant', 'int:Quantity', 'money:Value', 'status:Status@In Stock,Low Stock,Excess,Out of Stock,Blocked'], 60),
      t('Batch & serial traceability', ['code:Batch/Serial', 'program:Item', 'code:Supplier Lot', 'date:Received', 'int:Quantity', 'company:Shipped To', 'status:Status@In Stock,Consumed,Dispatched,Recalled'], 56),
      t('Bin control', ['campus:Plant', 'room:Bin', 'code:Item Code', 'int:On Hand', 'int:Reserved', 'int:Available', 'status:Status@Available,Full,Blocked,Quarantine'], 54),
      t('Cycle counting', ['campus:Plant', 'room:Bin', 'code:Item Code', 'int:System Qty', 'int:Counted Qty', 'int:Variance', 'date:Count Date', 'status:Status@Matched,Variance,Recount,Adjusted'], 46),
      t('Material movements', ['id:Document No', 'text:Movement@Goods Receipt,Issue to Production,Transfer,Return,Scrap,Dispatch', 'code:Item Code', 'int:Quantity', 'room:From', 'room:To', 'date:Date'], 58),
      t('Stock ageing', ['code:Item Code', 'program:Item', 'int:0-30 Days', 'int:31-90 Days', 'int:91-180 Days', 'int:180+ Days', 'money:Value', 'status:Flag@Healthy,Slow Moving,Non Moving,Obsolete'], 42),
    ],
  },
  {
    id: 'quality', label: 'Quality Management', icon: ClipboardCheck, group: 'Quality & Maintenance',
    primaryAction: 'Record inspection',
    tabs: [
      t('Incoming inspection', ['id:Inspection No', 'vendor:Supplier', 'code:Item Code', 'code:GRN Ref', 'int:Lot Size', 'int:Sample Size', 'int:Defects', 'status:Result@Accepted,Accepted with Deviation,Rejected,Under Test'], 52),
      t('In-process inspection', ['id:WO Ref', 'course:Operation', 'room:Work Centre', 'int:Checked', 'int:Rejected', 'grade:Disposition', 'person:Inspector', 'status:Result@Passed,Failed,Rework'], 50),
      t('Final inspection', ['program:Item', 'code:Batch', 'int:Lot Size', 'pct:Yield', 'grade:Grade', 'person:Inspector', 'status:Result@Released,Hold,Rejected'], 44),
      t('Non-conformance & CAPA', ['id:NCR No', 'program:Item', 'text:Nature@Dimensional,Material,Process,Documentation,Customer Complaint', 'text:Root Cause@Tool wear,Setup error,Material variation,Operator error,Machine drift', 'person:Owner', 'datefuture:CAPA Due', 'status:Status@Open,Containment,CAPA In Progress,Verified,Closed'], 40),
      t('Supplier quality rating', ['vendor:Supplier', 'int:Lots Received', 'int:Lots Rejected', 'pct:PPM Defects', 'pct:On-time Delivery', 'rating:Rating', 'status:Band@Approved,Conditional,On Notice,Disqualified'], 34),
      t('Calibration', ['code:Instrument No', 'text:Instrument@Vernier Caliper,Micrometer,Height Gauge,Torque Wrench,Pressure Gauge,CMM', 'date:Last Calibrated', 'datefuture:Next Due', 'vendor:Agency', 'status:Status@Valid,Due,Overdue'], 38),
    ],
  },
  {
    id: 'maintenance', label: 'Plant Maintenance', icon: Wrench, group: 'Quality & Maintenance',
    primaryAction: 'Raise work request',
    tabs: [
      t('Asset register', ['code:Machine', 'text:Type@CNC Lathe,VMC,Press,Furnace,Compressor,Injection Moulder,Welding Robot', 'campus:Plant', 'room:Location', 'money:Book Value', 'date:Commissioned', 'status:Status@Running,Idle,Breakdown,Under Overhaul'], 46),
      t('Preventive maintenance', ['code:Machine', 'text:Plan@Daily,Weekly,Monthly,Quarterly,Annual', 'date:Last Done', 'datefuture:Next Due', 'person:Technician', 'status:Status@Compliant,Due,Overdue,Skipped'], 48),
      t('Breakdowns', ['id:Ticket No', 'code:Machine', 'date:Reported', 'int:Downtime (Min)', 'text:Cause@Bearing failure,Hydraulic leak,Electrical fault,Tool breakage,Sensor error', 'money:Repair Cost', 'status:Status@Open,Under Repair,Awaiting Spare,Resolved'], 44),
      t('Maintenance spares', ['code:Spare Code', 'text:Spare@Bearing,Belt,Seal Kit,Hydraulic Hose,Contactor,Sensor,Filter', 'int:On Hand', 'int:Reorder Level', 'money:Value', 'status:Status@In Stock,Low Stock,Out of Stock'], 46),
      t('MTBF / MTTR', ['code:Machine', 'int:Failures (90d)', 'int:MTBF (Hrs)', 'int:MTTR (Min)', 'pct:Availability', 'status:Band@Reliable,Watch,Chronic'], 32),
    ],
  },
  {
    id: 'product-costing', label: 'Product Costing', icon: Ruler, group: 'Materials',
    tabs: [
      t('Standard vs actual', ['program:Item', 'money:Standard Cost', 'money:Actual Cost', 'money:Variance', 'pct:Variance Pct', 'status:Flag@Favourable,On Standard,Adverse'], 48),
      t('Variance analysis', ['program:Item', 'text:Variance@Material Price,Material Usage,Labour Rate,Labour Efficiency,Overhead Absorption', 'money:Amount', 'text:Period@Jun 2026,Jul 2026,Aug 2026', 'status:Impact@Favourable,Adverse'], 44),
      t('Overhead absorption', ['dept:Cost Centre', 'money:Overhead Pool', 'int:Absorption Base (Hrs)', 'money:Rate per Hour', 'money:Absorbed', 'money:Under/Over', 'status:Status@Absorbed,Under Absorbed,Over Absorbed'], 30),
      t('Cost sheet', ['program:Item', 'money:Material', 'money:Labour', 'money:Overhead', 'money:Total Cost', 'money:Selling Price', 'pct:Margin'], 40),
    ],
  },
  {
    id: 'dispatch', label: 'Dispatch', icon: PackageCheck, group: 'Execution',
    primaryAction: 'Create dispatch',
    tabs: [
      t('Dispatch plan', ['id:Dispatch No', 'company:Customer', 'program:Item', 'int:Quantity', 'datefuture:Committed Date', 'campus:Plant', 'status:Status@Planned,Picked,Packed,Dispatched,Delivered'], 52),
      t('Packing list', ['id:Dispatch Ref', 'code:Batch', 'program:Item', 'int:Cartons', 'int:Net Weight (Kg)', 'person:Packed By', 'status:Status@Packed,Verified,Sealed'], 46),
      t('Delivery challans', ['id:Challan No', 'company:Customer', 'code:Vehicle No', 'date:Dispatched', 'money:Invoice Value', 'status:Status@Issued,In Transit,Delivered,Returned'], 44),
      t('Customer returns', ['id:Return No', 'company:Customer', 'program:Item', 'int:Quantity', 'text:Reason@Quality issue,Wrong item,Excess supply,Damage in transit', 'money:Credit Value', 'status:Status@Registered,Under Inspection,Credit Issued,Rejected'], 32),
    ],
  },
]

const DASH: IndustryDef['dashboard'] = {
  greeting: 'Plant operations · 6 plants, 42 lines running',
  primaryAction: { label: 'Create work order', to: '/shopfloor' },
  kpis: [
    { label: 'Output (MTD)', value: '184,260', delta: '+5.8%', up: true, icon: Factory, to: '/shopfloor' },
    { label: 'Plant OEE', value: '74.6%', delta: '+2.2%', up: true, icon: Gauge, to: '/shopfloor' },
    { label: 'Schedule adherence', value: '91.4%', delta: '+1.1%', up: true, icon: Timer, to: '/planning' },
    { label: 'Rejection (PPM)', value: '842', delta: '-118', up: true, icon: ClipboardCheck, to: '/quality' },
    { label: 'Inventory value', value: '₹62.4 Cr', delta: '-3.4%', up: true, icon: Boxes, to: '/inventory' },
    { label: 'Revenue (MTD)', value: '₹96.8 Cr', delta: '+7.2%', up: true, icon: Wallet, to: '/receivables' },
    { label: 'Cost variance', value: '+2.8%', delta: '+0.6%', up: false, icon: TrendingUp, to: '/product-costing' },
    { label: 'Unplanned downtime', value: '186 hrs', delta: '-42', up: true, icon: Wrench, to: '/maintenance' },
  ],
  secondary: [
    { label: 'Plants', value: '6', icon: Factory },
    { label: 'Work centres', value: '148', icon: Settings2 },
    { label: 'Open work orders', value: '312', icon: Layers },
    { label: 'WIP value', value: '₹18.2 Cr', icon: Boxes },
    { label: 'Job work outstanding', value: '₹4.6 Cr', icon: Cog },
    { label: 'Scrap rate', value: '1.9%', icon: Recycle },
  ],
  trend: {
    title: 'Output vs plan',
    subtitle: 'Units produced, monthly (hundreds)',
    data: series(7101, [{ key: 'planned', min: 1620, max: 1980 }, { key: 'produced', min: 1480, max: 1940 }]),
    keys: [{ key: 'planned', label: 'Planned' }, { key: 'produced', label: 'Produced' }],
  },
  mix: {
    title: 'Output by product line',
    subtitle: 'Units this month',
    data: [
      { name: 'Gearbox GX-200', value: 42800 }, { name: 'Brake Disc BD-14', value: 38200 },
      { name: 'Pump Housing PH-9', value: 29600 }, { name: 'Control Panel CP-3', value: 24100 },
      { name: 'Valve Body VB-22', value: 28400 }, { name: 'Harness WH-11', value: 21160 },
    ],
  },
  funnel: {
    title: 'Order to dispatch',
    subtitle: 'Ordered → produced → dispatched',
    data: funnelSeries(7202, ['ordered', 'produced', 'dispatched'], [1400, 1900], [0.86, 0.97]),
    keys: [{ key: 'ordered', label: 'Ordered' }, { key: 'produced', label: 'Produced' }, { key: 'dispatched', label: 'Dispatched' }],
  },
  money: {
    title: 'Revenue vs cost of production',
    subtitle: '₹ crore, monthly',
    data: series(7303, [{ key: 'revenue', min: 76, max: 104, decimals: 2 }, { key: 'cost', min: 58, max: 82, decimals: 2 }]),
    keys: [{ key: 'revenue', label: 'Revenue' }, { key: 'cost', label: 'Cost of production' }],
  },
  progress: {
    title: 'Line utilisation',
    subtitle: 'Loaded hours against available hours',
    unit: '%',
    rows: [
      { name: 'Plant 1 — Pune', done: 88, total: 100 },
      { name: 'Plant 2 — Chennai', done: 79, total: 100 },
      { name: 'Plant 3 — Pithampur', done: 92, total: 100 },
      { name: 'Foundry — Kolhapur', done: 68, total: 100 },
      { name: 'Assembly — Bengaluru', done: 74, total: 100 },
    ],
  },
  approvals: [
    { id: 'ECO-0142', type: 'Engineering change', detail: 'Material substitution — Valve Body VB-22', value: '₹18.4 L/yr', age: '2 days' },
    { id: 'PR-4418', type: 'Purchase requisition', detail: '18 T alloy steel — Plant 1', value: '₹1.42 Cr', age: '1 day' },
    { id: 'DV-0231', type: 'Deviation request', detail: 'Tolerance relaxation — Pump Housing lot 2026-C', value: '4,200 units', age: '8 hours' },
    { id: 'CN-0088', type: 'Credit note', detail: 'Customer return — Bajaj Auto', value: '₹6,84,000', age: '3 days' },
    { id: 'OT-1190', type: 'Overtime approval', detail: 'Shift B — Plant 3, 42 operators', value: '336 hrs', age: '5 hours' },
  ],
  alerts: [
    { tone: 'red', title: 'Line C at Plant 3 down for 6.4 hours', detail: 'Hydraulic failure — 2 work orders at risk' },
    { tone: 'amber', title: 'Rejection PPM above target on Brake Disc BD-14', detail: '1,240 PPM against a 900 target' },
    { tone: 'amber', title: '₹4.6 Cr of job work material overdue from 6 vendors', detail: 'Yield reconciliation pending' },
    { tone: 'blue', title: '14 instruments due for calibration this month', detail: 'Including 2 CMMs' },
  ],
  activityVerbs: [
    'released a work order for', 'closed a job card on', 'logged a breakdown on',
    'approved an engineering change for', 'recorded incoming inspection for', 'raised an NCR on',
    'completed cycle count at', 'issued job work material to', 'dispatched a consignment to',
    'updated the standard cost of', 'reconciled yield for', 'released a batch of',
  ],
  recent: {
    title: 'Recent work orders',
    action: 'Open shop floor',
    to: '/shopfloor',
    rows: [
      { id: 'WO-72418', name: 'Gearbox Assembly GX-200', sub: 'Plant 1 · Line A · 2,400 units', stage: 'In Progress' },
      { id: 'WO-72417', name: 'Brake Disc BD-14', sub: 'Plant 2 · Line B · 6,000 units', stage: 'Completed' },
      { id: 'WO-72416', name: 'Pump Housing PH-9', sub: 'Plant 3 · Cell 4 · 1,800 units', stage: 'On Hold' },
      { id: 'WO-72415', name: 'Control Panel CP-3', sub: 'Bengaluru · Line C · 900 units', stage: 'In Progress' },
      { id: 'WO-72414', name: 'Valve Body VB-22', sub: 'Plant 1 · Cell 7 · 3,200 units', stage: 'Released' },
      { id: 'WO-72413', name: 'Wiring Harness WH-11', sub: 'Plant 2 · Line A · 4,500 units', stage: 'Completed' },
      { id: 'WO-72412', name: 'Heat Exchanger HX-40', sub: 'Kolhapur · Bay 2 · 620 units', stage: 'In Progress' },
      { id: 'WO-72411', name: 'Bearing Cage BC-6', sub: 'Sanand · Line B · 8,000 units', stage: 'Released' },
    ],
  },
  tasks: [
    { title: 'Approve ECO-0142 material substitution', due: 'Today', done: false },
    { title: 'Close 6 overdue job work challans', due: 'Tomorrow', done: false },
    { title: 'Review Brake Disc rejection root cause', due: '13 Aug', done: false },
    { title: 'Sign off July cost variance report', due: 'Completed', done: true },
    { title: 'Reschedule Line C work orders', due: '12 Aug', done: false },
  ],
  announcements: [
    { title: 'Standard cost revision effective 1 Sep 2026', by: 'Costing', time: '2h ago', pinned: true },
    { title: 'IATF surveillance audit scheduled for 26 Aug', by: 'Quality Assurance', time: 'Yesterday', pinned: true },
    { title: 'Plant 3 shifts to three-shift operation from Monday', by: 'Production Planning', time: '2 days ago', pinned: false },
    { title: 'New supplier onboarded for alloy castings', by: 'Sourcing', time: '5 days ago', pinned: false },
  ],
  events: [
    { name: 'MRP run — week 33', date: '11 Aug 2026', venue: 'Planning' },
    { name: 'Plant 1 safety audit', date: '13 Aug 2026', venue: 'Pune' },
    { name: 'Customer audit — Tata Motors', date: '18 Aug 2026', venue: 'Plant 2' },
    { name: 'Preventive maintenance shutdown', date: '22 Aug 2026', venue: 'Plant 3' },
    { name: 'IATF surveillance audit', date: '26 Aug 2026', venue: 'All plants' },
    { name: 'Supplier quality meet', date: '28 Aug 2026', venue: 'Pune' },
    { name: 'Monthly production review', date: '31 Aug 2026', venue: 'Head Office' },
  ],
  calendar: { 11: ['MRP run'], 13: ['Safety audit'], 18: ['Customer audit'], 22: ['PM shutdown'], 26: ['IATF audit'], 28: ['Supplier meet'], 31: ['Production review'] },
  ranking: {
    title: 'Plant OEE',
    subtitle: 'Availability × performance × quality',
    rows: [
      { name: 'Plant 1', value: 81 }, { name: 'Plant 2', value: 74 },
      { name: 'Plant 3', value: 78 }, { name: 'Foundry', value: 63 },
      { name: 'Assembly', value: 71 }, { name: 'Export Unit', value: 69 },
    ],
  },
}

export const MANUFACTURING: IndustryDef = {
  id: 'manufacturing',
  label: 'Manufacturing',
  tagline: 'BOM, MRP, shop floor and costing',
  blurb: 'Plan from BOM to MRP, run the shop floor on OEE, trace every batch, and settle the month on standard versus actual cost.',
  icon: Factory,
  product: 'Vivencia PlantCloud',
  productSub: 'Manufacturing ERP Suite',
  user: { name: 'Priya Raghavan', defaultRole: 'plant-head' },
  modules: [...CORE, ...commonModules({ customer: 'Customer', customers: 'Customers', jobLabel: 'Product Line' })],
  groupOrder: ['Overview', 'Product & Planning', 'Execution', 'Materials', 'Quality & Maintenance', ...GROUPS_TAIL],
  roles: [
    { id: 'plant-head', label: 'Plant Head', scope: 'All plants', modules: '*' },
    { id: 'production-manager', label: 'Production Manager', scope: 'Plant 1 — Pune', modules: ['dashboard', 'shopfloor', 'planning', 'subcontracting', 'dispatch', 'maintenance', 'attendance'] },
    { id: 'planner', label: 'Production Planner', scope: 'Central planning', modules: ['dashboard', 'planning', 'engineering', 'inventory', 'purchasing', 'analytics'] },
    { id: 'quality-head', label: 'Quality Head', scope: 'Quality assurance', modules: ['dashboard', 'quality', 'engineering', 'sourcing', 'shopfloor'] },
    { id: 'stores-manager', label: 'Stores Manager', scope: 'Plant stores', modules: ['dashboard', 'inventory', 'purchasing', 'subcontracting', 'dispatch'] },
    { id: 'maintenance-head', label: 'Maintenance Head', scope: 'Plant maintenance', modules: ['dashboard', 'maintenance', 'shopfloor', 'purchasing'] },
    { id: 'cost-accountant', label: 'Cost Accountant', scope: 'Costing & finance', modules: ['dashboard', 'product-costing', 'costing', 'ledger', 'payables', 'receivables', 'analytics'] },
  ],
  vocab: MANUFACTURING_VOCAB,
  scope: {
    orgLabel: 'Entity', orgs: ['Vivencia Industries Ltd', 'Vivencia Precision Pvt Ltd', 'Vivencia Exports'],
    siteLabel: 'Plant', sites: MANUFACTURING_VOCAB.campus,
    periodLabel: 'Financial year', periods: ['FY 2026–27', 'FY 2025–26', 'FY 2024–25'],
  },
  quickCreate: [
    { label: 'Add item', to: '/engineering' }, { label: 'Run MRP', to: '/planning' },
    { label: 'Create work order', to: '/shopfloor' }, { label: 'Log downtime', to: '/shopfloor' },
    { label: 'Record inspection', to: '/quality' }, { label: 'Raise NCR', to: '/quality' },
    { label: 'Issue job work challan', to: '/subcontracting' }, { label: 'Stock entry', to: '/inventory' },
    { label: 'Create dispatch', to: '/dispatch' }, { label: 'Raise purchase requisition', to: '/purchasing' },
  ],
  notifications: [
    { title: 'Line C at Plant 3 down for 6.4 hours', desc: 'Plant Maintenance · hydraulic failure', time: '14m ago' },
    { title: 'Brake Disc BD-14 rejection at 1,240 PPM', desc: 'Quality Management', time: '1h ago' },
    { title: 'MRP run flagged 42 shortage items', desc: 'Production Planning', time: '3h ago' },
    { title: '6 job work challans overdue beyond 30 days', desc: 'Job Work', time: '5h ago' },
    { title: 'IATF surveillance audit in 16 days', desc: 'Quality Management', time: 'Yesterday' },
  ],
  messages: [
    { from: 'Rohan Desai', text: 'Need the Line C recovery plan before the 4 pm review.', time: '09:12' },
    { from: 'Meera Nair', text: 'Tata Motors audit checklist shared on the drive.', time: '08:40' },
    { from: 'Stores — Plant 1', text: 'Alloy steel GRN posted, 18 T received.', time: 'Yesterday' },
  ],
  dashboard: DASH,
  searchHint: 'Search work orders, items, batches…',
  highlights: ['BOM and routing drive MRP', 'OEE captured at every machine', 'Standard vs actual on every item'],
}
