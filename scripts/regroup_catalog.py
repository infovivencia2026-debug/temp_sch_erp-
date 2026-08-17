#!/usr/bin/env python3
"""One-shot rewrite of docs/edu_features.csv into per-role workspaces.

Every role's features used to live in one or two enormous sections — faculty
carried 51 of its 53 entries under a single "Teaching Workspace" — so the
sidebar offered two things to click and one of them was a wall. This regroups
the same features into 6-10 sections per role, in the order a person working
that job would look for them, and adds the six roles that held permissions but
owned no workspace at all.

Nothing is invented and nothing is dropped: every existing row keeps its
description, scope and priority, and the script refuses to run if a feature is
not accounted for. Re-running it is a no-op.

    python3 scripts/regroup_catalog.py && make catalog
"""

import csv
import pathlib
import sys
from collections import OrderedDict

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "docs" / "edu_features.csv"

# --- regrouping: role -> ordered sections -> the features they now hold ------
# Feature names are matched exactly against the CSV, so a rename upstream fails
# loudly here rather than quietly landing everything in a catch-all.
REGROUP = {
    "Institution Admin / Principal": [
        ("Home", [
            "Executive KPIs", "Needs attention", "Today",
            "Campus KPI Overview", "Needs Attention Widget",
        ]),
        ("Students", [
            "Student directory & Student 360", "Enrollment lifecycle",
            "Certificates & documents", "Certificates & Document Templates",
            "Digital Certificate Generation", "Class & Section Promotion",
            "Disciplinary Incident Log", "Student Council Management",
            "Alumni Program Oversight",
        ]),
        ("Admissions", [
            "Admissions overview", "RTE 25% Reservation Register",
        ]),
        ("Academics", [
            "Academic structure", "Faculty allocation", "Timetable",
            "Master Timetable Generation", "Faculty Substitution Engine",
            "Academic calendar", "Academic Calendar Management",
            "Subject & Chapter Planner", "Lesson Plan Approval Queue",
            "Syllabus Coverage Tracking", "Attendance monitoring",
            "Attendance corrections",
        ]),
        ("Examinations", [
            "Exams & result status", "Performance overview",
            "Baseline Performance Analysis", "SSC Board Registration",
            "Intermediate Board Registration", "Hall Ticket Issue",
            "Board Result Import",
        ]),
        ("Fees", [
            "Fee overview", "Fee Regulatory Committee Filing",
        ]),
        ("Staff", [
            "Staff overview", "Staff Allocation & Workload",
            "360 Evaluation Oversight",
        ]),
        ("Approvals", [
            "Approvals center",
        ]),
        ("Communication", [
            "Communication", "Circular & Announcement Dispatch",
            "Parent Feedback & Grievance Hub", "School Achievements Showcase",
        ]),
        ("Compliance", [
            "UDISE+ Return Preparation", "APAAR ID Register",
            "Board Exam LOC Submission", "PARAKH & NEP Credit Framework",
            "Statutory Registers", "Child Info Reconciliation",
            "Mid-Day Meal Register", "MDM Utilisation Report",
            "Working Days & Instructional Hours", "SQAA Compliance Tracking",
        ]),
        ("Reports", [
            "Reports", "Comprehensive Attendance Report",
            "Exam & Grade Analytics", "Fee Collection Summaries",
            "Custom Report Builder",
        ]),
    ],

    "HOD / Department Head": [
        ("Home", ["Department KPIs", "Needs attention"]),
        ("My Department", [
            "Faculty directory", "Faculty allocation & workload",
            "Department academics", "Department timetable",
        ]),
        ("Students", ["Department students"]),
        ("Academics", [
            "Attendance monitoring", "Exams & marks monitoring",
            "OBE / outcomes",
        ]),
        ("Approvals", ["Approvals"]),
        ("Communication", ["Communication"]),
        ("Reports", ["Performance analytics", "Department reports"]),
    ],

    "Faculty / Teacher": [
        ("Home", ["Today's classes", "My work"]),
        ("My Classes", [
            "My classes", "Student progress", "Student At-Risk Identification",
            "Student Portfolio Builder", "Student Behavior & Demerits",
            "Montessori & Early Years Tracking", "CWSN Support Plan",
            "Language Subject Allocation",
        ]),
        ("Attendance", [
            "Take attendance", "Period-wise Student Attendance",
            "Attendance correction", "Daily Attendance Correction",
            "Absence Alert to Guardian", "Offline Attendance & Diary Capture",
        ]),
        ("Teaching", [
            "Homework / classwork", "Homework & Classwork Publisher",
            "Assignments & submissions", "Assignment Evaluation & Grading",
            "Lesson plans / content", "Lesson Plan Creation",
            "Syllabus Progress Tracker", "Teacher Digital Diary",
            "LMS Study Material Upload", "Live Virtual Class Launcher",
        ]),
        ("Marks & Assessment", [
            "Marks entry", "Gradebook", "CBSE Gradebook Marks Entry",
            "ICSE Gradebook Entry", "State Board Gradebook Entry",
            "Cambridge Gradebook Entry", "IB (PYP/MYP/DP) Gradebook",
            "Telugu Medium Marks Entry", "CCE Formative Assessment Entry",
            "CCE Summative Assessment Entry",
            "NEP Holistic Progress Card (HPC)", "PARAKH Holistic Assessment Entry",
            "Question Bank Management", "AI Examcell Paper Generator",
            "Ved AI Assessment Assistant", "Objective Online Test Creation",
            "No-OMR Exam Grading",
        ]),
        ("Timetable", [
            "My timetable", "Daily Timetable View",
            "Substitution Request Submission",
        ]),
        ("Communication", [
            "Communication", "Classroom Communication Broadcasting",
            "Remarks", "Class Teacher Remarks", "Anecdotal Records",
            "PTM Notes & Action Items",
        ]),
        ("My Profile", ["Leave & self service"]),
    ],

    "Accounts & Finance": [
        ("Home", ["Finance KPIs", "Needs attention"]),
        ("Collections", [
            "Collect payment", "Counter Fee Collection", "Receipts",
            "Online payments", "Online Payment Gateway Auto-Sync",
            "Partial & advance payments", "Partial & Advance Payment Rules",
            "Cashless Campus Wallet", "POS Canteen Terminal Integration",
            "School Store & Merchandise Sales",
            "GST Compliant Receipt Numbering",
        ]),
        ("Student Dues", [
            "Student ledger", "Student Ledger 360",
            "Defaulters & reminders", "Defaulter Tracking & Aging",
            "Automated Fee Reminders", "Late Fine Rules Engine",
            "Post-Dated Cheques (PDC) Registry", "Cheque Bounce Fine Engine",
        ]),
        ("Fee Structure", [
            "Fee structures & schedules", "Fee Head & Group Setup",
            "Class-Wise Fee Structure Configuration", "Fee Structure Versioning",
            "Demand / invoice generation", "Fee Demand / Invoice Generation",
        ]),
        ("Concessions & Refunds", [
            "Discounts / scholarships", "Concession & Scholarship Management",
            "Multi-Level Concession Approvals", "Refunds",
            "Fee Refund Processing", "NSP Scholarship Reconciliation",
            "Student Loan Assistance Portal",
            "Government Reimbursement Claims", "Grant-in-Aid Accounting",
        ]),
        ("Reconciliation", [
            "Reconciliation", "Payment Gateway Reconciliation",
            "Bank Reconciliation Statement (BRS)", "Connected Banking Payouts",
            "Student Bank Account Register",
        ]),
        ("Accounting", [
            "Expenses / accounting", "Chart of Accounts Setup",
            "Petty Cash Voucher Management",
            "Vendor Management & Accounts Payable",
            "Budgeting & Variance Analysis", "General Ledger & Trial Balance",
            "Fixed Asset Register & Depreciation", "Financial Year Closing",
            "Tally Prime XML Export",
        ]),
        ("Reports", [
            "Finance reports", "Daybook & Cashbook Reports",
            "Taxation & Audit Reports",
        ]),
    ],

    "Admissions & Front Office": [
        ("Home", ["Admissions KPIs", "Follow-ups"]),
        ("Enquiries", [
            "Enquiries / leads", "Inquiry / Lead Entry", "Lead Source Tracking",
            "Counselor Lead Assignment", "Counselor Activity & Follow-ups",
            "Multi-Touch Campaign Sequences",
            "UTM Tracking & Digital Campaign attribution",
            "24/7 Admission Chatbot", "AI Voice Agent Integration",
            "Admissions Open Day Scheduler", "Prospectus & Kit Sales Log",
        ]),
        ("Applications", [
            "Applications", "Online Application Form Builder",
            "Applicant documents", "Application Document Verification",
            "Entrance tests / interviews", "Entrance Exam Scheduling",
            "Interview & Interaction Scheduler",
            "Applicant Medical Fitness Declaration",
            "Foreign / NRI Student Visa Documentation",
        ]),
        ("Admissions", [
            "Offers / admission decisions", "Merit List Generation",
            "Seat Allocation Management", "Provisional Offer Letters",
            "Admission Waitlist Management", "Admission fee status",
            "Admission Fee Collection", "Enrollment handoff",
            "Admitted Student Handoff", "Sibling Priority Auto-Matching",
            "Alumni Child Quota Allocation",
            "RTE (Right to Education) Quota Tracking",
            "RTE Online Lottery Import",
            "Aadhaar & APAAR Capture at Admission",
            "Transfer Certificate Intake", "Medium of Instruction Selection",
            "Child Info ID Capture",
        ]),
        ("Visitor Desk", [
            "Visitor Gate Pass Generation", "Visitor Checkout Tracking",
            "Gate RFID Entry Management", "Emergency Gate Lockout",
            "Parent Appointment Booking", "Front Office Calls Register",
            "Postal & Courier Log",
        ]),
        ("Communication", ["Applicant communication"]),
        ("Reports", [
            "Admissions reports", "Admission Conversion Reports",
            "Lost Lead Reason Analysis",
        ]),
    ],

    "HR & Payroll": [
        ("Home", ["HR KPIs"]),
        ("Employees", [
            "Employee master", "Employee Master Directory",
            "Staff Onboarding & KYC Verification", "Employee documents",
            "Employee Document Expiry Alerts", "Staff ID Card Printing",
            "Staff Criminal Background Verification",
            "Medical Fitness Certificate Registry",
            "Teacher Qualification Register",
            "Staff Service Book Digitalization",
            "Staff Exit Interview Management",
            "Staff Experience & Relieving Cards",
            "Teacher Relieving No-Deduction Clearance",
            "Teacher Transfer & Deputation",
        ]),
        ("Attendance & Leave", [
            "Staff attendance", "Biometric Machine Attendance Sync",
            "Biometric Punch In/Out Grace Period", "Staff Shift & Rostering",
            "Leave", "Leave Policy Configuration",
            "Staff Leave Application Management",
            "Late Arrival & Loss of Pay (LOP)",
            "Half-Day Leave Deduction Calculation",
        ]),
        ("Payroll", [
            "Payroll", "Salary Structure Builder", "Payroll Calculation Engine",
            "Payslip Generation & Email Dispatch",
            "Direct Bank Payroll Transfer File", "Employee CTC Breakup Calculator",
            "Overtime (OT) Rate Setup", "Substitute Workload Allowance",
            "Staff Loan & Advance Management", "PF Encashment & Loan Deduction",
        ]),
        ("Statutory", [
            "PF & ESI Statutory Compliance", "Income Tax & Form 16 Generator",
            "Professional Tax (PT) Slab Configuration",
            "Form 12BB & Investment Declarations",
            "Staff Gratuity Liability Estimator",
            "Contractor / Security Staff Bill Verification",
        ]),
        ("People", [
            "Recruitment", "Staff Recruitment & Job Portal",
            "Annual Performance Appraisal (KPI)",
            "Staff Training & Workshop Logs", "Staff Grievance Cell",
            "Staff Recognition & Wall", "Staff Birthday & Anniversary Alerts",
        ]),
        ("Reports", ["HR reports"]),
    ],

    "Operations Staff": [
        ("Home", [
            "Role-specific home", "Library role", "Transport role",
            "Hostel role", "Inventory / Stores role", "Front Office role",
        ]),
        ("Transport", [
            "Vehicle Master Registry", "Driver & Attendant Profiles",
            "Route & Pickup Stop Mapping", "Student Route Assignment",
            "Route Distance Fee Slabs", "Transport Attendance Scans",
            "Real-time Vehicle Tracking (VTS)", "Geo-fenced Bus Stop Alerts",
            "Bus Speeding & Rash Driving Alerts",
            "Vehicle Fuel & Maintenance Log",
            "Fuel Sensor & Mileage Telematics",
            "Driver Sobriety & Safety Checklist",
            "Bus Breakdown Emergency Dispatch",
            "Seatbelt & CCTV Video Streaming",
            "AIS-140 Telematics & VAHAN Compliance",
        ]),
        ("Hostel", [
            "Hostel Building & Room Setup", "Room Allocation Engine",
            "Room Inventory Checklists", "Hostel Roll-Call Attendance",
            "Night Study Room Attendance", "Digital Outpass Approval",
            "Hostel Visitor Log", "Mess Menu & Meal Management",
            "Boarder Laundry Tracking", "Hostel Complaint Ticketing",
        ]),
        ("Library", [
            "Book Cataloging & Accession Register",
            "Barcode & Spine Label Printing", "Book Issue & Return Terminal",
            "Book Reservation Queue", "Overdue Fine Calculation",
            "OPAC Digital Book Search", "Digital E-Book & Journal Integration",
            "Library Inventory Audit", "NCERT Textbook Indent",
        ]),
        ("Infirmary", [
            "Student Health Master File", "Daily Nurse Visit Log",
            "Medication Admin Register", "Emergency Health Alerts",
            "Annual Health Checkup Records", "School Health Programme Camps",
        ]),
        ("Stores", [
            "Item Category & Store Setup", "Purchase Order Workflow",
            "Department Stock Issuance",
        ]),
    ],

    "Student": [
        ("Home", [
            "My day", "Action reminders", "Student Personalized Dashboard",
            "Digital Diary & Schedule", "Custom Theme Selection",
        ]),
        ("Timetable", ["Timetable"]),
        ("Attendance", ["Attendance"]),
        ("Homework", [
            "Homework & assignments", "Digital Assignment Upload",
            "Classmate Homework Help Forum",
            "Classroom Note-Sharing Repository",
        ]),
        ("Learning", [
            "Courses / subjects", "E-Learning Resource Hub",
            "AI Personal Learning Companion", "Peer Tutoring & Study Groups",
            "Personal Academic Goal Setting Widget",
            "Gamified Learning Streak Counter", "Gamified Learning Badge Showcase",
            "Virtual Classroom Hand-Raise Telemetry",
            "Global University Guidance Counselor",
            "Student Portfolio Management",
        ]),
        ("Exams & Results", [
            "Exams & grades", "Academic record", "Online Exam Attempt Engine",
            "Target Grade Calculator", "Digital Hall Ticket Download",
            "Board Hall Ticket Download", "Digital Hall Ticket Verification QR",
            "APAAR ID & Academic Bank of Credits",
        ]),
        ("Fees", ["Fees"]),
        ("School Life", [
            "Calendar", "Announcements & messages", "Library Book Hold Request",
            "Student Wall & Peer Recognition", "Digital Hall of Fame",
            "Student Club Event Ticketing & QR Check-In",
            "Lost & Found Item Board",
            "Lost & Found Photo Board with Claim Verification",
            "Wellness & Mood Check-In Widget",
            "Self-Referral to School Counselor",
            "Alumni Network Registration", "Alumni Job & Internship Board",
            "Digital Locker Combination & Access Log",
        ]),
        ("Requests", ["Requests", "Documents"]),
        ("Profile", ["Profile", "Digital Student ID Card NFC Tap Pass"]),
    ],

    "Parent / Guardian": [
        ("Home", [
            "Child switcher", "Child summary", "Needs attention",
            "Multi-Child Single Login Switch", "Real-Time Push Notifications",
        ]),
        ("Attendance", [
            "Attendance", "Child Attendance Calendar",
            "Child Absence Reporting Button",
        ]),
        ("Academics", [
            "Homework & academics", "Homework & Subject Material",
            "Results & report cards", "Digital Report Card Downloads",
            "AI Child Performance Summary Audio", "IEP Progress Goal Tracker",
        ]),
        ("Fees", [
            "Fees & payments", "One-Touch Online Fee Payment",
            "Digital Fee Receipt PDF Download",
            "Child Daily Cafeteria Purchase Timeline",
        ]),
        ("Transport", [
            "Transport snapshot", "Live Bus Tracking Map",
            "School Transport Driver Call Button",
            "Parent Bus Proximity Radius Customizer",
            "Real-time School Bus Live Video Feed Access",
            "Parent App Live Bus Tracking Refresh Rate Customizer",
        ]),
        ("Messages", [
            "Communication", "Direct Teacher Messaging",
            "Concerns & Grievance Ticketing",
            "Parent Community Discussion Forum",
            "AI Voice Search for School Notices",
            "Private Counselor Chat Channel",
        ]),
        ("Requests", [
            "Requests", "Apply Student Leave", "Consent & acknowledgement",
            "Digital Parent Consent Slips", "DigiLocker Document Pull",
            "Parent Delegation for Emergency Pickup",
        ]),
        ("School Life", [
            "Calendar & PTM", "Parent-Teacher Meeting Booking",
            "PTM Appointment Reminder Alert", "School Photo & Video Gallery",
            "Live Event Seating Pass",
        ]),
        ("Profile", [
            "Digital Student ID Card View", "Digital Parent ID Card for Campus Entry",
            "Parent App Biometric Lock (Face ID / Fingerprint)",
            "Multi-Language App Interface Toggle", "Telugu Language Interface",
            "Parent App Dark Mode & High Contrast Accessibility",
        ]),
    ],
}

