import {
  Activity, Ambulance, BedDouble, ClipboardPlus, FlaskConical, HeartPulse, LayoutDashboard,
  Microscope, Pill, ShieldCheck, Stethoscope, Syringe, Users, Wallet, Wrench,
} from 'lucide-react'
import { HEALTHCARE_VOCAB } from '@/data/industryVocab'
import { commonModules, GROUPS_TAIL } from './shared'
import { funnelSeries, series } from './kit'
import { customTab, t, type IndustryDef, type ModuleDef } from './types'

/* ---------------------------------------------------------------------------
   Healthcare ERP / HIMS — patient records, outpatient and inpatient flow, OT,
   diagnostics, pharmacy, revenue cycle with TPA claims, accreditation and
   biomedical assets, over the shared finance/people/procurement back office.
   --------------------------------------------------------------------------- */

const CORE: ModuleDef[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview', custom: 'industry-dashboard', tabs: [] },

  {
    id: 'patients', label: 'Patient Registry', icon: Users, group: 'Patient Care',
    primaryAction: 'Register patient',
    tabs: [
      t('Patient master', ['id:UHID', 'person:Patient', 'int:Age', 'text:Gender@Male,Female,Other', 'phone:Phone', 'city:City', 'company:Payer', 'status:Status@Active,Inactive,Deceased,Merged'], 60),
      t('Registrations', ['id:Registration No', 'person:Patient', 'date:Registered On', 'source:Source', 'program:Department', 'campus:Facility', 'status:Type@New,Revisit,Emergency,Referral'], 56),
      t('Medical records', ['id:UHID', 'person:Patient', 'program:Speciality', 'text:Diagnosis@Hypertension,Type 2 Diabetes,Coronary Artery Disease,Fracture,Asthma,Anaemia,Appendicitis', 'date:Last Updated', 'person:Treating Doctor', 'status:Record@Complete,Pending Notes,Under Coding'], 58),
      t('Consent & legal forms', ['id:UHID', 'person:Patient', 'text:Form@General Consent,Surgical Consent,Anaesthesia Consent,High Risk Consent,DNR,Data Sharing', 'date:Signed', 'person:Witness', 'status:Status@Signed,Pending,Refused,Expired'], 44),
      t('Referrals', ['person:Patient', 'person:Referred By', 'program:To Speciality', 'date:Referred On', 'text:Reason@Second opinion,Specialist care,Diagnostics,Surgery,Transfer', 'status:Status@Open,Accepted,Completed,Declined'], 36),
    ],
  },
  {
    id: 'outpatient', label: 'Outpatient', icon: Stethoscope, group: 'Patient Care',
    primaryAction: 'Book appointment',
    tabs: [
      t('Appointments', ['id:Appointment No', 'person:Patient', 'person:Doctor', 'program:Speciality', 'datefuture:Date', 'time:Slot', 'status:Status@Booked,Checked In,In Consultation,Completed,No Show,Cancelled'], 60),
      t('Consultation notes', ['id:Visit No', 'person:Patient', 'person:Doctor', 'program:Speciality', 'date:Visit Date', 'sem:Visit Type', 'status:Notes@Completed,Draft,Pending Sign-off'], 54),
      t('e-Prescriptions', ['id:Prescription No', 'person:Patient', 'person:Doctor', 'text:Drug@Metformin 500mg,Amlodipine 5mg,Atorvastatin 10mg,Azithromycin 500mg,Pantoprazole 40mg,Insulin Glargine', 'text:Duration@3 Days,5 Days,7 Days,14 Days,30 Days', 'date:Issued', 'status:Status@Issued,Dispensed,Partially Dispensed,Cancelled'], 58),
      t('Doctor schedules', ['person:Doctor', 'program:Speciality', 'campus:Facility', 'batch:Session', 'int:Slots', 'int:Booked', 'pct:Utilisation', 'status:Status@Available,Full,On Leave,Blocked'], 40),
      t('Vitals', ['person:Patient', 'date:Recorded', 'text:BP@118/76,128/84,142/92,110/70,136/88', 'int:Pulse', 'int:SpO2', 'text:Temp@98.4 F,99.2 F,100.8 F,97.8 F', 'status:Flag@Normal,Watch,Abnormal'], 52),
    ],
  },
  {
    id: 'inpatient', label: 'Inpatient & Wards', icon: BedDouble, group: 'Patient Care',
    primaryAction: 'Admit patient',
    tabs: [
      customTab('Bed board', 'hc-bed-board'),
      t('Admissions', ['id:IP No', 'person:Patient', 'program:Speciality', 'person:Consultant', 'room:Bed', 'date:Admitted On', 'text:Class@General,Semi-private,Private,Deluxe,ICU', 'status:Status@Admitted,Under Treatment,For Discharge,Discharged'], 54),
      t('Bed & ward management', ['room:Bed', 'campus:Facility', 'text:Ward@General Ward,Semi-private,Private,ICU,HDU,Maternity', 'person:Occupant', 'text:Class@General,Semi-private,Private,Deluxe,ICU', 'status:Status@Occupied,Available,Reserved,Under Cleaning,Blocked'], 60),
      t('Nursing care charts', ['person:Patient', 'room:Bed', 'sem:Shift', 'person:Nurse', 'text:Chart@Vitals,Intake-Output,Medication,Wound Care,Fall Risk', 'time:Recorded', 'status:Status@Recorded,Pending,Escalated'], 58),
      t('Transfers', ['id:IP No', 'person:Patient', 'room:From Bed', 'room:To Bed', 'date:Transferred', 'text:Reason@Clinical escalation,Class upgrade,Ward consolidation,Isolation', 'status:Status@Requested,Completed,Rejected'], 32),
      t('Discharge summaries', ['id:IP No', 'person:Patient', 'person:Consultant', 'date:Discharge Date', 'int:Length of Stay', 'grade:Condition', 'status:Status@Draft,Signed,Handed Over,Pending Coding'], 46),
    ],
  },
  {
    id: 'theatre', label: 'Operation Theatre', icon: Syringe, group: 'Clinical Services',
    primaryAction: 'Schedule surgery',
    tabs: [
      t('OT schedule', ['id:OT Booking', 'person:Patient', 'course:Procedure', 'person:Surgeon', 'room:Theatre', 'datefuture:Scheduled', 'time:Slot', 'status:Status@Scheduled,In Theatre,Completed,Postponed,Cancelled'], 46),
      t('Surgical consumables', ['id:OT Booking', 'course:Procedure', 'text:Item@Suture,Implant,Surgical Mesh,Stapler,Drape Pack,Gloves', 'int:Issued', 'int:Consumed', 'int:Returned', 'money:Value', 'status:Status@Reconciled,Pending,Variance'], 48),
      t('Anaesthesia records', ['person:Patient', 'course:Procedure', 'person:Anaesthetist', 'text:Type@General,Spinal,Local,Regional,Sedation', 'int:Duration (Min)', 'grade:Recovery', 'status:Status@Completed,Under Observation,Complication'], 38),
      t('OT utilisation', ['room:Theatre', 'campus:Facility', 'date:Date', 'int:Cases', 'int:Utilised Minutes', 'pct:Utilisation', 'int:Turnaround (Min)', 'status:Status@Optimal,Underused,Overrun'], 32),
      t('Post-op tracking', ['person:Patient', 'course:Procedure', 'date:Surgery Date', 'grade:Status', 'text:Complication@None,Infection,Bleeding,Delayed Recovery', 'datefuture:Review Due', 'status:Follow-up@Scheduled,Completed,Missed'], 40),
    ],
  },
  {
    id: 'diagnostics', label: 'Diagnostics', icon: Microscope, group: 'Clinical Services',
    primaryAction: 'Create lab order',
    tabs: [
      t('Lab orders', ['id:Order No', 'person:Patient', 'course:Investigation', 'person:Ordered By', 'date:Ordered', 'text:Priority@Routine,Urgent,STAT', 'status:Status@Ordered,Sample Collected,In Process,Reported,Cancelled'], 60),
      t('Lab results', ['id:Order No', 'person:Patient', 'course:Investigation', 'text:Result@Within Range,Borderline,Abnormal,Critical', 'date:Reported', 'person:Verified By', 'status:Status@Reported,Pending Verification,Amended'], 56),
      t('Radiology orders', ['id:Order No', 'person:Patient', 'course:Study', 'room:Modality Room', 'datefuture:Scheduled', 'person:Radiologist', 'status:Status@Ordered,Scheduled,Performed,Reported'], 48),
      t('Sample tracking', ['code:Barcode', 'person:Patient', 'text:Sample@Blood,Urine,Swab,Tissue,Sputum,CSF', 'time:Collected', 'room:Lab Station', 'int:TAT (Min)', 'status:Status@Collected,In Transit,Received,Rejected,Processed'], 58),
      t('Critical alerts', ['person:Patient', 'course:Investigation', 'text:Value@Potassium 6.8,Troponin High,Hb 5.2,Platelet 22K,Glucose 480', 'time:Alerted', 'person:Notified Doctor', 'status:Status@Acknowledged,Pending,Escalated'], 26),
    ],
  },
  {
    id: 'pharmacy', label: 'Pharmacy', icon: Pill, group: 'Clinical Services',
    primaryAction: 'Dispense medication',
    tabs: [
      t('Stock & batches', ['code:Item Code', 'text:Drug@Metformin 500mg,Amlodipine 5mg,Atorvastatin 10mg,Azithromycin 500mg,Pantoprazole 40mg,Insulin Glargine,Paracetamol 650mg', 'code:Batch', 'int:Quantity', 'datefuture:Expiry', 'money:Value', 'status:Status@In Stock,Low Stock,Expiring,Expired,Out of Stock'], 60),
      t('Dispensing', ['id:Dispense No', 'person:Patient', 'text:Type@Outpatient,Inpatient,Emergency,Discharge', 'text:Drug@Metformin 500mg,Amlodipine 5mg,Atorvastatin 10mg,Azithromycin 500mg,Insulin Glargine', 'int:Quantity', 'money:Value', 'status:Status@Dispensed,Partially Dispensed,Returned,Cancelled'], 58),
      t('Drug interaction alerts', ['person:Patient', 'text:Drug A@Warfarin,Metformin,Atorvastatin,Aspirin', 'text:Drug B@Aspirin,Contrast Dye,Clarithromycin,Ibuprofen', 'text:Severity@Minor,Moderate,Severe', 'person:Prescriber', 'status:Action@Overridden,Changed,Pending Review'], 28),
      t('Indents & purchase', ['id:Indent No', 'vendor:Supplier', 'text:Drug@Metformin 500mg,Insulin Glargine,Azithromycin 500mg,IV Fluids,Surgical Consumables', 'int:Quantity', 'datefuture:Required By', 'status:Status@Raised,Approved,Ordered,Received'], 44),
      t('Narcotics register', ['code:Register No', 'text:Drug@Morphine,Fentanyl,Midazolam,Pethidine', 'int:Opening', 'int:Issued', 'int:Balance', 'person:Custodian', 'status:Status@Reconciled,Variance,Under Audit'], 24),
    ],
  },
  {
    id: 'revenue-cycle', label: 'Revenue Cycle', icon: Wallet, group: 'Revenue & Payers',
    primaryAction: 'Generate bill',
    tabs: [
      t('Patient billing', ['id:Bill No', 'person:Patient', 'text:Type@Outpatient,Inpatient,Day Care,Emergency,Package', 'money:Gross', 'money:Discount', 'money:Payable', 'status:Status@Draft,Raised,Part Paid,Settled,Written Off'], 58),
      t('Tariff & packages', ['code:Tariff Code', 'course:Service', 'company:Payer', 'money:Rate', 'text:Package@Standalone,Surgical Package,Maternity Package,Health Check', 'date:Effective From', 'status:Status@Active,Scheduled,Withdrawn'], 46),
      t('Insurance & TPA claims', ['id:Claim No', 'person:Patient', 'company:Payer', 'money:Claimed', 'money:Approved', 'money:Deduction', 'date:Submitted', 'status:Status@Submitted,Query Raised,Approved,Partially Approved,Rejected,Settled'], 54),
      t('Pre-authorisation', ['id:Pre-auth No', 'person:Patient', 'company:Payer', 'course:Procedure', 'money:Estimated', 'money:Sanctioned', 'datefuture:Valid Till', 'status:Status@Requested,Query,Approved,Denied,Expired'], 44),
      t('Payer receivables', ['company:Payer', 'money:Billed', 'money:Received', 'money:Outstanding', 'int:Days Outstanding', 'pct:Deduction Rate', 'status:Status@Current,Overdue,Under Reconciliation,Escalated'], 34),
      t('Refunds & write-offs', ['id:Bill No', 'person:Patient', 'money:Amount', 'text:Reason@Advance excess,Service not rendered,Claim settled,Goodwill,Bad debt', 'person:Approved By', 'status:Status@Requested,Approved,Processed,Rejected'], 30),
    ],
  },
  {
    id: 'accreditation', label: 'Quality & Accreditation', icon: ShieldCheck, group: 'Compliance',
    primaryAction: 'Log indicator',
    tabs: [
      t('NABH/JCI evidence', ['code:Standard', 'text:Chapter@Access Assessment & Continuity,Care of Patients,Management of Medication,Patient Rights,Infection Control,Facility Management', 'person:Owner', 'datefuture:Review Due', 'pct:Compliance', 'status:Status@Compliant,Partial,Non-compliant,Under Review'], 44),
      t('Quality indicators', ['text:Indicator@Medication error rate,Hospital acquired infection,Readmission within 30 days,Mortality rate,Patient fall rate,Average length of stay', 'text:Period@Jun 2026,Jul 2026,Aug 2026', 'pct:Value', 'pct:Benchmark', 'status:Trend@Improving,Stable,Deteriorating'], 36),
      t('Infection control', ['campus:Facility', 'text:Area@ICU,OT,General Ward,NICU,Dialysis', 'text:Check@Hand hygiene audit,Surface culture,Air quality,Sterilisation validation', 'date:Date', 'pct:Compliance', 'status:Result@Passed,Observation,Failed'], 42),
      t('Biomedical waste', ['campus:Facility', 'date:Date', 'text:Category@Yellow,Red,White,Blue', 'int:Weight (Kg)', 'vendor:Disposal Agency', 'status:Status@Collected,In Transit,Disposed,Discrepancy'], 48),
      t('Incidents & sentinel events', ['id:Incident No', 'campus:Facility', 'text:Type@Medication error,Patient fall,Wrong site,Needle stick,Equipment failure,Complaint', 'date:Reported', 'text:Severity@Near Miss,Minor,Major,Sentinel', 'status:Status@Reported,Under RCA,CAPA Issued,Closed'], 38),
    ],
  },
  {
    id: 'biomedical', label: 'Biomedical Assets', icon: Wrench, group: 'Compliance',
    primaryAction: 'Add equipment',
    tabs: [
      t('Equipment register', ['code:Asset No', 'text:Equipment@Ventilator,Defibrillator,Ultrasound,CT Scanner,MRI,Dialysis Machine,Anaesthesia Workstation,Infusion Pump', 'campus:Facility', 'room:Location', 'money:Book Value', 'date:Installed', 'status:Status@Working,Under Maintenance,Breakdown,Condemned'], 48),
      t('Calibration & PM', ['code:Asset No', 'text:Activity@Calibration,Preventive Maintenance,Safety Test,Software Update', 'date:Last Done', 'datefuture:Next Due', 'vendor:Service Partner', 'status:Status@Compliant,Due,Overdue'], 44),
      t('Breakdowns', ['id:Ticket No', 'code:Asset No', 'date:Reported', 'int:Downtime (Hrs)', 'money:Repair Cost', 'vendor:Service Partner', 'status:Status@Open,Under Repair,Resolved,Awaiting Spare'], 36),
      t('AMC & warranty', ['code:Asset No', 'vendor:Vendor', 'text:Cover@Warranty,Comprehensive AMC,Labour AMC,None', 'money:Annual Cost', 'datefuture:Expiry', 'status:Status@Active,Expiring,Expired'], 32),
    ],
  },
  {
    id: 'emergency', label: 'Emergency & Ambulance', icon: Ambulance, group: 'Patient Care',
    tabs: [
      t('Emergency cases', ['id:Case No', 'person:Patient', 'time:Arrival', 'text:Triage@Red,Yellow,Green,Black', 'text:Complaint@Chest pain,Trauma,Breathlessness,Poisoning,Seizure,Burns', 'person:Attending Doctor', 'status:Disposition@Under Treatment,Admitted,Discharged,Referred,LAMA'], 46),
      t('Ambulance fleet', ['code:Vehicle No', 'text:Type@Basic Life Support,Advanced Life Support,Patient Transport', 'campus:Base', 'person:Driver', 'datefuture:Fitness Expiry', 'status:Status@Available,On Call,Under Maintenance'], 22),
      t('Ambulance trips', ['id:Trip No', 'code:Vehicle No', 'person:Patient', 'city:Pickup', 'campus:Drop Facility', 'time:Dispatch', 'int:Response (Min)', 'status:Status@Dispatched,On Scene,Completed,Cancelled'], 38),
      t('Triage board', ['person:Patient', 'text:Triage@Red,Yellow,Green', 'int:Wait (Min)', 'room:Bay', 'person:Nurse', 'status:Status@Waiting,In Assessment,In Treatment,Ready for Decision'], 30),
    ],
  },
]

