import {
  Boxes, ClipboardList, Compass, Gauge, LayoutDashboard, MapPin, Package,
  PackageCheck, Route, ScrollText, ShieldCheck, Truck, Warehouse, Wallet,
} from 'lucide-react'
import { LOGISTICS_VOCAB } from '@/data/industryVocab'
import { commonModules, GROUPS_TAIL } from './shared'
import { funnelSeries, series } from './kit'
import { customTab, t, type IndustryDef, type ModuleDef } from './types'

/* ---------------------------------------------------------------------------
   Logistics ERP — freight booking, load and route planning, trip execution and
   POD, warehouse operations, carrier management and freight accounting.
   --------------------------------------------------------------------------- */

const CORE: ModuleDef[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview', custom: 'industry-dashboard', tabs: [] },

  {
    id: 'bookings', label: 'Freight Booking', icon: Package, group: 'Order Management',
    primaryAction: 'Book consignment',
    tabs: [
      t('Consignments', ['id:Booking No', 'company:Customer', 'program:Lane', 'course:Service', 'city:Origin', 'city:Destination', 'int:Weight (Kg)', 'money:Freight', 'status:Status@Booked,Picked Up,In Transit,Out for Delivery,Delivered,Cancelled'], 60),
      t('Rate & tariff engine', ['code:Tariff Code', 'company:Customer', 'program:Lane', 'course:Mode', 'text:Basis@Per Kg,Per Tonne,Per Trip,Per Km,Per CBM', 'money:Rate', 'date:Effective From', 'status:Status@Active,Scheduled,Expired'], 48),
      t('Multi-modal bookings', ['id:Booking No', 'program:Lane', 'course:Leg Mode', 'sem:Leg', 'city:From', 'city:Destination', 'datefuture:ETA', 'status:Status@Planned,Executed,Delayed'], 44),
      t('Quotations', ['id:Quote No', 'company:Customer', 'program:Lane', 'course:Service', 'money:Quoted Freight', 'datefuture:Valid Till', 'status:Status@Sent,Negotiation,Accepted,Lost,Expired'], 36),
      t('Booking exceptions', ['id:Booking No', 'company:Customer', 'text:Exception@Address incomplete,Weight mismatch,Documents missing,Rate not mapped,Credit hold', 'person:Owner', 'date:Raised', 'status:Status@Open,Resolved,Escalated'], 30),
    ],
  },
  {
    id: 'planning', label: 'Load & Route Planning', icon: Route, group: 'Order Management',
    primaryAction: 'Plan load',
    tabs: [
      t('Load plans', ['id:Load No', 'campus:Origin Hub', 'city:Destination', 'int:Consignments', 'int:Weight (Kg)', 'pct:Volume Utilisation', 'date:Plan Date', 'status:Status@Draft,Confirmed,Loaded,Dispatched'], 44),
      t('Consolidation', ['id:Load No', 'company:Customer', 'id:Booking Ref', 'int:Weight (Kg)', 'int:Pieces', 'room:Bay', 'status:Status@Allocated,Loaded,Short Loaded,Removed'], 52),
      t('Route optimisation', ['id:Route ID', 'program:Lane', 'int:Stops', 'int:Distance (Km)', 'int:Planned Hours', 'money:Estimated Cost', 'status:Status@Optimised,Manual Override,Under Review'], 34),
      t('Vehicle indents', ['id:Indent No', 'vendor:Transporter', 'text:Vehicle Type@32 Ft MXL,22 Ft,19 Ft,Tata Ace,Container 20 Ft,Reefer', 'campus:Placement Hub', 'datefuture:Placement Date', 'money:Indent Rate', 'status:Status@Raised,Accepted,Placed,Short Placed,Cancelled'], 46),
      t('Capacity board', ['campus:Hub', 'text:Vehicle Type@32 Ft MXL,22 Ft,19 Ft,Tata Ace,Container 20 Ft,Reefer', 'int:Required', 'int:Available', 'int:Gap', 'status:Position@Comfortable,Tight,Shortfall'], 26),
    ],
  },
  {
    id: 'trips', label: 'Transport Operations', icon: Truck, group: 'Execution',
    primaryAction: 'Create trip sheet',
    tabs: [
      customTab('Live board', 'log-trip-board'),
      t('Trip sheets', ['id:Trip No', 'code:Vehicle No', 'person:Driver', 'program:Lane', 'date:Start', 'datefuture:Planned Arrival', 'int:Distance (Km)', 'status:Status@Planned,In Transit,Arrived,Closed,Cancelled'], 56),
      t('Consignment notes', ['id:LR No', 'company:Consignor', 'company:Consignee', 'program:Lane', 'int:Pieces', 'int:Weight (Kg)', 'money:Freight', 'status:Status@Issued,In Transit,Delivered,Short,Damaged'], 60),
      t('GPS tracking & ETA', ['id:Trip No', 'code:Vehicle No', 'city:Last Location', 'time:Last Ping', 'pct:Route Completion', 'datefuture:Revised ETA', 'status:Status@On Time,Delayed,Halted,Signal Lost'], 48),
      t('Proof of delivery', ['id:LR No', 'company:Consignee', 'date:Delivered On', 'person:Received By', 'text:POD Type@ePOD,Signed Copy,OTP Confirmed', 'status:Status@Received,Pending,Rejected,With Remarks'], 52),
      t('Detention & halting', ['id:Trip No', 'code:Vehicle No', 'campus:Location', 'int:Detention Hours', 'money:Detention Charge', 'text:Reason@Loading delay,Unloading delay,Document wait,Gate closure,Breakdown', 'status:Status@Claimed,Approved,Rejected'], 36),
      t('Trip expenses', ['id:Trip No', 'text:Head@Diesel,Toll,Driver Batta,Loading,Unloading,Repairs,Police', 'money:Amount', 'person:Approved By', 'status:Status@Submitted,Approved,Settled'], 46),
    ],
  },
  {
    id: 'warehouse', label: 'Warehouse', icon: Warehouse, group: 'Execution',
    primaryAction: 'Receive inbound',
    tabs: [
      t('Inbound receiving', ['id:GRN No', 'company:Customer', 'campus:Warehouse', 'date:Received On', 'int:Pieces', 'room:Dock', 'status:Status@Awaited,Unloading,Received,Discrepancy'], 48),
      t('Putaway', ['id:Task ID', 'code:SKU', 'campus:Warehouse', 'room:Bin', 'int:Quantity', 'person:Operator', 'status:Status@Pending,In Progress,Completed'], 52),
      t('Bin & location', ['campus:Warehouse', 'room:Bin', 'code:SKU', 'int:On Hand', 'int:Reserved', 'int:Available', 'status:Status@Available,Full,Blocked,Quarantine'], 60),
      t('Picking & dispatch', ['id:Pick List', 'company:Customer', 'int:Lines', 'int:Units', 'person:Picker', 'datefuture:Cut-off', 'status:Status@Released,Picking,Packed,Dispatched,Short Picked'], 50),
      t('Cycle count', ['campus:Warehouse', 'room:Bin', 'code:SKU', 'int:System Qty', 'int:Counted Qty', 'int:Variance', 'date:Count Date', 'status:Status@Matched,Variance,Recount Required,Adjusted'], 44),
      t('Stock ageing', ['company:Customer', 'code:SKU', 'int:0-30 Days', 'int:31-60 Days', 'int:61-90 Days', 'int:90+ Days', 'status:Flag@Healthy,Slow Moving,Obsolete'], 38),
    ],
  },
  {
    id: 'carriers', label: 'Carrier Management', icon: Compass, group: 'Network',
    primaryAction: 'Add transporter',
    tabs: [
      t('Transporter master', ['id:Transporter Code', 'vendor:Transporter', 'city:Base', 'int:Fleet Size', 'phone:Contact', 'rating:Rating', 'status:Status@Approved,Provisional,Suspended,Blacklisted'], 40),
      t('Carrier contracts', ['id:Contract No', 'vendor:Transporter', 'program:Lane', 'money:Contracted Rate', 'text:Basis@Per Trip,Per Tonne,Per Km', 'datefuture:Expiry', 'status:Status@Active,Expiring,Expired'], 38),
      t('Rate comparison', ['program:Lane', 'vendor:Transporter', 'money:Quoted Rate', 'int:Transit Days', 'pct:On-time Score', 'status:Recommendation@Preferred,Acceptable,Costly,Reject'], 44),
      t('Freight bill verification', ['id:Bill No', 'vendor:Transporter', 'id:Trip Ref', 'money:Billed', 'money:Contracted', 'money:Variance', 'status:Status@Matched,Rate Variance,Trip Not Found,Approved,Disputed'], 50),
      t('Carrier scorecards', ['vendor:Transporter', 'pct:Placement Compliance', 'pct:On-time Delivery', 'pct:Damage-free', 'rating:Overall', 'status:Band@Preferred,Standard,Watchlist,Exit'], 32),
      t('Vehicle master', ['code:Vehicle No', 'vendor:Owner', 'text:Type@32 Ft MXL,22 Ft,19 Ft,Tata Ace,Container 20 Ft,Reefer', 'int:Capacity (Kg)', 'datefuture:Fitness Expiry', 'status:Status@Active,Under Maintenance,Off Road'], 46),
    ],
  },
  {
    id: 'freight-finance', label: 'Freight Accounting', icon: Wallet, group: 'Network',
    primaryAction: 'Raise freight bill',
    tabs: [
      t('Customer freight billing', ['id:Invoice No', 'company:Customer', 'program:Lane', 'int:Consignments', 'money:Freight', 'money:Surcharges', 'money:Total', 'status:Status@Draft,Raised,Part Paid,Paid,Disputed'], 52),
      t('Carrier payables', ['id:Bill No', 'vendor:Transporter', 'int:Trips', 'money:Gross', 'money:Deductions', 'money:Net Payable', 'status:Status@Under Verification,Approved,Paid,On Hold'], 48),
      t('Cost per km/tonne', ['program:Lane', 'course:Mode', 'int:Distance (Km)', 'money:Cost per Km', 'money:Cost per Tonne', 'money:Revenue per Trip', 'pct:Margin', 'status:Health@Profitable,Marginal,Loss Making'], 40),
      t('Shortage & claims', ['id:Claim No', 'company:Customer', 'id:LR Ref', 'text:Nature@Shortage,Damage,Pilferage,Delay,Wrong Delivery', 'money:Claimed', 'money:Settled', 'status:Status@Registered,Under Investigation,Settled,Rejected'], 38),
      t('Detention recovery', ['company:Customer', 'id:Trip Ref', 'int:Hours', 'money:Recoverable', 'money:Recovered', 'status:Status@Raised,Under Discussion,Recovered,Waived'], 30),
    ],
  },
  {
    id: 'compliance', label: 'Transport Compliance', icon: ScrollText, group: 'Network',
    tabs: [
      t('e-Way bills', ['code:EWB No', 'id:LR Ref', 'company:Consignor', 'money:Invoice Value', 'date:Generated', 'datefuture:Valid Till', 'status:Status@Active,Expiring,Expired,Cancelled'], 52),
      t('Transport documents', ['id:LR No', 'text:Document@LR Copy,Invoice,e-Way Bill,Weighment Slip,Gate Pass,POD', 'date:Uploaded', 'person:Uploaded By', 'status:Status@Complete,Missing,Rejected'], 48),
      t('Driver compliance', ['person:Driver', 'code:Licence No', 'datefuture:Licence Expiry', 'date:Last Medical', 'int:Duty Hours (Week)', 'status:Status@Compliant,Renewal Due,Expired,Rest Violation'], 42),
      t('Vehicle compliance', ['code:Vehicle No', 'datefuture:Fitness', 'datefuture:Permit', 'datefuture:Insurance', 'datefuture:PUC', 'status:Status@Compliant,Renewal Due,Expired,Off Road'], 44),
      t('Transit insurance', ['id:Policy No', 'company:Customer', 'text:Cover@Single Transit,Annual Open,Declaration Based', 'money:Sum Insured', 'datefuture:Expiry', 'status:Status@Active,Renewal Due,Lapsed'], 26),
    ],
  },
  {
    id: 'control-tower', label: 'Control Tower', icon: MapPin, group: 'Execution',
    tabs: [
      t('Live exceptions', ['id:Trip No', 'program:Lane', 'text:Exception@Delay,Route deviation,Long halt,Temperature breach,No GPS ping,Accident', 'int:Ageing (Hrs)', 'person:Owner', 'status:Severity@Low,Medium,High,Critical'], 42),
      t('SLA performance', ['company:Customer', 'program:Lane', 'int:Shipments', 'pct:On-time', 'pct:In-full', 'pct:OTIF', 'status:Status@Meeting SLA,At Risk,Breached'], 40),
      t('Hub performance', ['campus:Hub', 'int:Inbound', 'int:Outbound', 'int:Pending', 'int:Dwell Time (Hrs)', 'pct:Dock Utilisation', 'status:Status@Healthy,Congested,Critical'], 24),
      t('Customer escalations', ['id:Ticket', 'company:Customer', 'text:Issue@Delivery delay,Damage,Billing dispute,Documentation,Rate query', 'person:Owner', 'int:Ageing (Hrs)', 'status:Status@Open,In Progress,Resolved,Escalated'], 36),
    ],
  },
]

