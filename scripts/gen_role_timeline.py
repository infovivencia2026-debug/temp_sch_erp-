#!/usr/bin/env python3
"""Every feature, per role, with when in the school year it is used and what it
joins to on either side.

Writes docs/ROLE_FEATURE_TIMELINE.csv.

Five of the columns are read out of the code and are therefore true by
construction:

    Feature Key   from web/src/catalog.gen.ts, which is the catalogue the SPA
                  actually builds its navigation from
    Data Scope    the boundary the API evaluates that feature under
    Built         from internal/api/implemented_gen.go, which is generated from
                  the SPA's component registry -- so "yes" means a screen
                  exists, not that somebody thought one should
    Screen        the component the registry maps the key to
    Also Held By  every other role whose catalogue carries a feature of the
                  same name, which is how you find one job sitting on two desks

Three are a curated judgement, and are called out here so nobody mistakes them
for facts extracted from the source:

    Year Phase / Typical Months / When Used
    Depends On            what must exist before this can be done at all
    Feeds Into            what consumes its output

The phase mapping keys off the section a feature sits in, because a section is
already the product's own grouping of "things done at the same time by the same
person". Anything whose section does not match falls to "Self service", which
is the honest answer for a profile screen or a directory.
"""

import csv
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- when in the year -------------------------------------------------------
# Keyed on fragments of the section and feature slug. First match wins, so the
# more specific entries come first. Months follow the Indian academic year,
# April to March, which is the year docs/gap_analysis/00_TIMELINE.md walks.
PHASE = [
    (("admission", "enquiry", "enquir", "application", "enrol", "funnel",
      "front_office", "prospect", "waitlist"),
     "01 Admissions", "Nov-Aug",
     "Heaviest Nov-Mar for the coming year; again in Aug for mid-year transfers"),
    (("setup", "institution", "academic_structure", "curriculum", "subject",
      "class", "section", "campus", "calendar"),
     "02 Year setup", "Feb-Apr",
     "Classes, sections, subjects and the calendar, built before the year opens"),
    (("staff", "hr", "recruit", "employee", "payroll", "appraisal",
      "directory", "workload", "leave"),
     "03 Staffing", "Feb-Apr",
     "Appointments and allocation before April; payroll monthly, appraisal in Feb"),
    (("timetable", "substitution", "cover"),
     "04 Timetable", "Mar-Apr",
     "Drafted Jan-Mar against vacant posts, published in April, amended all year"),
    (("fee", "invoice", "payment", "collection", "finance", "accounts",
      "concession", "refund", "billing", "dues", "ledger", "reconcil",
      "payable", "receivable", "cheque", "bank", "expense", "budget"),
     "05 Fees", "Apr-Mar",
     "Invoices raised in April and per term; collection and arrears chased monthly"),
    (("attendance", "register"),
     "06 Daily attendance", "Apr-Mar", "Every teaching day"),
    (("teaching", "lesson", "syllabus", "homework", "classwork", "lms",
      "assignment", "diary", "my_classes"),
     "07 Teaching", "Apr-Mar",
     "Every teaching day; lesson plans weekly, syllabus coverage checked fortnightly"),
    (("exam", "marks", "assessment", "question", "grading", "report_card",
      "result", "progress_card", "evaluation", "invigilat", "hall"),
     "08 Examinations", "Jul, Oct, Mar",
     "Unit tests from May; term exams July and October; finals in March"),
    (("communication", "circular", "message", "messaging", "remark", "notice",
      "announcement", "ptm", "forum", "broadcast", "chat"),
     "09 Communication", "Apr-Mar",
     "Continuous; peaks around exams, PTM and fee due dates"),
    (("transport", "hostel", "library", "infirmary", "health", "inventory",
      "stores", "asset", "procurement", "cafeteria", "bus", "visitor",
      "gate", "office_log", "security_desk", "vendor_", "purchase"),
     "10 Operations", "Apr-Mar",
     "Continuous; procurement concentrated Dec-Feb for the coming year"),
    (("discipline", "welfare", "counsel", "support", "cwsn", "wellbeing",
      "behaviour", "behavior"),
     "11 Pastoral", "Apr-Mar", "Continuous, as needed"),
    (("promotion", "certificate", "transfer", "rollover", "year_end",
      "alumni", "lifecycle", "tc_"),
     "12 Year end", "Mar-Apr",
     "Results, promotion, transfer certificates and rollover into the next year"),
    (("compliance", "statutory", "government", "grant", "board",
      "affiliation", "audit"),
     "13 Compliance", "Apr-Mar",
     "Returns fall on statutory dates; board work concentrated Sep-Dec"),
    (("dashboard", "home", "kpi", "analytics", "report", "insight", "my_day",
      "my_work", "export", "approval", "ai_", "automation"),
     "14 Oversight", "Apr-Mar",
     "Read continuously; reviewed monthly and at term end"),
    (("tenant", "subscription", "plan", "entitlement", "seller", "usage",
      "support", "platform", "customer", "access_security", "impersonation"),
     "00 Vendor", "Continuous",
     "The vendor's own back office, outside any one school's year"),
]

