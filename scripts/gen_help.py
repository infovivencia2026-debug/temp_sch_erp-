#!/usr/bin/env python3
"""Generate the assistant's user-facing help corpus from the feature catalogue.

    python3 scripts/gen_help.py          # writes docs/help/role-*.md

WHY THIS EXISTS. The assistant is fed everything in docs/, and everything in
docs/ is written for whoever is BUILDING this product: contracts, design
systems, deferral registers. Asked "how do I collect a fee from a parent?" the
bot retrieved four chunks of roadmap and design-system prose and correctly
answered that it did not know -- which is the honest failure, and still a
failure, because the person asking is a clerk with a parent at the counter.

So the catalogue becomes prose. FEATURES.csv already carries one plain sentence
per screen ("What it does"), written for a reader rather than a compiler, and
it covers only the 267 screens that actually exist. Grouping those by role and
by where they sit in the navigation produces the page nobody had written: what
you can do, where it is, and what it is for.

Generated rather than hand-written because the catalogue moves. A help page
that drifts from the product is worse than none: it sends somebody to a screen
that is not there and costs them the trust they would otherwise extend to the
next answer.
"""
from __future__ import annotations

import csv
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "FEATURES.csv"
OUT = ROOT / "docs" / "help"

# The catalogue names roles as a person would say them; the URL and the seed
# data use a key. Both appear in the page, because somebody reading over a
# colleague's shoulder sees the name and somebody reading a support ticket sees
# the key.
ROLE_KEYS = {
    "Accounts & Finance": "finance",
    "Admissions & Front Office": "admissions",
    "Faculty / Teacher": "faculty",
    "HR & Payroll": "hr",
    "Institution Admin / Principal": "institution_admin",
    "Parent / Guardian": "parent",
    "Seller Admin": "seller_admin",
    "Student": "student",
    "Super Admin": "super_admin",
}

# What the person in this role is actually trying to get done. One sentence,
# because the list that follows is long and a reader needs to know whether they
# are on their own page before they start it.
ROLE_INTRO = {
    "Accounts & Finance": (
        "You collect fees, chase what is owed, and answer for the numbers at the "
        "end of the month. Most days start at Fee Counter and end at the day book."
    ),
    "Admissions & Front Office": (
        "You are the first person a family meets. Enquiries, applications, "
        "admission fees and the paperwork that turns an applicant into a student."
    ),
    "Faculty / Teacher": (
        "Your classes, your subjects, and the children in them. Attendance in the "
        "morning, marks at the end of a term, and a record of anything that needs "
        "the office to know."
    ),
    "HR & Payroll": (
        "Everybody the school employs: joining, leave, salary, and the statutory "
        "filings that follow from all three."
    ),
    "Institution Admin / Principal": (
        "The whole school. You approve what others raise, set what everybody else "
        "works inside, and read the counts that say whether it is going well."
    ),
    "Parent / Guardian": (
        "Your child at this school. Fees, attendance, results, the bus, and "
        "anything the school has sent you."
    ),
    "Seller Admin": (
        "The schools using this product: what each one has, what it costs to "
        "provide, and what they have asked for."
    ),
    "Student": "Your own timetable, attendance, results, fees and documents.",
    "Super Admin": (
        "The platform across every institution. Tenancy, permissions, and the "
        "audit trail of who changed what."
    ),
}


def load() -> "OrderedDict[str, OrderedDict[str, OrderedDict[str, list[dict]]]]":
    """role -> workspace -> section -> [feature rows], in catalogue order."""
    tree: OrderedDict = OrderedDict()
    with SRC.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            role = (row.get("Role") or "").strip()
            if not role:
                continue
            ws = (row.get("Workspace") or "General").strip()
            sec = (row.get("Section") or ws).strip()
            tree.setdefault(role, OrderedDict()).setdefault(ws, OrderedDict()).setdefault(sec, []).append(row)
    return tree


def slug(s: str) -> str:
    keep = [c.lower() if c.isalnum() else "-" for c in s]
    return "".join(keep).strip("-").replace("--", "-")


def page(role: str, workspaces: OrderedDict) -> str:
    key = ROLE_KEYS.get(role, slug(role))
    total = sum(len(f) for ws in workspaces.values() for f in ws.values())
    out: list[str] = []
    out.append(f"# Using the app as {role}")
    out.append("")
    out.append(ROLE_INTRO.get(role, ""))
    out.append("")
    out.append(
        f"You have {total} screens. They are grouped the way the sidebar groups "
        f"them: a workspace holds sections, and a section holds the screens "
        f"themselves. Your workspace key is `{key}`, which is the first part of "
        f"every address in this role."
    )
    out.append("")
    out.append(
        "Each entry below is the name you will see in the sidebar, followed by "
        "what that screen is for and the data it can reach."
    )
    out.append("")

    for ws, sections in workspaces.items():
        out.append(f"## {ws}")
        out.append("")
        for sec, rows in sections.items():
            out.append(f"### {sec}")
            out.append("")
            for r in rows:
                name = (r.get("Feature") or "").strip()
                does = (r.get("What it does") or "").strip().rstrip(".")
                scope = (r.get("Data scope") or "").strip()
                where = f"Sidebar → {ws} → {sec} → {name}" if sec != ws else f"Sidebar → {ws} → {name}"
                out.append(f"**{name}.** {does}.")
                out.append("")
                out.append(f"- Where to find it: {where}")
                if scope:
                    out.append(f"- What it can see: {scope}")
                also = (r.get("Also readable by") or "").strip()
                if also:
                    out.append(f"- Also visible to: {also.replace(' ', ', ')}")
                out.append("")
    out.append("")
    out.append(
        "If a screen listed here is not in your sidebar, it is because nothing "
        "has been assigned to you for it yet -- a teacher with no section, a head "
        "of department with no department. The permission is real and the "
        "workspace is empty; ask the office to make the assignment rather than "
        "waiting for a release."
    )
    out.append("")
    return "\n".join(out)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    tree = load()
    written = 0
    for role, workspaces in tree.items():
        text = page(role, workspaces)
        path = OUT / f"role-{ROLE_KEYS.get(role, slug(role))}.md"
        path.write_text(text, encoding="utf-8")
        n = sum(len(f) for ws in workspaces.values() for f in ws.values())
        print(f"  {path.relative_to(ROOT)}  ({n} screens, {len(text)} chars)")
        written += 1
    print(f"\n  wrote {written} role pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