# Roles left exactly as they are: the vendor console and the platform operator
# are not school workspaces and nobody navigates them all day.
UNCHANGED = {"Super Admin", "Seller Admin"}

# --- the six roles that held permissions but owned no workspace -------------
# (section, feature, description, scope, priority)
NEW_ROLES = {
    "Vice Principal / Academic Coordinator": ("Assigned institution/campus", [
        ("Home", "Academic KPIs", "Attendance, syllabus coverage and exam readiness across the school, with what needs attention today."),
        ("Home", "Needs attention", "Classes without attendance marked, marks not entered and report cards awaiting sign-off."),
        ("Academics", "Classes & sections", "The academic structure: classes, sections, subjects and which teacher takes what."),
        ("Academics", "Teacher allocation", "Who teaches which subject in which section, and the workload that adds up to."),
        ("Academics", "Timetable", "The master period grid, with substitutions for absent teachers."),
        ("Academics", "Syllabus progress", "Chapter-level coverage per subject and section against the plan."),
        ("Attendance", "Attendance monitoring", "Daily attendance across every section, with the sections that have not marked yet."),
        ("Attendance", "Attendance corrections", "Requests from teachers to amend a register after it was submitted."),
        ("Examinations", "Exams & results", "Exam schedule, marks entry status and result publication readiness."),
        ("Examinations", "Report cards", "Holistic progress cards and the scholastic report, ready to verify and issue."),
        ("Students", "Student directory", "Every student, their section, guardians and academic history."),
        ("Teachers", "Faculty directory & workload", "Teaching staff, their allocations and how loaded each one is."),
        ("Communication", "Circulars & announcements", "Notices to sections, parents or the whole school, with read acknowledgement."),
        ("Approvals", "Approvals", "Leave, attendance corrections and lesson plans waiting on an academic decision."),
    ]),

    "Class Teacher": ("Assigned classes/subjects", [
        ("Home", "My day", "Today's periods, what is pending and anything about this class that needs attention."),
        ("Home", "Today's classes", "The periods being taken today, in order, with the section and subject."),
        ("My Class", "My students", "Every child in the class with attendance, marks and guardian contact in one place."),
        ("My Class", "Student details", "One child's full record: profile, guardians, attendance, marks and remarks."),
        ("My Class", "Remarks", "Class teacher remarks that appear on the report card."),
        ("My Class", "Discipline notes", "Conduct incidents recorded against a child, visible to the school's leadership."),
        ("Attendance", "Take attendance", "Mark the daily register for the class, with a reason against every absence."),
        ("Attendance", "Attendance correction", "Amend a register already submitted, with the change recorded."),
        ("Teaching", "Homework & classwork", "Set work for the class and review what has been submitted."),
        ("Teaching", "Study materials", "Notes, worksheets and reference material shared with the class."),
        ("Teaching", "Syllabus progress", "Chapters covered against the plan for each subject taken."),
        ("Marks & Report Cards", "Marks entry", "Enter and amend marks for the subjects taken in this class."),
        ("Marks & Report Cards", "Holistic progress card", "NEP holistic assessment across scholastic and co-scholastic domains."),
        ("Marks & Report Cards", "Report cards", "Generate and issue the report card for every child in the class."),
        ("Timetable", "My timetable", "The week's periods for this class and for the subjects taken elsewhere."),
        ("Parent Communication", "Announcements", "Notices to this class's parents, with read acknowledgement."),
        ("My Profile", "Profile", "Own profile, password and leave."),
    ]),

    "Transport Manager": ("Only assigned operational module/campus", [
        ("Home", "Transport overview", "Vehicles on the road, routes running late and today's exceptions."),
        ("Fleet", "Vehicles", "The vehicle register: registration, capacity, permit, insurance and fitness expiry."),
        ("Fleet", "Drivers & attendants", "Who drives what, with licence expiry and background verification."),
        ("Routes", "Routes & stops", "Route definitions, the stops on each and the timing between them."),
        ("Routes", "Student allocation", "Which child boards at which stop on which route, and the fee slab that implies."),
        ("Today", "Route attendance", "Boarding and alighting scans for each route, morning and afternoon."),
        ("Today", "Delays & exceptions", "Routes running late, breakdowns and any child not scanned."),
        ("Tracking", "Live vehicle tracking", "Where every bus is now, against the route it should be running."),
        ("Reports", "Transport reports", "Utilisation, fuel, maintenance and route punctuality."),
        ("My Profile", "Profile", "Own profile and password."),
    ]),

    "Librarian": ("Only assigned operational module/campus", [
        ("Home", "Library overview", "Issued today, due today, overdue and fines outstanding."),
        ("Catalogue", "Books & copies", "Titles, editions and the individual copies held against each."),
        ("Catalogue", "Accession register", "The statutory accession register, with barcode and spine label printing."),
        ("Circulation", "Issue & return", "The counter: scan a card, scan a book, issue or take it back."),
        ("Circulation", "Reservations", "Holds placed by students and staff, and who is next in the queue."),
        ("Circulation", "Fines", "Overdue fines accrued, waived and collected."),
        ("Members", "Students & staff", "Borrowing history and current loans for any member."),
        ("Reports", "Library reports", "Circulation, stock verification and the titles nobody borrows."),
        ("My Profile", "Profile", "Own profile and password."),
    ]),

    "Hostel Warden": ("Only assigned operational module/campus", [
        ("Home", "Hostel overview", "Occupancy, who is out on pass and tonight's roll call status."),
        ("Rooms", "Buildings & rooms", "Blocks, rooms and beds, with the condition of each."),
        ("Rooms", "Room allocation", "Which boarder is in which bed, and the moves waiting to happen."),
        ("Boarders", "Students", "Every boarder with guardian contact, medical notes and their room."),
        ("Daily", "Roll call", "Morning and night attendance for the hostel, separate from the school register."),
        ("Daily", "Outpass & leave", "Gate passes requested, approved and outstanding, with expected return."),
        ("Complaints", "Complaints", "Maintenance and welfare complaints raised by boarders, and their status."),
        ("Reports", "Hostel reports", "Occupancy, mess consumption and outpass history."),
        ("My Profile", "Profile", "Own profile and password."),
    ]),

    "IT Administrator": ("Assigned institution/campus", [
        ("Home", "System health", "Background jobs, queue depth, failed integrations and recent errors."),
        ("Users", "User directory", "Create, search, suspend and reset accounts across the school."),
        ("Roles & Permissions", "Roles & permissions", "What each role can do and how much of the school it can see."),
        ("School Settings", "School settings", "Institution profile, campuses, academic year and numbering."),
        ("School Settings", "Module configuration", "Switch modules on and off so people only see what the school uses."),
        ("Integrations", "Integrations", "Payment gateway, SMS, WhatsApp, biometric devices and single sign-on."),
        ("Sessions & Devices", "Login & session audit", "Who is signed in from where, and the ability to sign them out."),
        ("Audit Logs", "Audit log", "Every configuration and data change, with who made it and when."),
        ("Data", "Import & export", "Bulk import of students, staff and opening balances, with validation reports."),
    ]),
}