FALLBACK = ("15 Self service", "Any time", "Whenever the person needs it")

# --- what joins to what -----------------------------------------------------
# Upstream is what must already exist for the feature to do anything at all.
# Downstream is what consumes its output. This is the column that shows why an
# empty screen is usually somebody else's unfinished work rather than a bug.
JOINS = {
    "01 Admissions": (
        "Year setup: classes and sections have to exist to admit into",
        "Enrolment, which is what fee invoicing and the attendance register key off"),
    "02 Year setup": (
        "Last year's structure, or nothing at all on a new tenant",
        "Everything. Admissions, timetable, fees and exams all key off classes and subjects"),
    "03 Staffing": (
        "Year setup: departments and subjects",
        "Timetable allocation, payroll, leave approval and cover"),
    "04 Timetable": (
        "Staffing and year setup: teachers, subjects, sections, periods",
        "Daily attendance, every teacher's data scope, substitution, exam invigilation"),
    "05 Fees": (
        "Enrolment, and the fee structure published for the year",
        "Collection reports, arrears chasing, the TC dues gate, statutory returns"),
    "06 Daily attendance": (
        "Timetable and enrolment",
        "The report card attendance line, absence alerts, statutory returns, staff loss of pay"),
    "07 Teaching": (
        "Timetable, which decides which teacher reaches which section and subject",
        "Syllabus coverage, homework submissions, what a parent sees in the portal"),
    "08 Examinations": (
        "Timetable and the grading scale; marks need exam papers to exist first",
        "Report cards, publication to families, and promotion at year end"),
    "09 Communication": (
        "Enrolment and guardian records, which are the address list",
        "Nothing. Communication is the output, not an input to anything else"),
    "10 Operations": (
        "Year setup and enrolment: who is on the route, in the hostel, holding the book",
        "Transport and hostel fee heads, inventory issue, health records"),
    "11 Pastoral": (
        "Enrolment and teaching scope",
        "Remarks to families, support plans, the conduct line on a report card"),
    "12 Year end": (
        "Examination results and fee clearance",
        "Next year's enrolment, the transfer certificate, the alumni record"),
    "13 Compliance": (
        "Enrolment, attendance and staff records",
        "Government returns, board affiliation, grant-in-aid claims"),
    "14 Oversight": (
        "Every module above. A dashboard is downstream of everything",
        "Decisions, not data"),
    "00 Vendor": (
        "A provisioned tenant",
        "What the school is entitled to use, and what it is billed"),
    "15 Self service": ("An account", "The person's own record"),
}


