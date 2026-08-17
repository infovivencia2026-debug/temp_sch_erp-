#!/usr/bin/env python3
"""Generate docs/FEATURES.md — one documented entry per catalog feature.

Every one of the 419 features gets a row carrying its permission key, data
scope, status and (where built) the endpoints behind it. Written from the same
CSV and registry the code is generated from, so the documentation cannot drift
from what actually ships.
"""

import csv
import pathlib
import re
import sys
from collections import OrderedDict

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from gen_catalog import ROLE_KEYS, ROLE_ORDER, SCOPE_MAP, AMBIGUOUS, BY_ROLE_SCOPE, slug  # noqa: E402

CSV_PATH = ROOT / "docs" / "edu_features.csv"
REGISTRY = ROOT / "web" / "src" / "features" / "registry.ts"
OUT = ROOT / "docs" / "FEATURES.md"

SCOPE_DOC = {
    "platform": ("Platform", "Every institution. Requires `app.is_platform_admin`."),
    "institution": ("Institution", "The caller's tenant. Enforced by Postgres RLS."),
    "campus": ("Campus", "Campuses named on the user's role assignments."),
    "department": ("Department", "Departments where `departments.head_user_id` is the caller."),
    "assigned_classes": ("Assigned classes", "Sections the caller teaches or is class teacher of."),
    "self": ("Self", "The caller's own student record."),
    "children": ("Linked children", "Students the caller is a guardian of."),
}

