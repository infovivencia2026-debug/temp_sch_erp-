#!/usr/bin/env python3
"""Fold eight personas into the roles that survive, and delete them.

The product settles on nine workspaces: the seven a school staffs plus the two
the vendor needs to run the installation. The eight removed here were either
narrower views of a surviving role (a vice principal sees what the principal
sees; a class teacher is a teacher with a section) or a specialism the
principal's Operations workspace now carries.

Nothing is dropped. Every feature is checked against the target role by slug
first, and only added where the target does not already have an equivalent —
so the merge fills gaps rather than duplicating the work the dedupe pass
already did.

    python3 scripts/merge_roles.py && make catalog
"""

import csv
import pathlib
import re
import sys
from collections import OrderedDict

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "docs" / "edu_features.csv"
REGISTRY = ROOT / "web" / "src" / "features" / "registry.ts"

# removed role -> (surviving role, workspace it lands in or None to keep its own)
#
# Operations and the three specialisms all land in the principal's Operations
# workspace, which is exactly what that tree asked for: Transport, Library,
# Hostel, Inventory, Infirmary under one heading.
MERGE = {
    "Vice Principal / Academic Coordinator": ("Institution Admin / Principal", None),
    "HOD / Department Head": ("Institution Admin / Principal", None),
    "Class Teacher": ("Faculty / Teacher", None),
    "IT Administrator": ("Super Admin", None),
    "Operations Staff": ("Institution Admin / Principal", "Operations"),
    "Transport Manager": ("Institution Admin / Principal", "Operations"),
    "Librarian": ("Institution Admin / Principal", "Operations"),
    "Hostel Warden": ("Institution Admin / Principal", "Operations"),
}

# Groups that exist only to say "which of my jobs am I doing today". Once the
# specialisms are one workspace under one role, the question does not arise.
DROP_GROUPS = {"Home", "My Work", "My Profile", "Reports", "Members", "Boarders"}

# The removed roles' own keys, needed to recognise their existing feature keys
# in the registry. Slugifying the display name is not the same thing — that
# gives "operations_staff" where the catalogue says "operations", and every one
# of that role's wired screens is then dropped instead of moved.
REMOVED_KEYS = {
    "Vice Principal / Academic Coordinator": "vice_principal",
    "HOD / Department Head": "hod",
    "Class Teacher": "class_teacher",
    "IT Administrator": "it_admin",
    "Operations Staff": "operations",
    "Transport Manager": "transport_manager",
    "Librarian": "librarian",
    "Hostel Warden": "hostel_warden",
}

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


def slug(s: str) -> str:
    s = re.sub(r"[’'`]", "", s.lower())
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


def main() -> int:
    rows = list(csv.DictReader(CSV_PATH.open()))
    fields = list(rows[0].keys())

    survivors = OrderedDict()
    incoming = []
    for r in rows:
        role = r["Role"].strip()
        if role in MERGE:
            incoming.append(r)
        else:
            survivors.setdefault(role, []).append(r)

    unknown = [r for r in survivors if r not in ROLE_KEYS]
    if unknown:
        print("ERROR: unmapped surviving role(s):", unknown, file=sys.stderr)
        return 1

    # What each surviving role already covers, by feature slug.
    have = {role: {slug(r["Feature"]) for r in rs} for role, rs in survivors.items()}

    merged = dropped_dupe = dropped_group = 0
    moved_keys = {}

    for r in incoming:
        src_role = r["Role"].strip()
        target, force_ws = MERGE[src_role]
        fslug = slug(r["Feature"].strip())

        if r["Section"].strip() in DROP_GROUPS and force_ws:
            # "Library overview", "Hostel overview" and the profile stubs are
            # the specialist's own front door. The principal already has one.
            dropped_group += 1
            continue

        if fslug in have[target]:
            # The survivor already has this feature. Its wiring, if any, must
            # still point somewhere: map the removed key onto the survivor's
            # existing one rather than losing the screen.
            for keep in survivors[target]:
                if slug(keep["Feature"]) == fslug:
                    moved_keys[f"{REMOVED_KEYS[src_role]}.{slug(r['Section'])}.{fslug}"] = \
                        f"{ROLE_KEYS[target]}.{slug(keep['Section'])}.{fslug}"
                    break
            dropped_dupe += 1
            continue

        old_key = f"{REMOVED_KEYS[src_role]}.{slug(r['Section'])}.{fslug}"
        row = dict(r)
        row["Role"] = target
        if force_ws:
            row["Workspace"] = force_ws
        survivors[target].append(row)
        have[target].add(fslug)
        moved_keys[old_key] = \
            f"{ROLE_KEYS[target]}.{slug(row['Section'])}.{fslug}"
        merged += 1

    # Re-emit grouped by role, then workspace, then group, so the generator's
    # row order still produces the navigation order.
    out_rows = []
    for role, rs in survivors.items():
        by_ws = OrderedDict()
        for r in rs:
            by_ws.setdefault(r["Workspace"].strip(), OrderedDict()) \
                 .setdefault(r["Section"].strip(), []).append(r)
        for groups in by_ws.values():
            for items in groups.values():
                out_rows.extend(items)

    with CSV_PATH.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(out_rows)

    # --- move the wiring for anything that shifted role ---------------------
    src = REGISTRY.read_text()
    live = set(re.findall(r"'([a-z0-9_.]+)': lazy", src))
    kept_lines, rewired, orphaned = [], 0, 0
    for line in src.splitlines(keepends=True):
        m = re.search(r"'([a-z0-9_.]+)': lazy", line)
        key = m.group(1) if m else None
        if key and key.split(".")[0] not in ROLE_KEYS.values():
            new = moved_keys.get(key)
            if new and new not in live:
                live.add(new)
                kept_lines.append(line.replace(key, new))
                rewired += 1
            else:
                orphaned += 1
            continue
        kept_lines.append(line)
    REGISTRY.write_text("".join(kept_lines))

    print(f"merged {merged} features into surviving roles "
          f"({dropped_dupe} already covered, {dropped_group} specialist front doors dropped)")
    print(f"roles: {len(survivors)} remain, {len(MERGE)} removed")
    print(f"registry: {rewired} rewired, {orphaned} dropped")
    print(f"total features: {len(out_rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
