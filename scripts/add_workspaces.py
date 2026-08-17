#!/usr/bin/env python3
"""Add the workspace and tier columns to docs/edu_features.csv.

Regrouping gave every role 6-11 flat sections, which is better than two but
still trades depth for tidiness. The shape a feature-rich ERP actually wants is

    role -> 6-9 workspaces -> groups -> features

so this adds the workspace level *above* the existing sections rather than
collapsing anything into it. Sections become the groups inside a workspace, and
because the feature key stays role.section.feature, nothing downstream — the
component registry, the seeded grants, existing deep links — has to move.

The tier column decides how hard a feature has to work to earn sidebar space:

    core       everyday work. Listed normally.
    advanced   real capability, occasional use. Behind "Advanced" in its group.
    optional   niche, gimmick, or hardware/board-specific. Catalogued, and not
               in anyone's navigation unless they go looking.

Nothing is deleted. A school that wants the gamified badge board still has it;
it simply does not cost a teacher a line of sidebar every day.

    python3 scripts/add_workspaces.py && make catalog
"""

import csv
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "docs" / "edu_features.csv"


def slug(s: str) -> str:
    s = re.sub(r"[’'`]", "", s.lower())
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


# role_key -> {section_slug: workspace name}. Sections not named here keep
# their own name as the workspace, which is what the vendor and platform
# consoles want — nobody navigates those all day.
WORKSPACES = {
    "institution_admin": {
        "home": "Home", "approvals": "Home",
        "students": "Students", "admissions": "Students",
        "academics": "Academics", "examinations": "Academics",
        "fees": "Finance",
        "staff": "Staff",
        "communication": "Communication",
        "reports": "Reports",
        "compliance": "Administration",
    },
    "vice_principal": {
        "home": "Home", "approvals": "Home",
        "academics": "Academics", "attendance": "Academics",
        "examinations": "Academics",
        "students": "Students",
        "teachers": "Teachers",
        "communication": "Communication",
    },
    "hod": {
        "home": "Home", "approvals": "Home",
        "my_department": "My Department",
        "academics": "Academics",
        "students": "Students",
        "communication": "Communication",
        "reports": "Reports",
    },
    "class_teacher": {
        "home": "Home",
        "my_class": "My Class", "attendance": "My Class",
        "teaching": "Teaching", "timetable": "Teaching",
        "marks_report_cards": "Assessments",
        "parent_communication": "Communication",
        "my_profile": "My Work",
    },
    "faculty": {
        "home": "Home",
        "my_classes": "My Classes", "attendance": "My Classes",
        "teaching": "Teaching", "timetable": "Teaching",
        "marks_assessment": "Assessments",
        "communication": "Communication",
        "my_profile": "My Work",
    },
    "finance": {
        "home": "Home",
        "fee_structure": "Fees", "collections": "Fees",
        "student_dues": "Fees", "concessions_refunds": "Fees",
        "reconciliation": "Fees",
        "accounting": "Accounting",
        "reports": "Reports",
    },
    "admissions": {
        "home": "Home",
        "enquiries": "Admissions", "applications": "Admissions",
        "admissions": "Admissions",
        "visitor_desk": "Front Desk",
        "communication": "Communication",
        "reports": "Reports",
    },
    "hr": {
        "home": "Home",
        "employees": "Employees",
        "attendance_leave": "Attendance & Leave",
        "payroll": "Payroll", "statutory": "Payroll",
        "people": "People",
        "reports": "Reports",
    },
    "it_admin": {
        "home": "Home",
        "users": "Access", "roles_permissions": "Access",
        "sessions_devices": "Access",
        "school_settings": "Configuration", "integrations": "Configuration",
        "data": "Data", "audit_logs": "Data",
    },
    "operations": {
        "home": "Home", "transport": "Transport", "hostel": "Hostel",
        "library": "Library", "infirmary": "Infirmary", "stores": "Stores",
    },
    "transport_manager": {
        "home": "Home", "today": "Home",
        "fleet": "Transport", "routes": "Transport", "tracking": "Transport",
        "reports": "Reports", "my_profile": "My Work",
    },
    "librarian": {
        "home": "Home",
        "catalogue": "Library", "circulation": "Library",
        "members": "Members", "reports": "Reports", "my_profile": "My Work",
    },
    "hostel_warden": {
        "home": "Home",
        "rooms": "Hostel", "daily": "Hostel", "complaints": "Hostel",
        "boarders": "Boarders", "reports": "Reports", "my_profile": "My Work",
    },
    "student": {
        "home": "Home",
        "timetable": "Academics", "attendance": "Academics",
        "homework": "Academics", "learning": "Academics",
        "exams_results": "Academics",
        "fees": "Fees",
        "school_life": "School",
        "requests": "Requests",
        "profile": "Profile",
    },
    "parent": {
        "home": "Home",
        "attendance": "My Child", "academics": "My Child",
        "fees": "Fees",
        "transport": "Transport",
        "messages": "School", "school_life": "School",
        "requests": "Requests",
        "profile": "Profile",
    },
}

