#!/usr/bin/env python3
"""Fold the merged-in groups onto the surviving role's own groups.

Merging eight personas moved their features across but kept their group names,
so the principal's Operations workspace ended up with Transport *and* Fleet,
Routes, Today and Tracking — four names for one job, because that is how the
transport manager's own workspace had been divided. Same story for Library and
Catalogue/Circulation, and for the teacher's My Class beside My Classes.

This is the tidy-up pass: every incoming group is mapped onto the group the
surviving role already uses. Feature keys change again, so the registry is
rewired in step.

    python3 scripts/consolidate_groups.py && make catalog
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

# role -> old (workspace, group) -> new (workspace, group)
CONSOLIDATE = {
    "Institution Admin / Principal": {
        # One transport job, not four. Fleet/Routes/Tracking/Today were the
        # transport manager's internal divisions of it.
        ("Operations", "Fleet"): ("Operations", "Transport"),
        ("Operations", "Routes"): ("Operations", "Transport"),
        ("Operations", "Today"): ("Operations", "Transport"),
        ("Operations", "Tracking"): ("Operations", "Transport"),
        ("Operations", "Catalogue"): ("Operations", "Library"),
        ("Operations", "Circulation"): ("Operations", "Library"),
        ("Operations", "Rooms"): ("Operations", "Hostel"),
        ("Operations", "Daily"): ("Operations", "Hostel"),
        ("Operations", "Complaints"): ("Operations", "Hostel"),
        # The department head's view of the staff is the principal's staff view
        # with a filter on it, which is a scope, not a workspace.
        ("My Department", "My Department"): ("Staff", "Staff"),
        ("Teachers", "Teachers"): ("Staff", "Staff"),
    },
    "Faculty / Teacher": {
        ("My Class", "My Class"): ("My Classes", "My Classes"),
        ("Assessments", "Marks & Report Cards"): ("Assessments", "Marks & Assessment"),
        ("Communication", "Parent Communication"): ("Communication", "Communication"),
    },
    "Super Admin": {
        ("Home", "Home"): ("Dashboard", "Dashboard"),
        ("Access", "Users"): ("Access & Security", "Access & Security"),
        ("Configuration", "School Settings"): ("Institution Setup", "Institution Setup"),
        ("Data", "Data"): ("Platform Configuration", "Platform Configuration"),
    },
}


def slug(s: str) -> str:
    s = re.sub(r"[’'`]", "", s.lower())
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def main() -> int:
    rows = list(csv.DictReader(CSV_PATH.open()))
    fields = list(rows[0].keys())

    moved = {}
    changed = 0
    for r in rows:
        role = r["Role"].strip()
        plan = CONSOLIDATE.get(role, {})
        pair = (r["Workspace"].strip(), r["Section"].strip())
        if pair not in plan:
            continue
        rk = ROLE_KEYS[role]
        old = f"{rk}.{slug(pair[1])}.{slug(r['Feature'])}"
        ws, grp = plan[pair]
        r["Workspace"], r["Section"] = ws, grp
        moved[old] = f"{rk}.{slug(grp)}.{slug(r['Feature'])}"
        changed += 1

    # A consolidated feature can collide with one the target group already has.
    seen, out_rows, collisions = set(), [], 0
    for r in rows:
        key = f"{ROLE_KEYS[r['Role'].strip()]}.{slug(r['Section'])}.{slug(r['Feature'])}"
        if key in seen:
            collisions += 1
            continue
        seen.add(key)
        out_rows.append(r)

    # Re-emit grouped so navigation order follows row order.
    grouped = OrderedDict()
    for r in out_rows:
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
    live = set(re.findall(r"'([a-z0-9_.]+)': lazy", src))
    kept, rewired, dropped = [], 0, 0
    for line in src.splitlines(keepends=True):
        m = re.search(r"'([a-z0-9_.]+)': lazy", line)
        key = m.group(1) if m else None
        if key and key in moved:
            new = moved[key]
            if new in live and new != key:
                dropped += 1
                continue
            live.add(new)
            kept.append(line.replace(key, new))
            rewired += 1
            continue
        kept.append(line)
    REGISTRY.write_text("".join(kept))

    print(f"consolidated {changed} features; {collisions} collided and were dropped")
    print(f"registry: {rewired} rewired, {dropped} dropped")
    print(f"total features: {len(final)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