const DASH: IndustryDef['dashboard'] = {
  greeting: 'Clinical operations · 6 facilities, 842 beds',
  primaryAction: { label: 'Register patient', to: '/patients' },
  kpis: [
    { label: 'OPD footfall (MTD)', value: '24,180', delta: '+6.2%', up: true, icon: Stethoscope, to: '/outpatient' },
    { label: 'Inpatients today', value: '612', delta: '+18', up: true, icon: BedDouble, to: '/inpatient' },
    { label: 'Bed occupancy', value: '72.7%', delta: '+2.4%', up: true, icon: Activity, to: '/inpatient' },
    { label: 'Surgeries (MTD)', value: '486', delta: '+31', up: true, icon: Syringe, to: '/theatre' },
    { label: 'Revenue (MTD)', value: '₹38.4 Cr', delta: '+7.8%', up: true, icon: Wallet, to: '/revenue-cycle' },
    { label: 'Claims outstanding', value: '₹14.2 Cr', delta: '-5.1%', up: true, icon: ClipboardPlus, to: '/revenue-cycle' },
    { label: 'Avg length of stay', value: '3.8 days', delta: '-0.2', up: true, icon: HeartPulse, to: '/inpatient' },
    { label: 'Lab TAT (routine)', value: '4.2 hrs', delta: '-0.6', up: true, icon: FlaskConical, to: '/diagnostics' },
  ],
  secondary: [
    { label: 'Facilities', value: '6', icon: Activity },
    { label: 'Doctors on roll', value: '284', icon: Stethoscope },
    { label: 'Nursing staff', value: '918', icon: Users },
    { label: 'OT utilisation', value: '76.4%', icon: Syringe },
    { label: 'Pharmacy stock value', value: '₹6.8 Cr', icon: Pill },
    { label: 'Equipment overdue PM', value: '11', icon: Wrench },
  ],
  trend: {
    title: 'Patient volume',
    subtitle: 'Outpatient vs inpatient, monthly (hundreds)',
    data: series(6101, [{ key: 'opd', min: 180, max: 260 }, { key: 'ipd', min: 40, max: 78 }]),
    keys: [{ key: 'opd', label: 'OPD' }, { key: 'ipd', label: 'IPD' }],
  },
  mix: {
    title: 'Revenue by speciality',
    subtitle: '₹ lakh, this month',
    data: [
      { name: 'Cardiology', value: 842 }, { name: 'Orthopaedics', value: 616 },
      { name: 'Oncology', value: 528 }, { name: 'General Surgery', value: 462 },
      { name: 'Obs & Gynae', value: 388 }, { name: 'Nephrology', value: 304 },
    ],
  },
  funnel: {
    title: 'Claims pipeline',
    subtitle: 'Submitted → approved → settled',
    data: funnelSeries(6202, ['submitted', 'approved', 'settled'], [420, 640], [0.78, 0.94]),
    keys: [{ key: 'submitted', label: 'Submitted' }, { key: 'approved', label: 'Approved' }, { key: 'settled', label: 'Settled' }],
  },
  money: {
    title: 'Revenue vs operating cost',
    subtitle: '₹ crore, monthly',
    data: series(6303, [{ key: 'revenue', min: 28, max: 42, decimals: 2 }, { key: 'cost', min: 20, max: 32, decimals: 2 }]),
    keys: [{ key: 'revenue', label: 'Revenue' }, { key: 'cost', label: 'Operating cost' }],
  },
  progress: {
    title: 'Bed occupancy by ward',
    subtitle: 'Occupied against available beds',
    unit: ' beds',
    rows: [
      { name: 'General Ward', done: 218, total: 280 },
      { name: 'Semi-private', done: 96, total: 140 },
      { name: 'Private', done: 88, total: 110 },
      { name: 'ICU', done: 74, total: 88 },
      { name: 'Maternity', done: 52, total: 74 },
    ],
  },
  approvals: [
    { id: 'PA-2214', type: 'Pre-authorisation', detail: 'Angioplasty — Star Health', value: '₹3,80,000', age: '4 hours' },
    { id: 'WO-0148', type: 'Write-off request', detail: 'Charity case — general ward', value: '₹1,24,000', age: '1 day' },
    { id: 'PR-3390', type: 'Purchase requisition', detail: '2 infusion pumps — ICU', value: '₹6,40,000', age: '2 days' },
    { id: 'CR-0092', type: 'Credit note', detail: 'Duplicate billing — UHID 84120', value: '₹48,600', age: '6 hours' },
    { id: 'LV-1187', type: 'Leave request', detail: 'Dr. Meera Nair — 4 days', value: '4 days', age: '1 day' },
  ],
  alerts: [
    { tone: 'red', title: '3 critical lab values unacknowledged', detail: 'Beyond the 30-minute escalation window' },
    { tone: 'amber', title: '48 drug batches expiring within 30 days', detail: 'Pharmacy stock worth ₹18.4 L' },
    { tone: 'amber', title: 'TPA claims worth ₹4.6 Cr pending beyond 45 days', detail: 'Star Health and Niva Bupa' },
    { tone: 'blue', title: '11 biomedical assets overdue for preventive maintenance', detail: 'Including 2 ventilators' },
  ],
  activityVerbs: [
    'admitted a patient under', 'discharged a patient from', 'signed the discharge summary for',
    'submitted a TPA claim to', 'approved a pre-authorisation from', 'reported a critical value in',
    'scheduled a surgery in', 'dispensed medication for', 'logged an infection control audit at',
    'closed an incident RCA in', 'completed preventive maintenance on', 'updated the tariff for',
  ],
  recent: {
    title: 'Recent admissions',
    action: 'Open inpatient',
    to: '/inpatient',
    rows: [
      { id: 'IP-40218', name: 'Aarav Sharma', sub: 'Cardiology · ICU Bed 04', stage: 'Under Treatment' },
      { id: 'IP-40217', name: 'Ananya Iyer', sub: 'Obs & Gynae · Private 210', stage: 'For Discharge' },
      { id: 'IP-40216', name: 'Rohan Desai', sub: 'Orthopaedics · Ward 3-A', stage: 'Admitted' },
      { id: 'IP-40215', name: 'Meera Nair', sub: 'Nephrology · Dialysis Bay 6', stage: 'Under Treatment' },
      { id: 'IP-40214', name: 'Kabir Menon', sub: 'General Surgery · Ward 3-B', stage: 'Discharged' },
      { id: 'IP-40213', name: 'Diya Reddy', sub: 'Paediatrics · Deluxe 305', stage: 'Admitted' },
      { id: 'IP-40212', name: 'Imran Qureshi', sub: 'Pulmonology · ICU Bed 09', stage: 'Under Treatment' },
      { id: 'IP-40211', name: 'Sneha Banerjee', sub: 'Oncology · Private 210', stage: 'For Discharge' },
    ],
  },
  tasks: [
    { title: 'Acknowledge 3 critical lab values', due: 'Today', done: false },
    { title: 'Submit NABH chapter 4 evidence', due: 'Tomorrow', done: false },
    { title: 'Clear 22 unsigned discharge summaries', due: '13 Aug', done: false },
    { title: 'Approve July pharmacy indents', due: 'Completed', done: true },
    { title: 'Review Star Health deduction pattern', due: '19 Aug', done: false },
  ],
  announcements: [
    { title: 'Revised surgical package tariff effective 1 Sep 2026', by: 'Billing & TPA', time: '2h ago', pinned: true },
    { title: 'Hand hygiene audit rounds move to twice weekly', by: 'Infection Control', time: 'Yesterday', pinned: true },
    { title: 'New MRI slot template published for Pune', by: 'Radiology', time: '3 days ago', pinned: false },
    { title: 'Narcotics register to be reconciled every shift', by: 'Pharmacy', time: '4 days ago', pinned: false },
  ],
  events: [
    { name: 'NABH internal audit', date: '12 Aug 2026', venue: 'Bengaluru' },
    { name: 'Cardiology CME', date: '14 Aug 2026', venue: 'Auditorium' },
    { name: 'Free health camp', date: '17 Aug 2026', venue: 'Mysuru Day Care' },
    { name: 'Fire drill — all wards', date: '20 Aug 2026', venue: 'All facilities' },
    { name: 'TPA reconciliation meeting', date: '24 Aug 2026', venue: 'Finance Office' },
    { name: 'Blood donation drive', date: '27 Aug 2026', venue: 'Chennai' },
    { name: 'Monthly clinical review', date: '31 Aug 2026', venue: 'Board Room' },
  ],
  calendar: { 12: ['NABH audit'], 14: ['Cardiology CME'], 17: ['Health camp'], 20: ['Fire drill'], 24: ['TPA meeting'], 27: ['Blood drive'], 31: ['Clinical review'] },
  ranking: {
    title: 'Speciality performance',
    subtitle: 'Occupancy and throughput index',
    rows: [
      { name: 'Cardiology', value: 91 }, { name: 'Orthopaedics', value: 84 },
      { name: 'Oncology', value: 78 }, { name: 'Obs & Gynae', value: 72 },
      { name: 'Nephrology', value: 66 }, { name: 'Paediatrics', value: 61 },
    ],
  },
}