const DASH: IndustryDef['dashboard'] = {
  greeting: 'Control tower · 6 hubs, 1,284 shipments in transit',
  primaryAction: { label: 'Book consignment', to: '/bookings' },
  kpis: [
    { label: 'Shipments (MTD)', value: '18,420', delta: '+7.6%', up: true, icon: Package, to: '/bookings' },
    { label: 'In transit', value: '1,284', delta: '+94', up: true, icon: Truck, to: '/trips' },
    { label: 'On-time delivery', value: '93.1%', delta: '+1.4%', up: true, icon: Gauge, to: '/control-tower' },
    { label: 'Freight revenue', value: '₹42.6 Cr', delta: '+8.9%', up: true, icon: Wallet, to: '/freight-finance' },
    { label: 'Cost per tonne-km', value: '₹2.84', delta: '-3.2%', up: true, icon: Route, to: '/freight-finance' },
    { label: 'POD pending', value: '312', delta: '-48', up: true, icon: PackageCheck, to: '/trips' },
    { label: 'Vehicle utilisation', value: '81.7%', delta: '+2.1%', up: true, icon: Compass, to: '/planning' },
    { label: 'Open claims', value: '46', delta: '+6', up: false, icon: ShieldCheck, to: '/freight-finance' },
  ],
  secondary: [
    { label: 'Active hubs', value: '6', icon: Warehouse },
    { label: 'Transporters', value: '128', icon: Truck },
    { label: 'Vehicles on road', value: '642', icon: Compass },
    { label: 'Warehouse fill', value: '86.4%', icon: Boxes },
    { label: 'Detention recovered', value: '₹38.2 L', icon: ClipboardList },
    { label: 'e-Way bills expiring', value: '17', icon: ScrollText },
  ],
  trend: {
    title: 'Service performance',
    subtitle: 'On-time vs in-full, monthly',
    data: series(5101, [{ key: 'onTime', min: 86, max: 97, decimals: 1 }, { key: 'inFull', min: 88, max: 99, decimals: 1 }]),
    keys: [{ key: 'onTime', label: 'On-time %' }, { key: 'inFull', label: 'In-full %' }],
  },
  mix: {
    title: 'Volume by mode',
    subtitle: 'Shipments this month',
    data: [
      { name: 'FTL Road', value: 7420 }, { name: 'LTL Road', value: 5180 },
      { name: 'Rail Container', value: 2240 }, { name: 'Air Freight', value: 1180 },
      { name: 'Ocean FCL/LCL', value: 1620 }, { name: 'Cold Chain', value: 780 },
    ],
  },
  funnel: {
    title: 'Booking to delivery',
    subtitle: 'Booked → dispatched → delivered',
    data: funnelSeries(5202, ['booked', 'dispatched', 'delivered'], [1400, 2100], [0.82, 0.96]),
    keys: [{ key: 'booked', label: 'Booked' }, { key: 'dispatched', label: 'Dispatched' }, { key: 'delivered', label: 'Delivered' }],
  },
  money: {
    title: 'Revenue vs freight cost',
    subtitle: '₹ crore, monthly',
    data: series(5303, [{ key: 'revenue', min: 32, max: 48, decimals: 2 }, { key: 'cost', min: 24, max: 38, decimals: 2 }]),
    keys: [{ key: 'revenue', label: 'Revenue' }, { key: 'cost', label: 'Freight cost' }],
  },
  progress: {
    title: 'Hub throughput',
    subtitle: 'Shipments handled against capacity',
    unit: '%',
    rows: [
      { name: 'Bhiwandi Hub', done: 92, total: 100 },
      { name: 'Nelamangala Hub', done: 78, total: 100 },
      { name: 'Sriperumbudur DC', done: 84, total: 100 },
      { name: 'Bhiwadi DC', done: 69, total: 100 },
      { name: 'Sanand Hub', done: 74, total: 100 },
    ],
  },
  approvals: [
    { id: 'FB-4412', type: 'Freight bill', detail: 'VRL Logistics — 84 trips, July', value: '₹1.24 Cr', age: '2 days' },
    { id: 'CL-0219', type: 'Claim settlement', detail: 'Asian Paints — damage on LR-88214', value: '₹4,80,000', age: '1 day' },
    { id: 'RT-0087', type: 'Rate revision', detail: 'Mumbai → Delhi contract rate +4%', value: '₹2.10/kg', age: '7 hours' },
    { id: 'IN-1140', type: 'Vehicle indent', detail: '18 × 32 Ft MXL — Nelamangala', value: '₹18,40,000', age: '4 hours' },
    { id: 'DT-0334', type: 'Detention claim', detail: 'Reliance Retail — 26 hours at Bhiwadi', value: '₹1,04,000', age: '3 days' },
  ],
  alerts: [
    { tone: 'red', title: '17 e-Way bills expire within 12 hours', detail: 'Vehicles still in transit — extension required' },
    { tone: 'amber', title: '312 PODs pending beyond 72 hours', detail: 'Billing blocked for ₹3.8 Cr' },
    { tone: 'amber', title: 'Bhiwandi hub dwell time at 9.4 hours', detail: 'Dock congestion since Monday' },
    { tone: 'blue', title: '9 driver licences due for renewal', detail: 'Within the next 30 days' },
  ],
  activityVerbs: [
    'booked a consignment for', 'dispatched a load to', 'closed the trip sheet for',
    'uploaded proof of delivery for', 'verified a freight bill from', 'raised a shortage claim against',
    'placed a vehicle indent with', 'revised the tariff for', 'settled a detention claim with',
    'completed cycle count at', 'flagged a route deviation on', 'released a pick list for',
  ],
  recent: {
    title: 'Recent shipments',
    action: 'Open bookings',
    to: '/bookings',
    rows: [
      { id: 'LR-88214', name: 'Hindustan Unilever', sub: 'Bhiwandi → Bengaluru · 18.2 T', stage: 'In Transit' },
      { id: 'LR-88213', name: 'Amazon India', sub: 'Bhiwadi → Jaipur · LTL', stage: 'Delivered' },
      { id: 'LR-88212', name: 'Asian Paints', sub: 'Sanand → Mumbai · 22 T', stage: 'Out for Delivery' },
      { id: 'LR-88211', name: 'Maruti Suzuki', sub: 'Sriperumbudur → Kochi · FTL', stage: 'In Transit' },
      { id: 'LR-88210', name: 'Nestle India', sub: 'Nelamangala → Chennai · Reefer', stage: 'Delivered' },
      { id: 'LR-88209', name: 'Havells', sub: 'Dankuni → Guwahati · LTL', stage: 'Delayed' },
      { id: 'LR-88208', name: 'Reliance Retail', sub: 'Bhiwandi → Pune · Cross-dock', stage: 'Delivered' },
      { id: 'LR-88207', name: 'Bosch India', sub: 'Pune → Hyderabad · FTL', stage: 'In Transit' },
    ],
  },
  tasks: [
    { title: 'Clear 42 unverified freight bills', due: 'Today', done: false },
    { title: 'Extend e-Way bills for 17 live trips', due: 'Today', done: false },
    { title: 'Close Bhiwandi cycle count variances', due: 'Tomorrow', done: false },
    { title: 'Publish revised Mumbai–Delhi tariff', due: 'Completed', done: true },
    { title: 'Review carrier scorecards for Q2', due: '16 Aug', done: false },
  ],
  announcements: [
    { title: 'Diesel-linked surcharge revised to 6.2% from 15 Aug', by: 'Pricing Desk', time: '3h ago', pinned: true },
    { title: 'ePOD mandatory for all LTL shipments', by: 'Operations', time: 'Yesterday', pinned: true },
    { title: 'Sanand hub extends night shift from Monday', by: 'Network Planning', time: '2 days ago', pinned: false },
    { title: 'New reefer partner onboarded for cold chain', by: 'Carrier Management', time: '5 days ago', pinned: false },
  ],
  events: [
    { name: 'Peak season capacity review', date: '12 Aug 2026', venue: 'Control Tower' },
    { name: 'Carrier rate negotiation — North', date: '14 Aug 2026', venue: 'Bhiwadi DC' },
    { name: 'Bhiwandi warehouse audit', date: '18 Aug 2026', venue: 'Bhiwandi Hub' },
    { name: 'Customer QBR — Hindustan Unilever', date: '21 Aug 2026', venue: 'Mumbai' },
    { name: 'Driver safety training', date: '24 Aug 2026', venue: 'All hubs' },
    { name: 'Fleet fitness renewal drive', date: '27 Aug 2026', venue: 'Nelamangala' },
    { name: 'Monthly network review', date: '31 Aug 2026', venue: 'Head Office' },
  ],
  calendar: { 12: ['Capacity review'], 14: ['Rate negotiation'], 18: ['Warehouse audit'], 21: ['Customer QBR'], 24: ['Safety training'], 27: ['Fitness drive'], 31: ['Network review'] },
  ranking: {
    title: 'Lane profitability',
    subtitle: 'Contribution margin by lane',
    rows: [
      { name: 'Blr → Chennai', value: 84 }, { name: 'Mum → Delhi', value: 76 },
      { name: 'Pune → Hyd', value: 68 }, { name: 'Kol → Guwahati', value: 54 },
      { name: 'JNPT → Blr', value: 71 }, { name: 'Mundra → Ludhiana', value: 62 },
    ],
  },
}