ROLE_KEYS = {
    "Super Admin": "super_admin",
    "Institution Admin / Principal": "institution_admin",
    "Vice Principal / Academic Coordinator": "vice_principal",
    "HOD / Department Head": "hod",
    "Class Teacher": "class_teacher",
    "Faculty / Teacher": "faculty",
    "Student": "student",
    "Parent / Guardian": "parent",
    "Accounts & Finance": "finance",
    "Admissions & Front Office": "admissions",
    "HR & Payroll": "hr",
    "IT Administrator": "it_admin",
    "Operations Staff": "operations",
    "Transport Manager": "transport_manager",
    "Librarian": "librarian",
    "Hostel Warden": "hostel_warden",
    "Seller Admin": "seller_admin",
}

# --- tiering ----------------------------------------------------------------
# Named outright rather than pattern-matched: deciding that a school does not
# need the "Digital Hall of Fame" in its sidebar is a product judgement, and a
# product judgement should be readable as a list rather than inferred from a
# regex three months later.
OPTIONAL = {
    # Consumer-app flourishes on the student portal.
    "Gamified Learning Streak Counter", "Gamified Learning Badge Showcase",
    "Digital Hall of Fame", "Student Wall & Peer Recognition",
    "Custom Theme Selection", "Lost & Found Item Board",
    "Lost & Found Photo Board with Claim Verification",
    "Virtual Classroom Hand-Raise Telemetry",
    "Digital Locker Combination & Access Log",
    "Student Club Event Ticketing & QR Check-In",
    "Classmate Homework Help Forum", "Peer Tutoring & Study Groups",
    "Digital Student ID Card NFC Tap Pass",
    "Alumni Job & Internship Board", "Alumni Network Registration",
    "Global University Guidance Counselor",
    # Parent-app knobs nobody opens twice.
    "Parent App Dark Mode & High Contrast Accessibility",
    "Parent App Live Bus Tracking Refresh Rate Customizer",
    "Parent Bus Proximity Radius Customizer",
    "Parent App Biometric Lock (Face ID / Fingerprint)",
    "Parent Community Discussion Forum",
    "Real-time School Bus Live Video Feed Access",
    "Live Event Seating Pass", "Digital Parent ID Card for Campus Entry",
    "Digital Student ID Card View",
    "Child Daily Cafeteria Purchase Timeline",
    "AI Voice Search for School Notices",
    "AI Child Performance Summary Audio",
    # Staff-side novelties.
    "Staff Birthday & Anniversary Alerts", "Staff Recognition & Wall",
    "School Achievements Showcase", "Student Council Management",
    # Hardware and telematics a school buys separately, if ever.
    "Seatbelt & CCTV Video Streaming", "Fuel Sensor & Mileage Telematics",
    "Driver Sobriety & Safety Checklist", "Emergency Gate Lockout",
    "Gate RFID Entry Management",
    "24/7 Admission Chatbot", "AI Voice Agent Integration",
    "Boarder Laundry Tracking", "Night Study Room Attendance",
}

# Real capability, occasionally reached for. Kept out of the default rail so a
# clerk's Fees group is eight lines rather than thirty, and one click away.
ADVANCED_HINTS = (
    "CBSE", "ICSE", "State Board", "Cambridge", "IB (", "CCE ", "Telugu",
    "PARAKH", "Montessori", "NEP ", "NCERT", "UDISE", "APAAR", "RTE", "SQAA",
    "MDM", "Mid-Day Meal", "Statutory", "PF ", "ESI", "Form 16", "Form 12BB",
    "Professional Tax", "Gratuity", "GST", "Tally", "AIS-140", "VAHAN",
    "DigiLocker", "Versioning", "Reconciliation", "Trial Balance",
    "Depreciation", "Variance", "Chart of Accounts", "Petty Cash",
    "Financial Year Closing", "Grant-in-Aid", "Reimbursement", "NSP ",
    "Loan", "Audit Report", "Taxation", "Statement (BRS)",
    "Telematics", "Biometric", "Geo-fenced", "Speeding",
    "Question Bank", "AI Examcell", "Ved AI", "No-OMR", "Objective Online",
    "Portfolio", "Anecdotal", "CWSN", "IEP ", "At-Risk",
    "Background Verification", "Service Book", "Deputation",
    "Qualification Register", "Exit Interview", "Grievance Cell",
    "Campaign", "UTM", "Chatbot", "Waitlist", "Visa Documentation",
    "Medical Fitness", "Lottery Import", "Merit List", "Seat Allocation",
)


def tier_for(feature: str) -> str:
    if feature in OPTIONAL:
        return "optional"
    if any(h.lower() in feature.lower() for h in ADVANCED_HINTS):
        return "advanced"
    return "core"


def main() -> int:
    rows = list(csv.DictReader(CSV_PATH.open()))
    fields = list(rows[0].keys())
    for col in ("Workspace", "Tier"):
        if col not in fields:
            fields.insert(fields.index("Section"), col) if col == "Workspace" else fields.append(col)

    unknown = set()
    for r in rows:
        role_key = ROLE_KEYS.get(r["Role"].strip())
        if role_key is None:
            unknown.add(r["Role"].strip())
            continue
        section = r["Section"].strip()
        mapping = WORKSPACES.get(role_key, {})
        r["Workspace"] = mapping.get(slug(section), section)
        r["Tier"] = tier_for(r["Feature"].strip())

    if unknown:
        for u in sorted(unknown):
            print("ERROR: unknown role", repr(u), file=sys.stderr)
        return 1

    with CSV_PATH.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"annotated {len(rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
