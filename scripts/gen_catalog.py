#!/usr/bin/env python3
"""Generate the feature catalog from docs/edu_features.csv.

The CSV is the source of truth for what every role can see. Hand-maintaining
the same 419 entries in Go (for permission seeding and API authorisation) and
in TypeScript (for navigation and routing) would guarantee they drift, so both
are generated from it:

    internal/catalog/catalog_gen.go   permission keys, roles, sections, scopes
    web/src/catalog.gen.ts            navigation tree for the SPA

Run via `make catalog`. Never edit the generated files.
"""

import csv
import pathlib
import re
import sys
from collections import OrderedDict

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV = ROOT / "docs" / "edu_features.csv"

# --- role identity -----------------------------------------------------------
# Role keys match the `roles.key` column already seeded by internal/rbac, so a
# catalog role and an RBAC role are the same row, not two parallel notions.
ROLE_KEYS = {
    "Super Admin": "super_admin",
    "Institution Admin / Principal": "institution_admin",
    "Faculty / Teacher": "faculty",
    # A head of department held capabilities and no navigation at all: the
    # rbac role existed, the catalogue did not, so a HOD signed in to an
    # empty menu. The department is the boundary, not the institution --
    # internal/scope narrows the rows these features return.
    "HOD / Department Head": "hod",
    # The library desk. These features were on the principal's menu and the
    # librarian borrowed them from there, so trimming the principal's copy
    # would have taken the librarian's with it.
    "Librarian": "librarian",
    # The transport office. Same reason as the library: this role held no
    # catalogue of its own and borrowed the principal's transport section.
    "Transport Manager": "transport_manager",
    "Student": "student",
    # The names the sheet actually uses.
    #
    # These five were written as job titles -- "Fee Counter", "Office Clerk" --
    # while the sheet says "Accounts & Finance" and "HR & Payroll". The
    # generated files were committed before the sheet was reworded, so nothing
    # was visibly wrong until somebody next ran this and found five workspaces
    # skipped with a warning.
    "Parent / Guardian": "parent",
    "Accounts & Finance": "finance",
    "Board / Trustee": "board_member",
    "Admissions & Front Office": "admissions",
    # The reception desk, on its own.
    #
    # front_office is offered to schools — it is in the "Office staff" preset
    # next to admissions and finance — and the role's own blurb says "a
    # reception desk separate from admissions". But it had no catalogue, so a
    # school that gave somebody the receptionist role and nothing else handed
    # them a product with no menu in it at all: seven capability grants, zero
    # feature keys, an empty rail.
    #
    # It is deliberately not a copy of the admissions workspace. A receptionist
    # signs visitors in and answers the telephone; who is offered a seat is
    # somebody else's decision, and putting the approvals queue on this menu
    # would be handing out a screen whose every button answers 403.
    "Receptionist / Front Office": "front_office",
    "HR & Payroll": "hr",
    "Seller Admin": "seller_admin",
    # Four roles that held capabilities and no catalogue. A person holding
    # only one of them signed in to "No workspace": the rbac role granted the
    # permissions, nothing granted a feature key, and catalog.go draws a
    # workspace only from feature keys the identity holds. Each gets a small
    # honest workspace -- their day, the screens they use, their own profile
    # -- pointed at screens that already exist under the principal.
    "Examination Controller": "exam_controller",
    "IT Administrator": "it_admin",
    "Operations Staff": "operations",
    "Driver / Bus Attendant": "driver",
}

# Display order in the role switcher and docs: platform-wide first, then
# academic, then back-office, then operations, then the self-service portals.
# A person holding several roles lands on the first one they hold, so the order
# is "most of your day" rather than alphabetical.
ROLE_ORDER = [
    "seller_admin", "super_admin",
    "institution_admin", "board_member", "hod", "exam_controller", "faculty",
    "librarian", "transport_manager", "operations", "driver",
    "finance", "admissions", "front_office", "hr", "it_admin",
    "student", "parent",
]