export const HEALTHCARE: IndustryDef = {
  id: 'healthcare',
  label: 'Healthcare',
  tagline: 'Patients, wards, diagnostics and claims',
  blurb: 'Register once, follow the patient through OPD, wards, theatre and pharmacy, and close the loop with TPA claims and NABH evidence.',
  icon: Stethoscope,
  product: 'Vivencia CareCloud',
  productSub: 'Healthcare ERP Suite',
  user: { name: 'Priya Raghavan', defaultRole: 'medical-director' },
  modules: [...CORE, ...commonModules({ customer: 'Payer', customers: 'Payers', jobLabel: 'Speciality' })],
  groupOrder: ['Overview', 'Patient Care', 'Clinical Services', 'Revenue & Payers', 'Compliance', ...GROUPS_TAIL],
  roles: [
    { id: 'medical-director', label: 'Medical Director', scope: 'All facilities', modules: '*' },
    { id: 'consultant', label: 'Consultant', scope: 'Cardiology', modules: ['dashboard', 'outpatient', 'inpatient', 'theatre', 'diagnostics', 'patients'] },
    { id: 'nursing-head', label: 'Nursing Head', scope: 'Bengaluru facility', modules: ['dashboard', 'inpatient', 'emergency', 'pharmacy', 'attendance', 'accreditation'] },
    { id: 'front-office', label: 'Front Office', scope: 'Registration & OPD', modules: ['dashboard', 'patients', 'outpatient', 'revenue-cycle', 'emergency'] },
    { id: 'billing-tpa', label: 'Billing & TPA', scope: 'Revenue cycle', modules: ['dashboard', 'revenue-cycle', 'receivables', 'crm', 'tax', 'analytics'] },
    { id: 'lab-manager', label: 'Lab Manager', scope: 'Pathology & radiology', modules: ['dashboard', 'diagnostics', 'purchasing', 'biomedical', 'accreditation'] },
    { id: 'pharmacist', label: 'Pharmacist', scope: 'Central pharmacy', modules: ['dashboard', 'pharmacy', 'purchasing', 'sourcing'] },
    { id: 'quality-manager', label: 'Quality Manager', scope: 'Accreditation', modules: ['dashboard', 'accreditation', 'biomedical', 'talent', 'admin'] },
  ],
  vocab: HEALTHCARE_VOCAB,
  scope: {
    orgLabel: 'Entity', orgs: ['Vivencia Healthcare Ltd', 'Vivencia Heart Institute', 'Vivencia Clinics'],
    siteLabel: 'Facility', sites: HEALTHCARE_VOCAB.campus,
    periodLabel: 'Financial year', periods: ['FY 2026–27', 'FY 2025–26', 'FY 2024–25'],
  },
  quickCreate: [
    { label: 'Register patient', to: '/patients' }, { label: 'Book appointment', to: '/outpatient' },
    { label: 'Admit patient', to: '/inpatient' }, { label: 'Schedule surgery', to: '/theatre' },
    { label: 'Create lab order', to: '/diagnostics' }, { label: 'Dispense medication', to: '/pharmacy' },
    { label: 'Generate patient bill', to: '/revenue-cycle' }, { label: 'Raise pre-authorisation', to: '/revenue-cycle' },
    { label: 'Log an incident', to: '/accreditation' }, { label: 'Report equipment breakdown', to: '/biomedical' },
  ],
  notifications: [
    { title: '3 critical lab values unacknowledged', desc: 'Diagnostics · beyond escalation window', time: '6m ago' },
    { title: 'ICU occupancy crossed 84%', desc: 'Inpatient & Wards · Bengaluru', time: '38m ago' },
    { title: '48 drug batches expiring within 30 days', desc: 'Pharmacy', time: '2h ago' },
    { title: 'Pre-auth PA-2214 queried by Star Health', desc: 'Revenue Cycle', time: '4h ago' },
    { title: 'NABH chapter 4 evidence pending from 3 departments', desc: 'Quality & Accreditation', time: 'Yesterday' },
  ],
  messages: [
    { from: 'Dr. Meera Nair', text: 'Please move the 11:00 angiography to OT-2.', time: '09:12' },
    { from: 'Rohan Desai', text: 'TPA wants the discharge summary for IP-40214.', time: '08:40' },
    { from: 'Nursing — Ward 3-B', text: '2 beds ready after cleaning.', time: 'Yesterday' },
  ],
  dashboard: DASH,
  searchHint: 'Search patients, bills, orders…',
  highlights: ['UHID to discharge on one record', 'TPA claims with deduction analysis', 'NABH evidence built from daily work'],
}