export const LOGISTICS: IndustryDef = {
  id: 'logistics',
  label: 'Logistics',
  tagline: 'Freight, fleet, warehouse and control tower',
  blurb: 'Book consignments, plan loads, track trips to POD, verify carrier bills and see cost per tonne-km on every lane.',
  icon: Truck,
  product: 'Vivencia CargoCloud',
  productSub: 'Logistics ERP Suite',
  user: { name: 'Priya Raghavan', defaultRole: 'operations-head' },
  modules: [...CORE, ...commonModules({ customer: 'Customer', customers: 'Customers', jobLabel: 'Lane' })],
  groupOrder: ['Overview', 'Order Management', 'Execution', 'Network', ...GROUPS_TAIL],
  roles: [
    { id: 'operations-head', label: 'Operations Head', scope: 'National network', modules: '*' },
    { id: 'hub-manager', label: 'Hub Manager', scope: 'Bhiwandi Hub — Mumbai', modules: ['dashboard', 'planning', 'trips', 'warehouse', 'control-tower', 'attendance'] },
    { id: 'booking-executive', label: 'Booking Executive', scope: 'Customer desk', modules: ['dashboard', 'bookings', 'crm', 'orders', 'control-tower'] },
    { id: 'fleet-controller', label: 'Fleet Controller', scope: 'Fleet operations', modules: ['dashboard', 'trips', 'planning', 'carriers', 'compliance', 'control-tower'] },
    { id: 'warehouse-manager', label: 'Warehouse Manager', scope: 'Sriperumbudur DC', modules: ['dashboard', 'warehouse', 'purchasing', 'attendance', 'analytics'] },
    { id: 'billing-manager', label: 'Billing Manager', scope: 'Freight accounting', modules: ['dashboard', 'freight-finance', 'receivables', 'payables', 'tax', 'analytics'] },
    { id: 'compliance-officer', label: 'Compliance Officer', scope: 'Statutory & transit', modules: ['dashboard', 'compliance', 'carriers', 'admin'] },
  ],
  vocab: LOGISTICS_VOCAB,
  scope: {
    orgLabel: 'Entity', orgs: ['Vivencia Logistics Ltd', 'Vivencia Express Pvt Ltd', 'Vivencia Coldchain'],
    siteLabel: 'Hub', sites: LOGISTICS_VOCAB.campus,
    periodLabel: 'Financial year', periods: ['FY 2026–27', 'FY 2025–26', 'FY 2024–25'],
  },
  quickCreate: [
    { label: 'Book consignment', to: '/bookings' }, { label: 'Plan a load', to: '/planning' },
    { label: 'Raise vehicle indent', to: '/planning' }, { label: 'Create trip sheet', to: '/trips' },
    { label: 'Upload POD', to: '/trips' }, { label: 'Receive inbound', to: '/warehouse' },
    { label: 'Verify freight bill', to: '/carriers' }, { label: 'Raise freight invoice', to: '/freight-finance' },
    { label: 'Register a claim', to: '/freight-finance' }, { label: 'Add transporter', to: '/carriers' },
  ],
  notifications: [
    { title: '17 e-Way bills expiring within 12 hours', desc: 'Transport Compliance', time: '9m ago' },
    { title: 'Trip TR-5521 halted for 4 hours near Hosur', desc: 'Control Tower', time: '42m ago' },
    { title: '312 PODs pending beyond 72 hours', desc: 'Transport Operations', time: '2h ago' },
    { title: 'Bhiwandi dock congestion — dwell 9.4 hrs', desc: 'Warehouse', time: '3h ago' },
    { title: 'VRL freight bill variance of ₹4.2 L', desc: 'Carrier Management', time: 'Yesterday' },
  ],
  messages: [
    { from: 'Rohan Desai', text: 'Reefer for Nestle needs a backup vehicle.', time: '09:12' },
    { from: 'Meera Nair', text: 'Customer wants the OTIF pack before the QBR.', time: '08:40' },
    { from: 'Hub Team — Bhiwandi', text: '3 docks free after 14:00 today.', time: 'Yesterday' },
  ],
  dashboard: DASH,
  searchHint: 'Search shipments, trips, vehicles…',
  highlights: ['Booking to POD on one thread', 'Carrier bills matched to trips', 'Cost per tonne-km on every lane'],
}
