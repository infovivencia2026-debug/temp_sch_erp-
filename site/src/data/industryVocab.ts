/* ---------------------------------------------------------------------------
   Cross-industry vocabulary.

   The generator, the tables and the whole UI are shared across verticals —
   only the word pools change. A construction deployment reads
   "Sector 62 IT Park / Piling" exactly where a hospital reads
   "Cardiology / Angiography", with no branching in the components.
   --------------------------------------------------------------------------- */

export interface VocabPools {
  /** Column type `program` — the primary thing work belongs to. */
  program: string[]
  /** Column type `course` — the unit of work. */
  course: string[]
  /** Column type `dept`. */
  dept: string[]
  /** Column type `campus` — physical location. */
  campus: string[]
  /** Column type `room` — sub-location. */
  room: string[]
  /** Column type `company` — customers / clients / payers. */
  company: string[]
  /** Column type `vendor` — suppliers / partners. */
  vendor: string[]
  /** Column type `grade`. */
  grade: string[]
  /** Column type `source`. */
  source: string[]
  /** Column type `sem` — the recurring period label. */
  sem: string[]
  /** Column type `batch`. */
  batch: string[]
  /** Domain used for generated e-mail addresses. */
  domain: string
}

/* ------------------------------------------------------------ Construction */
export const CONSTRUCTION_VOCAB: VocabPools = {
  program: [
    'Sector 62 IT Park', 'Riverside Residency Phase 2', 'Metro Line 4 — Viaduct',
    'Hosur Road Flyover', 'Kalyan Township Block C', 'Coastal Highway Package 3',
    'Airport Terminal Expansion', 'Whitefield Data Centre', 'Municipal STP Upgrade',
    'Industrial Warehouse — Bhiwandi', 'Heritage Hotel Retrofit', 'Solar Park Substation',
  ],
  course: [
    'Excavation', 'Piling', 'Raft Foundation', 'Column Casting', 'Slab Shuttering',
    'Reinforcement Binding', 'Concrete Pour', 'Blockwork', 'Internal Plaster',
    'Waterproofing', 'MEP Rough-in', 'Ducting', 'Fire Fighting Lines', 'Flooring',
    'Painting', 'Facade Glazing', 'Road Sub-base', 'Bituminous Layer', 'Landscaping',
  ],
  dept: [
    'Civil', 'Structural', 'MEP', 'Electrical', 'Plumbing', 'HVAC', 'Finishes',
    'Planning', 'Quantity Surveying', 'Safety (HSE)', 'Quality', 'Stores', 'Plant & Machinery',
  ],
  campus: [
    'Sector 62 Site — Noida', 'Riverside Site — Pune', 'Metro Depot — Chennai',
    'Hosur Road Site — Bengaluru', 'Kalyan Site — Mumbai', 'Coastal Package — Mangaluru',
  ],
  room: [
    'Tower A', 'Tower B', 'Basement B1', 'Podium Level', 'Batching Plant', 'Site Store',
    'Labour Camp', 'Site Office', 'Chainage 4+200', 'Pier P-14',
  ],
  company: [
    'DLF Developers', 'Godrej Properties', 'NHAI', 'Bengaluru Metro Rail', 'Prestige Estates',
    'Adani Infra', 'Tata Realty', 'PWD Karnataka', 'Brigade Group', 'Embassy Group',
  ],
  vendor: [
    'UltraTech Cement', 'Tata Steel Rebar', 'Shree Formwork Rentals', 'Aggarwal Earthmovers',
    'Sai Electricals Contractor', 'Deccan Plumbing Works', 'Kone Elevators', 'Asian Paints Contract',
    'Prism RMC', 'Godrej Interio Contract',
  ],
  grade: ['M20', 'M25', 'M30', 'M35', 'M40', 'Fe500', 'Fe550'],
  source: ['GeM Tender', 'Private Invite', 'Nominated', 'Open Tender', 'Repeat Client', 'JV Partner'],
  sem: ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4'],
  batch: ['Package A', 'Package B', 'Package C', 'Package D'],
  domain: 'vivenciainfra.com',
}