# --- who hands what to whom -------------------------------------------------
# Keyed on a fragment of the feature key, most specific first. Each entry is
# (upstream role, downstream role, approver, who is notified, the chain).
#
# The "Notifies" values are not invented. They are the notification kinds
# actually emitted by notify() and deliverFamilyAlerts() in internal/api --
# student_remark, staff_remark, homework, homework_submitted, report_card,
# circular, absence_alert, fee, attendance, ptm. Where a flow emits nothing the
# column says "None" rather than describing an alert nobody receives.
FLOWS = [
    ("homework_submitted", "", "", "", "", ""),
    (".homework", "Faculty (sets the work)", "Student and Parent (turn it in)", "",
     "Parent on publish; Faculty on submission",
     "Faculty sets -> Parent/Student see it -> they submit -> Faculty marks"),
    ("classwork", "Faculty (sets the work)", "Student and Parent", "",
     "Parent on publish; Faculty on submission",
     "Faculty sets -> Parent/Student see it -> they submit -> Faculty marks"),
    ("assignments_submissions", "Faculty", "Student and Parent", "",
     "Parent on publish; Faculty on submission",
     "Faculty sets -> Student submits -> Faculty marks and returns feedback"),
    ("lesson_plan", "Faculty (writes it)", "HOD (reviews it)", "HOD / Principal", "None",
     "Faculty writes -> HOD approves or returns -> Faculty marks it taught -> coverage moves"),
    ("syllabus", "Faculty (marks lessons taught)", "HOD / Principal", "", "None",
     "Faculty teaches -> coverage percentage -> HOD sees who is behind"),
    ("child_remarks", "Faculty (writes it)", "Parent (reads it)", "",
     "Parent, same day (student_remark)",
     "Faculty writes -> every guardian alerted -> Parent reads it in the portal"),
    ("student_remark", "Faculty", "Parent", "", "Parent (student_remark)",
     "Faculty writes -> guardians alerted -> Parent reads"),
    ("behavior_demerits", "Faculty", "Parent", "", "Parent (student_remark)",
     "Faculty records conduct -> guardians alerted -> Parent reads"),
    ("teacher_remarks", "HOD / Principal / Parent (writes it)", "Faculty (reads it)", "",
     "The teacher it is about (staff_remark)",
     "HOD, Principal or Parent writes -> teacher alerted -> teacher reads it on their own screen"),
    ("remarks_about_me", "HOD / Principal / Parent", "Faculty (the subject)", "",
     "The teacher it is about (staff_remark)",
     "Somebody writes -> teacher alerted -> teacher reads"),
    ("substitution", "Faculty (asks for cover)", "HOD (assigns it)", "HOD",
     "The teacher given the period",
     "Faculty requests -> HOD sees who is free -> HOD assigns -> covering teacher alerted"),
    ("report_card", "Faculty (subject teachers enter marks)",
     "Parent and Student (read the published card)", "Class teacher publishes",
     "Parent and Student on publish (report_card)",
     "Subject teachers enter marks -> class teacher checks and publishes -> family alerted"),
    ("marks_entry", "Faculty (the subject teacher)", "Class teacher (compiles the card)", "",
     "None until the card is published",
     "Subject teacher enters -> grade derived from the school's scale -> class teacher compiles"),
    ("grading_scale", "Institution Admin (sets the bands)", "Faculty (marks derive grades)", "",
     "None", "Principal sets 91-100 = A1 -> every mark entered afterwards derives its grade"),
    ("circular", "Institution Admin / Faculty (publishes)", "Parent and Student", "",
     "Parent and Student (circular); SMS and email queued",
     "Author publishes -> addressed to parents, students or both -> alerts and queued messages"),
    ("announcement", "Institution Admin", "Parent, Student, Staff", "", "Recipients (circular)",
     "Published -> appears in the portal and the alert feed"),
    ("apply_student_leave", "Parent (applies)", "Class teacher (decides)", "Class teacher",
     "Class teacher and HR",
     "Parent applies -> class teacher approves -> register and HR return updated"),
    ("student_leave_requests", "Parent", "Class teacher", "Class teacher", "Class teacher",
     "Parent applies -> class teacher decides -> attendance reflects it"),
    ("leave", "Faculty / staff member (applies)", "HOD and HR (decide)", "HOD / HR",
     "The applicant on decision",
     "Staff applies -> HOD and HR see it -> approved -> cover requested -> payroll balance updated"),
    ("attendance", "Faculty (marks the register)", "Parent, HR, Compliance", "",
     "Parent on absence (absence_alert)",
     "Faculty marks -> parent alerted if absent -> report card line and statutory return"),
    ("timetable", "HOD / Institution Admin (builds it)", "Faculty and Student", "", "None",
     "HOD builds -> published -> defines each teacher's scope -> Faculty and Student read it"),
    ("faculty_allocation", "HOD / Institution Admin", "Faculty", "", "None",
     "Allocation decides who teaches what, which is what sets every teacher's data scope"),
    ("language_subject_allocation", "Institution Admin / HOD", "Faculty and Student", "", "None",
     "L1 and L2 chosen per student -> decides section grouping and the report card subjects"),
    ("admission", "Admissions & Front Office", "Accounts (invoices) and Faculty (teaches)",
     "Institution Admin", "None",
     "Enquiry -> application -> admitted -> enrolled -> invoiced -> on a register"),
    ("enquir", "Admissions & Front Office", "Admissions", "", "None",
     "Enquiry captured -> followed up -> becomes an application"),
    ("fee", "Accounts & Finance (raises)", "Parent (pays)",
     "Institution Admin approves the structure", "Parent on dues (fee)",
     "Structure approved -> invoices raised -> parent pays -> receipt -> arrears chased"),
    ("payroll", "HR & Payroll (runs it)", "Accounts & Finance (pays it)", "Institution Admin",
     "None", "Attendance and leave -> loss of pay -> payroll run -> approved -> bank export"),
    ("employee", "HR & Payroll (appoints)", "HOD and Institution Admin", "Institution Admin",
     "None", "HR appoints -> HR issues the login -> HOD allocates the timetable"),
    ("promotion", "Class teacher / Institution Admin", "Next year's enrolment",
     "Institution Admin", "None",
     "Results -> promotion decision -> new enrolment -> old one closed with history kept"),
    ("certificate", "Institution Admin / Front Office", "Parent (receives it)",
     "Institution Admin", "None",
     "Dues cleared -> TC generated from a snapshot -> issued to the family"),
    ("transport", "Operations (routes and stops)", "Parent and Accounts", "", "None",
     "Route built -> student allocated -> transport fee head -> parent billed"),
    ("hostel", "Operations", "Parent and Accounts", "", "None",
     "Room allotted -> hostel fee head -> parent billed"),
    ("payment", "Parent (pays)", "Accounts & Finance", "", "Parent (receipt)",
     "Parent pays -> receipt issued -> ledger and arrears updated"),
    ("tenant", "Seller Admin", "Institution Admin", "Seller Admin", "New school's admin",
     "Vendor provisions -> credentials sent -> principal sets the school up"),
    ("subscription", "Seller Admin", "Institution Admin", "Seller Admin", "None",
     "Plan chosen -> entitlement set -> decides which modules the school sees"),
]

