#!/usr/bin/env python3
"""Remove redundant catalog entries — two names for one job.

The catalogue was assembled from two lists that overlap: an original set with
plain names ("Collect payment", "Employee master") and a later import with
title-case ones ("Counter Fee Collection", "Employee Master Directory"). Both
survived the merge, so a fee clerk's workspace offered "Collect payment" and
"Counter Fee Collection" as separate items that opened the same screen, and a
teacher's assessment group listed one gradebook per examination board when the
board is a school-level setting and the gradebook already adapts to it.

Every removal below names its survivor. That is the whole safety property: a
capability is never dropped, it is folded into the entry that already did the
same thing. Where the removed key was the one wired to a component, the wiring
moves to the survivor rather than being deleted.

This is not the tier list. Tiering decides how prominent a real capability is;
this decides that two entries were only ever one.

    python3 scripts/dedupe_catalog.py && make catalog
"""

import csv
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "docs" / "edu_features.csv"
REGISTRY = ROOT / "web" / "src" / "features" / "registry.ts"

# (Role, feature to remove) -> feature that absorbs it.
REDUNDANT = {
    # --- Super Admin: the same console screen listed twice ------------------
    ("Super Admin", "Campus Cards Overview"): "Campus cards",
    ("Super Admin", "User Directory & Provisioning"): "Users",
    ("Super Admin", "Role & Permission Matrix"): "Roles & permissions",
    ("Super Admin", "Login & Session Audit Logs"): "Login & session audit",
    ("Super Admin", "Multi-Campus Configuration"): "Institutions & campuses",
    # Listed under both Institution Setup and Platform Setup, same screen.
    ("Super Admin", "Academic Year Defaults"): "Academic year defaults",

    # --- Principal ---------------------------------------------------------
    ("Institution Admin / Principal", "Needs Attention Widget"): "Needs attention",
    ("Institution Admin / Principal", "Campus KPI Overview"): "Executive KPIs",
    ("Institution Admin / Principal", "Academic Calendar Management"): "Academic calendar",
    ("Institution Admin / Principal", "Circular & Announcement Dispatch"): "Communication",
    ("Institution Admin / Principal", "Digital Certificate Generation"): "Certificates & documents",
    ("Institution Admin / Principal", "Staff overview"): "Staff Allocation & Workload",

    # --- Teacher -----------------------------------------------------------
    ("Faculty / Teacher", "Homework & Classwork Publisher"): "Homework / classwork",
    ("Faculty / Teacher", "Daily Attendance Correction"): "Attendance correction",
    ("Faculty / Teacher", "Period-wise Student Attendance"): "Take attendance",
    ("Faculty / Teacher", "Daily Timetable View"): "My timetable",
    ("Faculty / Teacher", "Lesson Plan Creation"): "Lesson plans / content",
    ("Faculty / Teacher", "Assignment Evaluation & Grading"): "Assignments & submissions",
    ("Faculty / Teacher", "PARAKH Holistic Assessment Entry"): "NEP Holistic Progress Card (HPC)",
    ("Faculty / Teacher", "Gradebook"): "Marks entry",
    # One gradebook, not five. Which board a school follows is configured once
    # in State Board Configuration; the marks screen reads that setting. Five
    # near-identical entries made the school's board look like a choice the
    # teacher makes every time they enter a mark.
    ("Faculty / Teacher", "CBSE Gradebook Marks Entry"): "Marks entry",
    ("Faculty / Teacher", "ICSE Gradebook Entry"): "Marks entry",
    ("Faculty / Teacher", "State Board Gradebook Entry"): "Marks entry",
    ("Faculty / Teacher", "Cambridge Gradebook Entry"): "Marks entry",
    ("Faculty / Teacher", "IB (PYP/MYP/DP) Gradebook"): "Marks entry",
    ("Faculty / Teacher", "Telugu Medium Marks Entry"): "Marks entry",

    # --- Finance -----------------------------------------------------------
    ("Accounts & Finance", "Fee Demand / Invoice Generation"): "Demand / invoice generation",
    ("Accounts & Finance", "Student Ledger 360"): "Student ledger",
    ("Accounts & Finance", "Counter Fee Collection"): "Collect payment",
    ("Accounts & Finance", "Partial & Advance Payment Rules"): "Partial & advance payments",
    ("Accounts & Finance", "Defaulter Tracking & Aging"): "Defaulters & reminders",
    ("Accounts & Finance", "Fee Refund Processing"): "Refunds",
    ("Accounts & Finance", "Concession & Scholarship Management"): "Discounts / scholarships",
    ("Accounts & Finance", "Online Payment Gateway Auto-Sync"): "Online payments",
    # "Fee structures & schedules" is the generic of the two specifics that
    # follow it, and the specifics are what a clerk actually opens.
    ("Accounts & Finance", "Fee structures & schedules"): "Class-Wise Fee Structure Configuration",

    # --- HR ----------------------------------------------------------------
    ("HR & Payroll", "Employee Master Directory"): "Employee master",
    ("HR & Payroll", "Staff Leave Application Management"): "Leave",
    ("HR & Payroll", "Payroll Calculation Engine"): "Payroll",
    ("HR & Payroll", "Staff Recruitment & Job Portal"): "Recruitment",

    # --- Admissions --------------------------------------------------------
    ("Admissions & Front Office", "Inquiry / Lead Entry"): "Enquiries / leads",
    ("Admissions & Front Office", "Admission fee status"): "Admission Fee Collection",
    ("Admissions & Front Office", "Admitted Student Handoff"): "Enrollment handoff",
    ("Admissions & Front Office", "Application Document Verification"): "Applicant documents",
    ("Admissions & Front Office", "Entrance tests / interviews"): "Entrance Exam Scheduling",
    ("Admissions & Front Office", "Admissions reports"): "Admission Conversion Reports",

    # --- Operations: one home, not one per specialism ----------------------
    # Which specialism a person performs is decided by the roles they hold, not
    # by picking your own job from a menu every morning.
    ("Operations Staff", "Library role"): "Role-specific home",
    ("Operations Staff", "Transport role"): "Role-specific home",
    ("Operations Staff", "Hostel role"): "Role-specific home",
    ("Operations Staff", "Inventory / Stores role"): "Role-specific home",
    ("Operations Staff", "Front Office role"): "Role-specific home",

    # --- Student -----------------------------------------------------------
    ("Student", "Student Personalized Dashboard"): "My day",
    ("Student", "Digital Assignment Upload"): "Homework & assignments",
    ("Student", "Digital Hall Ticket Download"): "Board Hall Ticket Download",

    # --- Parent ------------------------------------------------------------
    ("Parent / Guardian", "Multi-Child Single Login Switch"): "Child switcher",
    ("Parent / Guardian", "Child Attendance Calendar"): "Attendance",
    ("Parent / Guardian", "Homework & Subject Material"): "Homework & academics",
    ("Parent / Guardian", "Digital Report Card Downloads"): "Results & report cards",
    ("Parent / Guardian", "One-Touch Online Fee Payment"): "Fees & payments",
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


def slug(s: str) -> str:
    s = re.sub(r"[’'`]", "", s.lower())
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def main() -> int:
    rows = list(csv.DictReader(CSV_PATH.open()))
    fields = list(rows[0].keys())

    # feature name -> its row, per role, so a survivor can be located and its
    # key computed even when it sits in a different section.
    index = {}
    for r in rows:
        index[(r["Role"].strip(), r["Feature"].strip())] = r

    problems = []
    rewrites = {}  # removed key -> surviving key
    for (role, gone), survivor in REDUNDANT.items():
        src = index.get((role, gone))
        dst = index.get((role, survivor))
        if src is None:
            problems.append(f"{role}: {gone!r} is not in the CSV")
            continue
        if dst is None:
            problems.append(f"{role}: survivor {survivor!r} is not in the CSV")
            continue
        rk = ROLE_KEYS[role]
        rewrites[f"{rk}.{slug(src['Section'])}.{slug(gone)}"] = \
            f"{rk}.{slug(dst['Section'])}.{slug(survivor)}"

    if problems:
        for p in problems:
            print("ERROR:", p, file=sys.stderr)
        return 1

    kept = [r for r in rows
            if (r["Role"].strip(), r["Feature"].strip()) not in REDUNDANT]

    with CSV_PATH.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(kept)

    # --- move any wiring off a removed key onto its survivor ----------------
    src = REGISTRY.read_text()
    existing = set(re.findall(r"'([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)': lazy", src))
    moved = dropped = 0
    out_lines = []
    for line in src.splitlines(keepends=True):
        m = re.search(r"'([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)': lazy", line)
        key = m.group(1) if m else None
        if key in rewrites:
            survivor = rewrites[key]
            if survivor in existing:
                # The survivor already renders this screen; the duplicate line
                # would be a second key pointing at the same component.
                dropped += 1
                continue
            existing.add(survivor)
            out_lines.append(line.replace(key, survivor))
            moved += 1
            continue
        out_lines.append(line)
    REGISTRY.write_text("".join(out_lines))

    print(f"removed {len(rows) - len(kept)} redundant entries "
          f"({len(kept)} remain); registry: {moved} rewired, {dropped} dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