/* ---------------------------------------------------------------- Logistics */
export const LOGISTICS_VOCAB: VocabPools = {
  program: [
    'Bengaluru → Chennai', 'Mumbai → Delhi', 'Pune → Hyderabad', 'Kolkata → Guwahati',
    'Chennai → Kochi', 'Delhi → Jaipur', 'Ahmedabad → Mumbai', 'Nagpur → Raipur',
    'JNPT → Bengaluru', 'Mundra → Ludhiana', 'Vizag → Hyderabad', 'Coimbatore → Bengaluru',
  ],
  course: [
    'FTL Road', 'LTL Road', 'Rail Container', 'Air Freight', 'Ocean FCL', 'Ocean LCL',
    'First Mile Pickup', 'Line Haul', 'Last Mile Delivery', 'Cross-dock', 'Cold Chain',
    'ODC Movement', 'Reverse Logistics', 'Bonded Movement',
  ],
  dept: [
    'Booking Desk', 'Load Planning', 'Fleet Operations', 'Warehouse', 'Line Haul',
    'Last Mile', 'Carrier Management', 'Freight Billing', 'Claims', 'Compliance', 'Control Tower',
  ],
  campus: [
    'Bhiwandi Hub — Mumbai', 'Nelamangala Hub — Bengaluru', 'Sriperumbudur DC — Chennai',
    'Bhiwadi DC — Delhi NCR', 'Sanand Hub — Ahmedabad', 'Dankuni Hub — Kolkata',
  ],
  room: [
    'Dock 01', 'Dock 02', 'Dock 07', 'Bin A-14', 'Bin B-22', 'Rack C-3', 'Cold Room 1',
    'Staging Bay', 'Yard Slot 12', 'Quarantine Bay',
  ],
  company: [
    'Hindustan Unilever', 'Amazon India', 'Flipkart', 'Reliance Retail', 'Asian Paints',
    'Nestle India', 'Maruti Suzuki', 'Tata Motors', 'Dabur', 'Havells', 'Zepto', 'Bosch India',
  ],
  vendor: [
    'VRL Logistics', 'TCI Freight', 'Gati Carriers', 'Delhivery Line Haul', 'Rivigo Fleet',
    'Sri Balaji Transports', 'Kesineni Cargo', 'Concor Rail', 'Blue Dart Aviation',
  ],
  grade: ['A+', 'A', 'B+', 'B', 'C'],
  source: ['Spot Market', 'Contract', 'Freight Exchange', 'Direct Enquiry', 'Broker', 'Portal'],
  sem: ['Leg 1', 'Leg 2', 'Leg 3', 'Return Leg'],
  batch: ['Wave 1', 'Wave 2', 'Wave 3', 'Night Wave'],
  domain: 'vivenciacargo.com',
}

/* --------------------------------------------------------------- Healthcare */
export const HEALTHCARE_VOCAB: VocabPools = {
  program: [
    'Cardiology', 'Orthopaedics', 'General Medicine', 'General Surgery', 'Paediatrics',
    'Obstetrics & Gynaecology', 'Neurology', 'Nephrology', 'Oncology', 'Pulmonology',
    'Gastroenterology', 'Dermatology', 'ENT', 'Ophthalmology', 'Psychiatry', 'Emergency Medicine',
  ],
  course: [
    'OP Consultation', 'Follow-up Visit', 'Angiography', 'Angioplasty', 'Knee Replacement',
    'Appendectomy', 'LSCS Delivery', 'Dialysis Session', 'Chemotherapy Cycle', 'Cataract Surgery',
    'Endoscopy', 'Physiotherapy', 'CT Scan', 'MRI Brain', 'Blood Culture', 'Lipid Profile',
    'Complete Blood Count', 'ECG', 'Ultrasound Abdomen',
  ],
  dept: [
    'Outpatient', 'Inpatient', 'Emergency', 'Operation Theatre', 'ICU', 'Radiology',
    'Pathology Lab', 'Pharmacy', 'Nursing', 'Blood Bank', 'Physiotherapy', 'Dietetics',
    'Medical Records', 'Biomedical Engineering', 'Housekeeping', 'Billing & TPA',
  ],
  campus: [
    'Vivencia Hospital — Bengaluru', 'Vivencia Hospital — Chennai', 'Vivencia Heart Institute — Pune',
    'Vivencia Clinic — Kochi', 'Vivencia Hospital — Hyderabad', 'Vivencia Day Care — Mysuru',
  ],
  room: [
    'Ward 3-A', 'Ward 3-B', 'ICU Bed 04', 'ICU Bed 09', 'OT-1', 'OT-2', 'Private Room 210',
    'Deluxe 305', 'Casualty Bay 2', 'Dialysis Bay 6',
  ],
  company: [
    'Star Health', 'HDFC Ergo', 'ICICI Lombard', 'Niva Bupa', 'New India Assurance',
    'Ayushman Bharat', 'CGHS', 'Aditya Birla Health', 'Care Health', 'Corporate — Infosys',
  ],
  vendor: [
    'Cipla', 'Sun Pharma', 'Dr Reddys Laboratories', 'Abbott India', 'Johnson & Johnson Medical',
    'Siemens Healthineers', 'GE Healthcare', 'Romsons Surgicals', 'Poly Medicure', '3M Health Care',
  ],
  grade: ['Critical', 'Serious', 'Stable', 'Recovering', 'Discharged'],
  source: ['Walk-in', 'Referral', 'Ambulance', 'Health Camp', 'Online Booking', 'Corporate Tie-up', 'Insurance Desk'],
  sem: ['First Visit', 'Follow-up 1', 'Follow-up 2', 'Review'],
  batch: ['Morning OPD', 'Evening OPD', 'Night Shift', 'Weekend Clinic'],
  domain: 'vivenciahealth.in',
}

