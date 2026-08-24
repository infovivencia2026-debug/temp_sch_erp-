#!/usr/bin/env python3
"""Generate docs/CROSS_ROLE_FLOWS.csv from the SPA feature catalogue.

WHY THIS IS GENERATED. The first version was written once by hand-matching
keywords and then went stale without anybody noticing: by the time it was next
read, 70 of its 310 rows pointed at features that no longer existed. The
finance workspace had been reorganised — `collections` and `concessions_refunds`
folded into `fees` and `accounts` — and a document nobody regenerates records
the product as it was on the day somebody wrote it.

So it is derived from `web/src/catalog.gen.ts`, which is itself generated from
`docs/edu_features.csv`. Re-run after `make catalog`.

WHAT IT IS FOR. A flow is a job that crosses roles: a parent applies for leave
and a teacher decides it; a clerk raises a bill and an accountant settles it.
Those hand-offs are where this product is most likely to be wrong, because each
side is built and tested on its own, and nothing in the code says the two halves
belong to the same story.

A row is one role's step in one flow. The chain column names the hand-off.
"""
import csv
import re
import sys
from pathlib import Path
from collections import OrderedDict

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "web" / "src" / "catalog.gen.ts"
# Whether a feature is BUILT is not in the client catalogue — it is derived
# from the SPA's component registry into this file, which is what the server
# answers `live` from. Reading it here keeps the flow document honest about
# which steps of a hand-off actually exist.
IMPLEMENTED = ROOT / "internal" / "api" / "implemented_gen.go"
OUT = ROOT / "docs" / "CROSS_ROLE_FLOWS.csv"

# Each flow is matched against a feature's key and its title. Terms are ordered
# most specific first only for readability; matching is a plain any().
#
# Terms are deliberately narrow. The previous document put "Seller Admin" in
# the health-and-infirmary flow because a billing feature mentioned "care", and
# a flow that lists an unrelated role is worse than one that misses a step:
# somebody checks the hand-off, finds nothing, and stops trusting the document.
FLOWS = OrderedDict([
    ("Admissions",              ["admission", "enquir", "applicant", "application", "prospect", "merit", "seat_alloc", "waitlist", "lottery", "offer"]),
    ("Fees & payment",          ["fee", "invoice", "receipt", "payment", "defaulter", "concession", "scholarship", "refund", "collection", "aging", "reconcil"]),
    ("Attendance",              ["attendance", "absent", "present", "muster", "biometric"]),
    ("Exams & results",         ["exam", "mark", "grade", "result", "report_card", "hall_ticket", "moderation", "question_paper", "gradebook"]),
    ("Board exams & statutory", ["board", "statutory", "udise", "apaar", "cbse", "affiliation", "compliance"]),
    ("Timetable",               ["timetable", "period", "substitut", "workload", "allocation", "roster"]),
    ("Homework & learning",     ["homework", "assignment", "lesson", "syllabus", "curriculum", "learning", "content", "resource", "classwork"]),
    ("Leave",                   ["leave", "lop", "absence_request", "sanction"]),
    ("Staff & payroll",         ["payroll", "salary", "pay_", "increment", "appraisal", "onboarding", "exit", "hiring", "recruit", "staff_record"]),
    ("Announcements",           ["circular", "announce", "notice", "broadcast", "message", "notification"]),
    ("Meetings & PTM",          ["ptm", "meeting", "parent_teacher", "appointment"]),
    ("Grievances",              ["grievance", "complaint", "escalat", "disciplin"]),
    ("Documents & certificates",["certificat", "document", "transfer_certificate", "bonafide", "id_card", "letter"]),
    ("Transport",               ["transport", "route", "bus", "vehicle", "driver", "stop", "pickup", "drop"]),
    ("Hostel",                  ["hostel", "room_alloc", "warden", "mess", "boarder"]),
    ("Library",                 ["library", "book", "issue_return", "accession", "opac", "fine"]),
    ("Health & infirmary",      ["health", "infirmary", "medical", "vaccination", "clinic", "nurse"]),
    ("Counselling",             ["counsel", "wellbeing", "psycholog"]),
    ("Activities & events",     ["event", "activity", "activities", "sport", "club", "competition", "excursion", "trip"]),
    ("Onboarding a school",     ["tenant", "provision", "subscription", "seat_overage", "white_label", "school_setup", "getting_started"]),
])

# A flow only earns its place if more than one role takes part; a single-role
# list is a workspace, not a hand-off.
MIN_ROLES = 2


def catalogue():
    src = CATALOG.read_text()
    # The generated file is a nested literal; parse it structurally instead.
    out = []
    for block in re.finditer(r"\{\s*key:\s*'([a-z_0-9]+\.[a-z_0-9]+\.[a-z_0-9]+)'(.*?)\}", src, re.S):
        key, rest = block.group(1), block.group(2)
        title = re.search(r"(?:name|title|label):\s*'([^']*)'", rest)
        out.append({"key": key, "title": (title.group(1) if title else key.split(".")[-1])})
    built = set(re.findall(r'"([a-z_]+\.[a-z_]+\.[a-z_0-9]+)"', IMPLEMENTED.read_text()))
    for f in out:
        f["live"] = f["key"] in built
    return out


ROLE_NAMES = {
    "institution_admin": "Principal", "faculty": "Teacher", "hod": "HOD",
    "finance": "Fee Counter", "admissions": "Front Office", "hr": "Office Clerk",
    "student": "Student", "parent": "Parent", "librarian": "Librarian",
    "transport_manager": "Transport Manager", "super_admin": "Management",
    "seller_admin": "Software Vendor",
}


def main():
    feats = catalogue()
    if not feats:
        print("no features parsed from the catalogue", file=sys.stderr)
        return 1

    rows = []
    for flow, terms in FLOWS.items():
        hits = []
        for f in feats:
            hay = (f["key"] + " " + f["title"]).lower()
            if any(t in hay for t in terms):
                hits.append(f)
        by_role = OrderedDict()
        for f in hits:
            by_role.setdefault(f["key"].split(".")[0], []).append(f)
        if len(by_role) < MIN_ROLES:
            continue
        step = 0
        chain = " -> ".join(ROLE_NAMES.get(r, r) for r in by_role)
        for role_key, fs in by_role.items():
            for f in fs:
                step += 1
                rows.append({
                    "flow": flow,
                    "chain": chain,
                    "step": step,
                    "role": ROLE_NAMES.get(role_key, role_key),
                    "role_key": role_key,
                    "feature": f["title"],
                    "feature_key": f["key"],
                    "workspace": f["key"].split(".")[1],
                    "built": "yes" if f["live"] else "no",
                })

    with OUT.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=[
            "flow", "chain", "step", "role", "role_key",
            "feature", "feature_key", "workspace", "built"])
        w.writeheader()
        w.writerows(rows)
    flows = len({r["flow"] for r in rows})
    print(f"{OUT.relative_to(ROOT)}: {len(rows)} rows across {flows} flows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