GENERIC_FLOW = ("", "", "", "None", "")



# Where no specific flow above matches, the phase still says who is upstream
# and downstream of this kind of work. Blank columns read as "nobody hands this
# to anybody", which is almost never true and is worse than a general answer.
PHASE_FLOW = {
    "00 Vendor": ("Seller Admin", "Institution Admin", "Seller Admin", "None",
                  "Vendor acts -> the school sees the result in what it may use"),
    "01 Admissions": ("Admissions & Front Office", "Accounts and Faculty",
                      "Institution Admin", "None",
                      "Enquiry -> application -> admission -> enrolment -> invoice and register"),
    "02 Year setup": ("Institution Admin", "Every other role", "Institution Admin", "None",
                      "Principal builds the year -> everybody else works inside it"),
    "03 Staffing": ("HR & Payroll", "HOD and Institution Admin", "Institution Admin", "None",
                    "HR appoints -> issues the login -> HOD allocates the work"),
    "04 Timetable": ("HOD / Institution Admin", "Faculty and Student", "Institution Admin", "None",
                     "Grid built -> published -> sets every teacher's scope -> read by class and family"),
    "05 Fees": ("Accounts & Finance", "Parent", "Institution Admin", "Parent on dues (fee)",
                "Structure -> invoice -> parent pays -> receipt -> arrears"),
    "06 Daily attendance": ("Faculty", "Parent, HR, Compliance", "",
                            "Parent on absence (absence_alert)",
                            "Register marked -> family alerted -> report card and statutory return"),
    "07 Teaching": ("Faculty", "Student and Parent", "HOD where a plan is reviewed",
                    "Parent on published work (homework)",
                    "Faculty teaches and sets work -> family sees it -> coverage tracked"),
    "08 Examinations": ("Faculty (subject teachers)", "Class teacher, then Parent and Student",
                        "Class teacher publishes", "Family on publish (report_card)",
                        "Marks entered -> card compiled -> checked -> published -> family alerted"),
    "09 Communication": ("Institution Admin / Faculty", "Parent and Student", "",
                         "Recipients (circular)",
                         "Author writes -> addressed -> delivered in-app, and queued for SMS or email"),
    "10 Operations": ("Operations staff", "Parent and Accounts", "Institution Admin", "None",
                      "Facility recorded -> student allocated -> fee head -> parent billed"),
    "11 Pastoral": ("Faculty", "Parent and Institution Admin", "", "Parent (student_remark)",
                    "Observed -> recorded -> family told -> support plan where needed"),
    "12 Year end": ("Class teacher / Institution Admin", "Next year, and the family",
                    "Institution Admin", "None",
                    "Results -> promotion -> dues cleared -> certificate -> next year's enrolment"),
    "13 Compliance": ("Institution Admin", "Government and the board", "Institution Admin", "None",
                      "Records kept all year -> return compiled -> filed on the statutory date"),
    "14 Oversight": ("Every role above (they produce the data)", "Institution Admin", "", "None",
                     "Work happens -> it is counted -> the principal reads it and decides"),
    "15 Self service": ("The person themselves", "Nobody", "", "None",
                        "Read or edited by its owner; nothing downstream depends on it"),
}