# --- data scope --------------------------------------------------------------
# The CSV writes scope as prose with several near-synonyms. These collapse to
# the canonical scopes the backend can actually enforce.
SCOPE_MAP = {
    "All schools / all branches": "platform",
    "All institutions / all campuses": "platform",
    "All users": "platform",
    "Assigned school/branch": "institution",
    # The wording used by the rows added since this map was written. The
    # school, with the campus picker narrowing it — which is what
    # "institution" has always meant here.
    "Assigned institution/campus": "institution",
    "Assigned school/branch finance scope": "institution",
    "Assigned school/branch admissions scope": "institution",
    "Assigned school/branch employees": "institution",
    # The same scopes under the wording the sheet uses now: "branch" became
    # "campus" and "school" became "institution" when it was rewritten. Both
    # spellings are kept, because a sheet edited by hand carries whichever the
    # last person typed.
    "Assigned institution/campus finance scope": "institution",
    "Assigned institution/campus admissions scope": "institution",
    "Assigned institution/campus employees": "institution",
    "Assigned campus": "campus",
    "Only assigned operational module/campus": "campus",
    "Assigned branch": "campus",
    "Only assigned operational module/branch": "campus",
    "Assigned department only": "department",
    "Assigned classes/subjects": "assigned_classes",
    "Self + assigned classes/subjects": "assigned_classes",
    "Self only": "self",
    "Linked child/children only": "children",
}

# "Specific student" is ambiguous on its own: for the Student role it means the
# signed-in student, for the Parent role it means the currently selected child.
# Resolving it needs the role, which is why it is not in SCOPE_MAP.
AMBIGUOUS = {"Specific student"}
BY_ROLE_SCOPE = {"student": "self", "parent": "children"}