/* ------------------------------------------------------------ Manufacturing */
export const MANUFACTURING_VOCAB: VocabPools = {
  program: [
    'Gearbox Assembly GX-200', 'Brake Disc BD-14', 'Pump Housing PH-9', 'Control Panel CP-3',
    'Alternator ALT-750', 'Valve Body VB-22', 'Compressor Head CH-5', 'Heat Exchanger HX-40',
    'Injection Moulded Cover', 'Sheet Metal Enclosure', 'Wiring Harness WH-11', 'Bearing Cage BC-6',
  ],
  course: [
    'CNC Turning', 'CNC Milling', 'Drilling', 'Grinding', 'Heat Treatment', 'Deburring',
    'Shot Blasting', 'Powder Coating', 'Welding', 'Press Forming', 'Injection Moulding',
    'Sub-assembly', 'Final Assembly', 'Leak Test', 'Balancing', 'Packing',
  ],
  dept: [
    'Machine Shop', 'Fabrication', 'Assembly', 'Paint Shop', 'Tool Room', 'Quality Assurance',
    'Production Planning', 'Stores', 'Maintenance', 'Industrial Engineering', 'Dispatch', 'R&D',
  ],
  campus: [
    'Plant 1 — Pune', 'Plant 2 — Chennai', 'Plant 3 — Pithampur', 'Foundry — Kolhapur',
    'Assembly Unit — Bengaluru', 'Export Unit — Sanand',
  ],
  room: ['Line A', 'Line B', 'Line C', 'Cell 4', 'Cell 7', 'Bay 2', 'Bay 5', 'Rack R-11', 'QC Lab', 'Bonded Store'],
  company: [
    'Tata Motors', 'Mahindra & Mahindra', 'Bajaj Auto', 'Ashok Leyland', 'Bosch India',
    'Cummins India', 'Siemens Energy', 'Schneider Electric', 'Daimler India', 'Hero MotoCorp',
  ],
  vendor: [
    'Jindal Steel', 'Hindalco Extrusions', 'Sundaram Fasteners', 'SKF Bearings', 'LAPP Cables',
    'Grindwell Norton', 'Kirloskar Castings', 'Precision Toolings', 'Anand Rubber Seals',
  ],
  grade: ['Grade A', 'Grade B', 'Rework', 'Scrap', 'Deviation Accepted'],
  source: ['OEM Contract', 'Aftermarket', 'Export Order', 'Job Work', 'Distributor', 'Direct'],
  sem: ['Shift A', 'Shift B', 'Shift C', 'General Shift'],
  batch: ['Lot 2026-A', 'Lot 2026-B', 'Lot 2026-C', 'Lot 2026-D'],
  domain: 'vivenciaworks.com',
}