FEATURE_RE = re.compile(
    r"\{ key: '([^']+)', slug: '([^']+)', name: '((?:[^'\\]|\\.)*)', "
    r"scope: '([a-z_]+)', tier: '([a-z]+)', summary: '((?:[^'\\]|\\.)*)' \},$"
)


def unquote(s: str) -> str:
    return s.replace("\\'", "'").replace("\\\\", "\\")


# Sections whose meaning depends on whose desk they sit on. "Academics" is
# curriculum and structure to a principal and homework and results to a family;
# bucketing both the same way would put a parent's report card under year setup.
FAMILY_ROLES = {"parent", "student"}
PLATFORM_ROLES = {"seller_admin", "super_admin"}

# Words unambiguous enough to override the section they sit in.
STRONG = {
    "timetable": "04 Timetable",
    "substitution": "04 Timetable",
    "report_card": "08 Examinations",
    "marks_entry": "08 Examinations",
    "payroll": "03 Staffing",
    "promotion": "12 Year end",
    "transfer_certificate": "12 Year end",
}
BY_ROLE = {
    ("academics", True): "07 Teaching",
    ("academics", False): "02 Year setup",
    ("learning", True): "07 Teaching",
    ("learning", False): "07 Teaching",
    ("students", False): "02 Year setup",
    ("department", False): "03 Staffing",
    ("school_life", True): "09 Communication",
    ("consent", True): "15 Self service",
}


def flow_for(feature_key: str):
    """The role handoff around one feature, or blanks where there is none.

    Matched on the feature key rather than the name, because a name is prose
    and a key is the thing the API gates on. Most specific first: the
    homework_submitted alert has to be excluded before ".homework" matches it,
    or the alert is itself described as a piece of work somebody sets.
    """
    for frag, up, down, approver, notifies, chain in FLOWS:
        if frag in feature_key:
            return up, down, approver, notifies, chain
    return GENERIC_FLOW


def _by_name(name: str):
    for fragments, phase, months, note in PHASE:
        if phase == name:
            return phase, months, note
    return FALLBACK


def phase_for(role_key: str, section_slug: str, feature_slug: str):
    """Section first, feature second.

    Matching against section and feature concatenated together let any fragment
    anywhere in either string win, and the order of PHASE then decided which --
    arbitrarily. hod.timetable.class_timetable landed in Year setup because
    "class" appears in that bucket's list before "timetable" appears in the
    next; transport's seatbelt camera landed in Admissions because "seat" was
    listed there.

    The section is the product's own answer to "what group of work is this",
    so it decides. The feature slug is consulted only when the section says
    nothing, which is where a generic section like "operations" gets rescued by
    a specific feature name.
    """
    # The vendor's own back office, whatever its sections are called. Without
    # this, seller_admin's "subscriptions_billing" matched "billing" and filed
    # the vendor's seat-overage renewals under a school's fee collection.
    if role_key in PLATFORM_ROLES and section_slug not in ("support", "audit"):
        for fragments, phase, months, note in PHASE:
            if phase == "00 Vendor" and any(f in section_slug for f in fragments):
                return phase, months, note

    # A handful of words that mean the same thing wherever they appear, checked
    # before the section. A principal generating the master timetable is doing
    # timetable work, not year setup, even though it lives under Academics.
    for word, phase in STRONG.items():
        if word in feature_slug:
            return _by_name(phase)

    named = BY_ROLE.get((section_slug, role_key in FAMILY_ROLES))
    if named:
        return _by_name(named)
    for fragments, phase, months, note in PHASE:
        if any(f in section_slug for f in fragments):
            return phase, months, note
    for fragments, phase, months, note in PHASE:
        if any(f in feature_slug for f in fragments):
            return phase, months, note
    return FALLBACK


