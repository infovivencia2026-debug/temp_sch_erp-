#!/usr/bin/env python3
"""Give every substantial workspace real categories inside it.

After the merge, 42 of 54 workspaces held a single group, so the sidebar
rendered them as one flat run of items — a workspace that opens onto twenty-four
undifferentiated links is the wall the workspace level was supposed to remove,
just one step further in.

This splits the big ones by what a person is actually doing: HR's Employees
becomes Records / Onboarding & Exit / Compliance, the Super Admin's Platform
Setup becomes Multi-campus / Integrations / Statutory & Boards / Automation.
Small workspaces are left alone — three items do not need a heading over them.

Categories are assigned by exact feature name, so a rename upstream fails here
loudly rather than dropping a feature into a catch-all.

    python3 scripts/split_categories.py && make catalog
"""

import csv
import pathlib
import re
import sys
from collections import OrderedDict

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "docs" / "edu_features.csv"
REGISTRY = ROOT / "web" / "src" / "features" / "registry.ts"

ROLE_KEYS = {
    "Super Admin": "super_admin",
    "Institution Admin / Principal": "institution_admin",
    "Faculty / Teacher": "faculty",
    "Student": "student",
    "Parent / Guardian": "parent",
    "Accounts & Finance": "finance",
    "Admissions & Front Office": "admissions",
    "HR & Payroll": "hr",
    "Seller Admin": "seller_admin",
}

# (role, workspace) -> ordered {category: [feature names]}
SPLIT = {
    ("Super Admin", "Platform Setup"): OrderedDict([
        ("Campuses & Academic Year", [
            "Multi-Campus Configuration", "Academic Year Defaults",
            "Academic Calendar Model",
            "Franchise Management", "White-Label Branding",
        ]),
        ("Messaging", [
            "SMS Gateway Integration", "WhatsApp API Integration",
            "Email Server (SMTP) Integration", "Automated Trigger Rules",
        ]),
        ("Payments & Devices", [
            "Payment Gateway Connectors", "Biometric Device Integration",
            "GPS Hardware Integration", "Virtual Classroom Integration",
            "Tally ERP / Prime Connector", "Meritto / LeadSquared Sync",
        ]),
        ("Statutory & Boards", [
            "UDISE+ Data Sync", "APAAR ID Provisioning",
            "District & Mandal Master", "Child Info Portal Sync",
            "DigiLocker Issuer Integration", "Board Affiliation & Disclosure",
            "State Board Configuration", "School Management Type",
            "SQAA Framework Management",
        ]),
        ("Operations", [
            "Login & Session Audit Logs", "Data Backup & Restore",
            "System Health & Integration Alerts",
        ]),
    ]),
    ("HR & Payroll", "Employees"): OrderedDict([
        ("Records", [
            "Employee master", "Employee documents", "Staff ID Card Printing",
            "Employee Document Expiry Alerts", "Teacher Qualification Register",
            "Staff Service Book Digitalization",
        ]),
        ("Onboarding & Exit", [
            "Staff Onboarding & KYC Verification", "Staff Exit Interview Management",
            "Staff Experience & Relieving Cards",
            "Teacher Relieving No-Deduction Clearance",
            "Teacher Transfer & Deputation",
        ]),
        ("Verification", [
            "Staff Criminal Background Verification",
            "Medical Fitness Certificate Registry",
        ]),
    ]),
    ("HR & Payroll", "Attendance & Leave"): OrderedDict([
        ("Attendance", [
            "Staff attendance", "Biometric Machine Attendance Sync",
            "Biometric Punch In/Out Grace Period", "Staff Shift & Rostering",
        ]),
        ("Leave", [
            "Leave", "Leave Policy Configuration",
            "Late Arrival & Loss of Pay (LOP)",
            "Half-Day Leave Deduction Calculation",
        ]),
    ]),
    ("Student", "School"): OrderedDict([
        ("Notices & Calendar", [
            "Calendar", "Announcements & messages", "Library Book Hold Request",
        ]),
        ("Wellbeing", [
            "Wellness & Mood Check-In Widget", "Self-Referral to School Counselor",
        ]),
        ("Campus Life", [
            "Student Wall & Peer Recognition", "Digital Hall of Fame",
            "Student Club Event Ticketing & QR Check-In",
            "Lost & Found Item Board",
            "Lost & Found Photo Board with Claim Verification",
            "Digital Locker Combination & Access Log",
        ]),
        ("Alumni", [
            "Alumni Network Registration", "Alumni Job & Internship Board",
        ]),
    ]),
    ("Faculty / Teacher", "Assessments"): OrderedDict([
        ("Marks & Report Cards", [
            "Marks entry", "Report cards", "Holistic progress card",
            "NEP Holistic Progress Card (HPC)",
        ]),
        ("Assessment Schemes", [
            "CCE Formative Assessment Entry", "CCE Summative Assessment Entry",
        ]),
        ("Question Papers & Online Tests", [
            "Question Bank Management", "AI Examcell Paper Generator",
            "Ved AI Assessment Assistant", "Objective Online Test Creation",
            "No-OMR Exam Grading",
        ]),
    ]),
    ("Institution Admin / Principal", "Administration"): OrderedDict([
        ("Statutory Returns", [
            "UDISE+ Return Preparation", "APAAR ID Register",
            "Child Info Reconciliation", "Statutory Registers",
            "Working Days & Instructional Hours",
        ]),
        ("Mid-Day Meal", ["Mid-Day Meal Register", "MDM Utilisation Report"]),
        ("Boards & Accreditation", [
            "Board Exam LOC Submission", "PARAKH & NEP Credit Framework",
            "SQAA Compliance Tracking",
        ]),
    ]),
    ("Accounts & Finance", "Accounting"): OrderedDict([
        ("Ledgers", [
            "Expenses / accounting", "Chart of Accounts Setup",
            "General Ledger & Trial Balance", "Financial Year Closing",
        ]),
        ("Payables", [
            "Vendor Management & Accounts Payable", "Petty Cash Voucher Management",
        ]),
        ("Assets & Budget", [
            "Fixed Asset Register & Depreciation", "Budgeting & Variance Analysis",
        ]),
        ("Export", ["Tally Prime XML Export"]),
    ]),
    ("Admissions & Front Office", "Front Desk"): OrderedDict([
        ("Visitors", [
            "Visitor Gate Pass Generation", "Visitor Checkout Tracking",
            "Parent Appointment Booking",
        ]),
        ("Gate Security", [
            "Gate RFID Entry Management", "Emergency Gate Lockout",
        ]),
        ("Office Log", ["Front Office Calls Register", "Postal & Courier Log"]),
    ]),
    ("Parent / Guardian", "Requests"): OrderedDict([
        ("Leave & Absence", ["Requests", "Apply Student Leave"]),
        ("Consent", [
            "Consent & acknowledgement", "Digital Parent Consent Slips",
            "Parent Delegation for Emergency Pickup",
        ]),
        ("Documents", ["DigiLocker Document Pull"]),
    ]),
    ("Parent / Guardian", "Transport"): OrderedDict([
        ("My Child's Bus", [
            "Transport snapshot", "Live Bus Tracking Map",
            "School Transport Driver Call Button",
        ]),
        ("Alerts & Preferences", [
            "Parent Bus Proximity Radius Customizer",
            "Real-time School Bus Live Video Feed Access",
            "Parent App Live Bus Tracking Refresh Rate Customizer",
        ]),
    ]),
    ("Institution Admin / Principal", "Staff"): OrderedDict([
        ("Directory & Workload", [
            "Staff Allocation & Workload", "Faculty directory",
            "Faculty allocation & workload", "Faculty directory & workload",
        ]),
        ("Department", ["Department academics", "Department timetable"]),
        ("Evaluation", ["360 Evaluation Oversight"]),
    ]),
    ("Institution Admin / Principal", "Reports"): OrderedDict([
        ("Standard", [
            "Reports", "Comprehensive Attendance Report",
            "Exam & Grade Analytics", "Fee Collection Summaries",
        ]),
        ("Analysis", [
            "Performance analytics", "Department reports", "Custom Report Builder",
        ]),
    ]),
    ("HR & Payroll", "People"): OrderedDict([
        ("Hiring & Growth", [
            "Recruitment", "Staff Recruitment & Job Portal",
            "Staff Training & Workshop Logs",
            "Annual Performance Appraisal (KPI)",
        ]),
        ("Welfare", [
            "Staff Grievance Cell", "Staff Recognition & Wall",
            "Staff Birthday & Anniversary Alerts",
        ]),
    ]),
}