def slug(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[’'`]", "", s)
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def go_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def ts_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> int:
    rows = list(csv.DictReader(CSV.open(encoding="utf-8", newline="")))
    if not rows:
        print("no rows in CSV", file=sys.stderr)
        return 1

    roles = OrderedDict()  # role_key -> {name, sections: {sec_slug: {...}}}
    seen_keys = set()
    problems = []

    for r in rows:
        role_name = r["Role"].strip()
        role_key = ROLE_KEYS.get(role_name)
        if role_key is None:
            problems.append(f"unknown role: {role_name!r}")
            continue

        raw_scope = r["Data Scope"].strip()
        if raw_scope in AMBIGUOUS:
            scope = BY_ROLE_SCOPE.get(role_key)
            if scope is None:
                problems.append(f"{role_name}: ambiguous scope {raw_scope!r}")
                continue
        else:
            scope = SCOPE_MAP.get(raw_scope)
            if scope is None:
                problems.append(f"unmapped scope: {raw_scope!r}")
                continue

        section = r["Section"].strip()
        feature = r["Feature"].strip()
        sec_slug = slug(section)
        feat_slug = slug(feature)

        # role.section.feature is unique by construction and makes a grant
        # trivially role-scoped, which is what the catalog describes.
        key = f"{role_key}.{sec_slug}.{feat_slug}"
        if key in seen_keys:
            problems.append(f"duplicate feature key: {key}")
            continue
        seen_keys.add(key)

        role = roles.setdefault(role_key, {"name": role_name, "sections": OrderedDict()})
        workspace = (r.get("Workspace") or section).strip()
        sec = role["sections"].setdefault(
            sec_slug, {"name": section, "workspace": workspace, "features": []})
        sec["features"].append({
            "key": key,
            "slug": feat_slug,
            "name": feature,
            "summary": r["What User Sees & Does"].strip(),
            "scope": scope,
            "raw_scope": raw_scope,
            "tier": (r.get("Tier") or "core").strip(),
        })

    if problems:
        for p in problems:
            print("ERROR:", p, file=sys.stderr)
        return 1

    ordered = OrderedDict(
        (k, roles[k]) for k in ROLE_ORDER if k in roles
    )
    for k in roles:
        if k not in ordered:
            ordered[k] = roles[k]

    total = sum(len(s["features"]) for r in ordered.values() for s in r["sections"].values())
    write_go(ordered, total)
    write_ts(ordered, total)
    print(f"catalog: {len(ordered)} roles, "
          f"{sum(len(r['sections']) for r in ordered.values())} sections, "
          f"{total} features")
    return 0


GO_HEADER = '''// Code generated by scripts/gen_catalog.py from docs/edu_features.csv. DO NOT EDIT.

// Package catalog is the generated feature catalog: every role, the sections
// it sees, the features in each section, and the data scope each feature must
// be evaluated under.
//
// It is the single source of authorisation truth shared by the API (which
// gates handlers on feature keys) and the SPA (which builds navigation from
// the same data, generated into web/src/catalog.gen.ts).
package catalog

// Scope is the data boundary a feature operates within. The API resolves the
// caller's concrete scope once per request; see internal/scope.
type Scope string

const (
	// ScopePlatform spans every institution. Only super_admin holds these.
	ScopePlatform Scope = "platform"
	// ScopeInstitution is the tenant boundary already enforced by RLS.
	ScopeInstitution Scope = "institution"
	// ScopeCampus narrows to the campuses a user is posted to.
	ScopeCampus Scope = "campus"
	// ScopeDepartment narrows to the departments a user heads.
	ScopeDepartment Scope = "department"
	// ScopeAssignedClasses narrows to sections/subjects a teacher is timetabled for.
	ScopeAssignedClasses Scope = "assigned_classes"
	// ScopeSelf narrows to the signed-in user's own records.
	ScopeSelf Scope = "self"
	// ScopeChildren narrows to students a guardian is linked to.
	ScopeChildren Scope = "children"
)

// Tier decides how hard a feature works to earn a place in the sidebar.
//
// The catalog is deliberately deep — a school's fee office really does need
// structures, demand generation, concessions, refunds and reconciliation — and
// depth only becomes noise when every capability is presented as though it
// were a product of its own. Tier is how depth stays available without being
// in the way.
type Tier string

const (
	// TierCore is everyday work. Listed in navigation normally.
	TierCore Tier = "core"
	// TierAdvanced is real capability reached for occasionally. Kept behind a
	// disclosure inside its own group rather than given a permanent line.
	TierAdvanced Tier = "advanced"
	// TierOptional is niche, gimmick, or hardware- and board-specific. Still
	// catalogued, still routable, never in anyone's default navigation.
	TierOptional Tier = "optional"
)

// Feature is one row of the catalog.
type Feature struct {
	Key     string // role.section.feature — also the permission key
	Slug    string
	Name    string
	Summary string
	Scope   Scope
	Tier    Tier
}

// Section is a group of features inside a workspace.
//
// Workspace is the level a person navigates: role -> 6-9 workspaces -> groups
// -> features. It is carried on the section rather than modelled as its own
// type so that the feature key stays role.section.feature — renaming keys to
// insert a level would move every seeded grant and every saved link.
type Section struct {
	Slug      string
	Name      string
	Workspace string
	Features  []Feature
}

// Role is one persona's whole workspace.
type Role struct {
	Key      string
	Name     string
	Sections []Section
}

'''


def write_go(roles, total):
    out = [GO_HEADER]
    out.append(f"// Roles is the catalog: {len(roles)} roles, {total} features.\n")
    out.append("var Roles = []Role{\n")
    for rk, role in roles.items():
        out.append(f"\t{{\n\t\tKey:  {go_str(rk)},\n\t\tName: {go_str(role['name'])},\n")
        out.append("\t\tSections: []Section{\n")
        for ss, sec in role["sections"].items():
            out.append(
                f"\t\t\t{{\n\t\t\t\tSlug: {go_str(ss)},\n\t\t\t\tName: {go_str(sec['name'])},\n"
                f"\t\t\t\tWorkspace: {go_str(sec['workspace'])},\n")
            out.append("\t\t\t\tFeatures: []Feature{\n")
            for f in sec["features"]:
                out.append(
                    "\t\t\t\t\t{"
                    f"Key: {go_str(f['key'])}, Slug: {go_str(f['slug'])}, "
                    f"Name: {go_str(f['name'])}, Scope: Scope({go_str(f['scope'])}), "
                    f"Tier: Tier({go_str(f['tier'])}), "
                    f"Summary: {go_str(f['summary'])}"
                    "},\n"
                )
            out.append("\t\t\t\t},\n\t\t\t},\n")
        out.append("\t\t},\n\t},\n")
    out.append("}\n")

    out.append('''
// byKey indexes every feature for O(1) permission lookups.
var byKey = func() map[string]Feature {
	m := make(map[string]Feature)
	for _, r := range Roles {
		for _, s := range r.Sections {
			for _, f := range s.Features {
				m[f.Key] = f
			}
		}
	}
	return m
}()

// Lookup returns the feature for a permission key.
func Lookup(key string) (Feature, bool) {
	f, ok := byKey[key]
	return f, ok
}

// RoleByKey returns a role definition.
func RoleByKey(key string) (Role, bool) {
	for _, r := range Roles {
		if r.Key == key {
			return r, true
		}
	}
	return Role{}, false
}

// AllFeatures flattens the catalog, for seeding.
func AllFeatures() []Feature {
	out := make([]Feature, 0, len(byKey))
	for _, r := range Roles {
		for _, s := range r.Sections {
			out = append(out, s.Features...)
		}
	}
	return out
}
''')
    p = ROOT / "internal" / "catalog" / "catalog_gen.go"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(out), encoding="utf-8", newline="\n")


def write_ts(roles, total):
    out = ["// Code generated by scripts/gen_catalog.py from docs/edu_features.csv. DO NOT EDIT.\n\n"]
    out.append(
        "export type Scope =\n"
        "  | 'platform'\n  | 'institution'\n  | 'campus'\n  | 'department'\n"
        "  | 'assigned_classes'\n  | 'self'\n  | 'children'\n\n"
        "export type Tier = 'core' | 'advanced' | 'optional'\n\n"
        "export interface Feature {\n"
        "  key: string\n  slug: string\n  name: string\n  summary: string\n"
        "  scope: Scope\n  tier: Tier\n}\n\n"
        "export interface Section {\n  slug: string\n  name: string\n"
        "  workspace: string\n  features: Feature[]\n}\n\n"
        "export interface Role {\n  key: string\n  name: string\n  sections: Section[]\n}\n\n"
    )
    out.append(f"/** {len(roles)} roles, {total} features. */\n")
    out.append("export const ROLES: Role[] = [\n")
    for rk, role in roles.items():
        out.append(f"  {{\n    key: {ts_str(rk)},\n    name: {ts_str(role['name'])},\n    sections: [\n")
        for ss, sec in role["sections"].items():
            out.append(
                f"      {{\n        slug: {ts_str(ss)},\n        name: {ts_str(sec['name'])},\n"
                f"        workspace: {ts_str(sec['workspace'])},\n        features: [\n")
            for f in sec["features"]:
                out.append(
                    "          { "
                    f"key: {ts_str(f['key'])}, slug: {ts_str(f['slug'])}, "
                    f"name: {ts_str(f['name'])}, scope: {ts_str(f['scope'])}, "
                    f"tier: {ts_str(f['tier'])}, "
                    f"summary: {ts_str(f['summary'])}"
                    " },\n"
                )
            out.append("        ],\n      },\n")
        out.append("    ],\n  },\n")
    out.append("]\n\n")
    out.append('''export const ROLE_BY_KEY = new Map(ROLES.map((r) => [r.key, r]))

export const FEATURE_BY_KEY = new Map(
  ROLES.flatMap((r) => r.sections.flatMap((s) => s.features)).map((f) => [f.key, f]),
)
''')
    (ROOT / "web" / "src" / "catalog.gen.ts").write_text("".join(out), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    sys.exit(main())