def main() -> int:
    catalog = (ROOT / "web" / "src" / "catalog.gen.ts").read_text(encoding="utf-8")
    implemented = (ROOT / "internal" / "api" / "implemented_gen.go").read_text(encoding="utf-8")

    built = set(re.findall(r'"([a-z_0-9.]+)":\s+true', implemented))

    screens = {}
    for path in (ROOT / "web" / "src" / "features").rglob("*.ts"):
        text = path.read_text(encoding="utf-8")
        for key, comp in re.findall(
            r"'([a-z_0-9]+\.[a-z_0-9]+\.[a-z_0-9]+)':\s*lazy\(\s*\(\)\s*=>\s*import\('([^']+)'\)",
            text,
        ):
            screens[key] = comp.split("/")[-1]

    # Walked line by line rather than matched as one expression. The generated
    # file is laid out with indentation that says which level a field belongs
    # to, and a single regex over the whole block has to encode that layout --
    # which then breaks silently the next time the generator's whitespace
    # changes, producing an empty CSV instead of an error.
    rows = []
    role_key = role_name = sec_slug = sec_name = workspace = ""
    for line in catalog.splitlines():
        stripped = line.strip()

        if line.startswith("    key: '"):
            role_key = stripped[len("key: '"):].rstrip("',")
            continue
        if line.startswith("    name: '"):
            role_name = unquote(stripped[len("name: '"):].rstrip("',"))
            continue
        if line.startswith("        slug: '"):
            sec_slug = stripped[len("slug: '"):].rstrip("',")
            continue
        if line.startswith("        name: '"):
            sec_name = unquote(stripped[len("name: '"):].rstrip("',"))
            continue
        if line.startswith("        workspace: '"):
            workspace = unquote(stripped[len("workspace: '"):].rstrip("',"))
            continue

        m = FEATURE_RE.match(stripped)
        if not m:
            continue
        key, slug, name, scope, tier, summary = m.groups()
        phase, months, when = phase_for(role_key, sec_slug, slug)
        upstream, downstream = JOINS.get(phase, ("", ""))
        up_role, down_role, approver, notifies, chain = flow_for(key)
        if not chain:
            up_role, down_role, approver, notifies, chain = PHASE_FLOW.get(
                phase, GENERIC_FLOW)
        rows.append({
            "Year Phase": phase,
            "Typical Months": months,
            "Role": role_name,
            "Role Key": role_key,
            "Workspace": workspace,
            "Section": sec_name,
            "Feature": unquote(name),
            "Feature Key": key,
            "Data Scope": scope,
            "Tier": tier,
            "Built": "yes" if key in built else "no",
            "Screen": screens.get(key, ""),
            "When Used": when,
            "Depends On": upstream,
            "Feeds Into": downstream,
            "Acts Before (role)": up_role,
            "Hands Off To (role)": down_role,
            "Approved By": approver,
            "Notifies": notifies,
            "Handoff Chain": chain,
            "Also Held By": "",
            "What The User Does": unquote(summary),
        })

    if not rows:
        raise SystemExit("parsed no features -- catalog.gen.ts layout has changed")

    # Which other roles carry a feature of the same name. Where a name appears
    # under five roles this is usually telling you it should not.
    by_name = defaultdict(set)
    for r in rows:
        by_name[r["Feature"].lower()].add(r["Role"])
    for r in rows:
        r["Also Held By"] = "; ".join(sorted(by_name[r["Feature"].lower()] - {r["Role"]}))

    rows.sort(key=lambda r: (r["Year Phase"], r["Role"], r["Section"], r["Feature"]))

    out = ROOT / "docs" / "ROLE_FEATURE_TIMELINE.csv"
    # utf-8-sig, because this file is opened in Excel. Without the BOM Excel
    # reads it as the system code page and turns every em dash and curly quote
    # in the summaries into mojibake, which makes the whole file look corrupt.
    with out.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    phases = len({r["Year Phase"] for r in rows})
    live = sum(1 for r in rows if r["Built"] == "yes")
    shared = sum(1 for r in rows if r["Also Held By"])
    print(f"role-feature timeline: {len(rows)} rows, {phases} phases, "
          f"{live} built, {shared} shared across roles -> {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