def slug(s: str) -> str:
    s = re.sub(r"[’'`]", "", s.lower())
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def main() -> int:
    rows = list(csv.DictReader(CSV_PATH.open()))
    fields = list(rows[0].keys())

    index = {}
    for r in rows:
        index.setdefault((r["Role"].strip(), r["Workspace"].strip()), []).append(r)

    problems, moved, changed = [], {}, 0
    for (role, ws), plan in SPLIT.items():
        present = index.get((role, ws))
        if not present:
            problems.append(f"{role} has no {ws!r} workspace")
            continue
        by_name = {r["Feature"].strip(): r for r in present}
        placed = set()
        for cat, names in plan.items():
            for n in names:
                row = by_name.get(n)
                if row is None:
                    continue  # tolerated: a feature removed by an earlier pass
                old = f"{ROLE_KEYS[role]}.{slug(row['Section'])}.{slug(n)}"
                row["Section"] = cat
                moved[old] = f"{ROLE_KEYS[role]}.{slug(cat)}.{slug(n)}"
                placed.add(n)
                changed += 1
        left = [r["Feature"].strip() for r in present if r["Feature"].strip() not in placed]
        if left:
            problems.append(f"{role} / {ws}: unassigned -> {left}")

    if problems:
        for p in problems:
            print("ERROR:", p, file=sys.stderr)
        return 1

    grouped = OrderedDict()
    for r in rows:
        grouped.setdefault(r["Role"].strip(), OrderedDict()) \
               .setdefault(r["Workspace"].strip(), OrderedDict()) \
               .setdefault(r["Section"].strip(), []).append(r)
    final = []
    for wss in grouped.values():
        for groups in wss.values():
            for items in groups.values():
                final.extend(items)

    with CSV_PATH.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(final)

    src = REGISTRY.read_text()
    out, rewired = [], 0
    for line in src.splitlines(keepends=True):
        m = re.search(r"'([a-z0-9_.]+)': lazy", line)
        if m and m.group(1) in moved:
            out.append(line.replace(m.group(1), moved[m.group(1)]))
            rewired += 1
            continue
        out.append(line)
    REGISTRY.write_text("".join(out))

    print(f"split {changed} features into categories across {len(SPLIT)} workspaces")
    print(f"registry: {rewired} rewired")
    return 0


if __name__ == "__main__":
    sys.exit(main())