# Endpoints backing each implemented feature. Hand-maintained because the
# mapping is a design fact, not something derivable from the router.
ENDPOINTS = {
    "super_admin.access_security.users": ["GET /api/v1/admin/users", "PUT /api/v1/admin/users/{id}/status"],
    "super_admin.platform_setup.user_directory_provisioning": ["GET /api/v1/admin/users"],
    "super_admin.access_security.roles_permissions": ["GET /api/v1/admin/roles", "GET /api/v1/admin/roles/{id}/permissions"],
    "super_admin.platform_setup.role_permission_matrix": ["GET /api/v1/admin/roles"],
    "super_admin.platform_configuration.module_configuration": ["GET /api/v1/admin/modules", "PUT /api/v1/admin/modules"],
    "super_admin.access_security.login_session_audit": ["GET /api/v1/admin/sessions", "DELETE /api/v1/admin/sessions/{id}"],
    "super_admin.platform_setup.login_session_audit_logs": ["GET /api/v1/admin/sessions", "DELETE /api/v1/admin/sessions/{id}"],
    "institution_admin.dashboard.executive_kpis": ["GET /api/v1/principal/dashboard"],
    "institution_admin.dashboard.campus_kpi_overview": ["GET /api/v1/principal/dashboard"],
    "institution_admin.dashboard.needs_attention": ["GET /api/v1/principal/dashboard"],
    "institution_admin.dashboard.needs_attention_widget": ["GET /api/v1/principal/dashboard"],
    "institution_admin.academic_monitoring.attendance_monitoring": ["GET /api/v1/principal/attendance-trend", "GET /api/v1/principal/attendance-shortage"],
    "institution_admin.reports.comprehensive_attendance_report": ["GET /api/v1/principal/attendance-trend"],
    "institution_admin.administration.staff_allocation_workload": ["GET /api/v1/principal/staff-workload"],
    "institution_admin.administration.staff_overview": ["GET /api/v1/principal/staff-workload"],
    "institution_admin.students_admissions.student_directory_student_360": ["GET /api/v1/students", "GET /api/v1/students/{id}"],
    "institution_admin.academics.academic_structure": ["GET /api/v1/academics/{years,classes,sections,subjects}"],
    "institution_admin.academics.timetable": ["GET /api/v1/timetable/{entries,periods,teachers}"],
    "hod.dashboard.department_kpis": ["GET /api/v1/department/dashboard"],
    "hod.department_workspace.faculty_directory": ["GET /api/v1/department/faculty"],
    "hod.department_workspace.faculty_allocation_workload": ["GET /api/v1/department/faculty"],
    "faculty.dashboard.todays_classes": ["GET /api/v1/teaching/today"],
    "faculty.teaching_workspace.my_classes": ["GET /api/v1/teaching/classes"],
    "faculty.teaching_workspace.take_attendance": ["GET /api/v1/attendance", "POST /api/v1/attendance"],
    "faculty.teaching_workspace.period_wise_student_attendance": ["GET /api/v1/attendance", "POST /api/v1/attendance"],
    "faculty.teaching_workspace.my_timetable": ["GET /api/v1/timetable/entries"],
    "faculty.teaching_workspace.daily_timetable_view": ["GET /api/v1/timetable/entries"],
    "finance.dashboard.finance_kpis": ["GET /api/v1/finance/dashboard"],
    "finance.dashboard.needs_attention": ["GET /api/v1/finance/dashboard"],
    "finance.fee_workspace.defaulter_tracking_aging": ["GET /api/v1/finance/invoices?overdue=true"],
    "finance.fee_finance_workspace.defaulters_reminders": ["GET /api/v1/finance/invoices?overdue=true"],
    "admissions.dashboard.admissions_kpis": ["GET /api/v1/admissions/dashboard"],
    "admissions.dashboard.follow_ups": ["GET /api/v1/admissions/enquiries"],
    "admissions.admissions_workspace.enquiries_leads": ["GET /api/v1/admissions/enquiries"],
    "hr.dashboard.hr_kpis": ["GET /api/v1/hr/dashboard"],
    "hr.hr_workspace.employee_master": ["GET /api/v1/hr/employees"],
    "hr.hr_workspace.employee_master_directory": ["GET /api/v1/hr/employees"],
    "operations.specialist_workspace.role_specific_home": ["GET /api/v1/operations/dashboard"],
    "operations.specialist_workspace.library_role": ["GET /api/v1/operations/library/loans"],
    "operations.specialist_workspace.transport_role": ["GET /api/v1/operations/transport/vehicles"],
    "operations.library_management.book_issue_return_terminal": ["GET /api/v1/operations/library/loans"],
    "operations.transport_management.vehicle_master_registry": ["GET /api/v1/operations/transport/vehicles"],
    "student.dashboard.my_day": ["GET /api/v1/portal/summary"],
    "student.dashboard.action_reminders": ["GET /api/v1/portal/summary"],
    "student.student_self_service.attendance": ["GET /api/v1/portal/attendance"],
    "student.student_portal.student_personalized_dashboard": ["GET /api/v1/portal/summary"],
    "student.student_self_service.timetable": ["GET /api/v1/timetable/entries"],
    "student.student_self_service.profile": ["GET /api/v1/profile", "PUT /api/v1/profile"],
    "parent.dashboard.child_switcher": ["GET /api/v1/portal/students"],
    "parent.dashboard.child_summary": ["GET /api/v1/portal/summary?student_id="],
    "parent.dashboard.needs_attention": ["GET /api/v1/portal/summary"],
    "parent.parent_self_service.attendance": ["GET /api/v1/portal/attendance"],
    "parent.parent_mobile_app.child_attendance_calendar": ["GET /api/v1/portal/attendance"],
    "parent.parent_mobile_app.multi_child_single_login_switch": ["GET /api/v1/portal/students"],
}


def implemented_keys():
    src = REGISTRY.read_text()
    body = src[src.index("FEATURE_COMPONENTS"):]
    return set(re.findall(r"^\s*'([a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+)':", body, re.M))