def main() -> int:
    rows = list(csv.DictReader(CSV_PATH.open()))
    fieldnames = list(rows[0].keys())

    by_role = OrderedDict()
    for r in rows:
        by_role.setdefault(r["Role"].strip(), []).append(r)

    problems = []
    out_rows = []

    for role_name, role_rows in by_role.items():
        if role_name in UNCHANGED:
            out_rows.extend(role_rows)
            continue

        plan = REGROUP.get(role_name)
        if plan is None:
            problems.append(f"no regrouping defined for role {role_name!r}")
            out_rows.extend(role_rows)
            continue

        # Feature name -> row. Names repeat across sections in no role, so a
        # collision here means the CSV itself has a duplicate.
        index = {}
        for r in role_rows:
            name = r["Feature"].strip()
            if name in index:
                problems.append(f"{role_name}: duplicate feature {name!r}")
            index[name] = r

        placed = set()
        for section, features in plan:
            for name in features:
                row = index.get(name)
                if row is None:
                    problems.append(f"{role_name}: {name!r} is not in the CSV")
                    continue
                if name in placed:
                    problems.append(f"{role_name}: {name!r} placed twice")
                    continue
                placed.add(name)
                row = dict(row)
                row["Section"] = section
                out_rows.append(row)

        for name in index:
            if name not in placed:
                problems.append(f"{role_name}: {name!r} was left out of the regrouping")

    for role_name, (scope, entries) in NEW_ROLES.items():
        for section, feature, desc in entries:
            out_rows.append({
                "Role": role_name,
                "Section": section,
                "Feature": feature,
                "What User Sees & Does": desc,
                "Data Scope": scope,
                "Priority": "Must-Have",
            })

    if problems:
        for p in problems:
            print("ERROR:", p, file=sys.stderr)
        return 1

    with CSV_PATH.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(out_rows)

    print(f"regrouped: {len(out_rows)} rows across {len(by_role) + len(NEW_ROLES)} roles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