def main() -> int:
    built = implemented_keys()
    rows = list(csv.DictReader(CSV_PATH.open()))

    roles = OrderedDict()
    for r in rows:
        rk = ROLE_KEYS[r["Role"].strip()]
        raw = r["Data Scope"].strip()
        scope = BY_ROLE_SCOPE[rk] if raw in AMBIGUOUS else SCOPE_MAP[raw]
        section = r["Section"].strip()
        feature = r["Feature"].strip()
        key = f"{rk}.{slug(section)}.{slug(feature)}"
        roles.setdefault(rk, {"name": r["Role"].strip(), "sections": OrderedDict()})
        roles[rk]["sections"].setdefault(section, []).append({
            "key": key, "name": feature, "scope": scope,
            "summary": r["What User Sees & Does"].strip(),
            "built": key in built,
        })

    ordered = OrderedDict((k, roles[k]) for k in ROLE_ORDER if k in roles)
    total = sum(len(f) for r in ordered.values() for f in r["sections"].values())
    nbuilt = sum(1 for r in ordered.values() for fs in r["sections"].values()
                 for f in fs if f["built"])

    out = []
    w = out.append
    w("# Feature reference\n\n")
    w(f"Every feature in the catalog: **{total} features** across **{len(ordered)} roles** "
      f"and **{sum(len(r['sections']) for r in ordered.values())} sections**. "
      f"**{nbuilt}** have a working screen and endpoint; the rest are registered with their "
      "permission and data scope, navigable, and render an explicit "
      "\"catalogued, not implemented\" page.\n\n")
    w("Generated by `scripts/gen_docs.py` from [edu_features.csv](edu_features.csv) and the SPA's "
      "component registry. Do not edit by hand — run `make docs`.\n\n")

    w("## How to read this\n\n")
    w("| Column | Meaning |\n|---|---|\n")
    w("| **Feature** | The screen, as named in the source catalog. |\n")
    w("| **Permission key** | Row in `permissions`, granted through `role_permissions`. "
      "The API gates on it and the SPA builds navigation from it. |\n")
    w("| **Scope** | The data boundary. See below. |\n")
    w("| **Status** | ✅ built · ○ catalogued |\n")
    w("| **API** | Endpoints behind a built feature. |\n\n")

    w("## Data scopes\n\n")
    w("| Scope | Boundary | Enforced by |\n|---|---|---|\n")
    for _, (label, desc) in SCOPE_DOC.items():
        by = ("Postgres RLS" if label in ("Platform", "Institution")
              else "`internal/scope` + explicit SQL predicate")
        w(f"| **{label}** | {desc} | {by} |\n")
    w("\nRLS covers only the tenant boundary. The four narrower scopes are enforced in the "
      "application, because every row involved belongs to the same institution and the "
      "`tenant_isolation` policy admits all of them. A handler that forgets its scope filter "
      "leaks data *within* a tenant — which is why `internal/scope` returns `FALSE` for an "
      "empty set rather than omitting the clause.\n\n")

    w("## Roles at a glance\n\n")
    w("| Role | Key | Sections | Features | Built | Demo login |\n|---|---|---:|---:|---:|---|\n")
    for rk, role in ordered.items():
        n = sum(len(f) for f in role["sections"].values())
        b = sum(1 for fs in role["sections"].values() for f in fs if f["built"])
        w(f"| {role['name']} | `{rk}` | {len(role['sections'])} | {n} | {b} | "
          f"`{rk}@vivencia.test` |\n")
    w("\n")

    for rk, role in ordered.items():
        n = sum(len(f) for f in role["sections"].values())
        b = sum(1 for fs in role["sections"].values() for f in fs if f["built"])
        w(f"---\n\n## {role['name']}\n\n")
        w(f"`{rk}` · {n} features · {b} built · sign in as `{rk}@vivencia.test`\n\n")

        for section, feats in role["sections"].items():
            w(f"### {section}\n\n")
            w("| Feature | What the user does | Permission key | Scope | Status | API |\n")
            w("|---|---|---|---|:--:|---|\n")
            for f in feats:
                api = "<br>".join(f"`{e}`" for e in ENDPOINTS.get(f["key"], [])) or "—"
                summary = f["summary"].replace("|", "\\|")
                w(f"| **{f['name']}** | {summary} | `{f['key']}` | {f['scope']} | "
                  f"{'✅' if f['built'] else '○'} | {api} |\n")
            w("\n")

    OUT.write_text("".join(out))
    print(f"docs: {total} features documented, {nbuilt} built → {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
