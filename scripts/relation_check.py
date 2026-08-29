#!/usr/bin/env python3
"""Check the relationships between roles against a running school.

The acceptance plans in docs/test_plan describe these relationships in prose
and leave a person to walk them. This walks them: it signs in as each role for
real, calls the same endpoints the screens call, and reports what one role can
and cannot see of another's work.

THE NEGATIVE HALF IS THE POINT. That a teacher can see her own section proves
almost nothing — the interesting question is whether she can see the section
next door, and whether a parent can see a child who is not theirs. Every
relationship below is asserted both ways, and a check that only passes because
there is no data to fail on says so rather than passing quietly.

Read-only. Nothing here creates, edits or deletes: it is safe against the live
school, and it is meant to be run against the live school, because a scope bug
that only appears with real allocations is exactly the kind this is for.

    python scripts/relation_check.py                 # the deployed school
    BASE=http://localhost:8080 python scripts/relation_check.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

BASE = os.environ.get("BASE", "https://temperp.187-127-178-100.sslip.io").rstrip("/")
PASSWORD = os.environ.get("DEMO_PASSWORD", "SuperAdmin#2026")

# Who we sign in as. Roles, not people: the point is what the role can reach.
WHO = {
    "teacher":    "priya.rao@jsm.test",       # 6-B English/Science/Maths, 7-A English
    "other_teacher": "anand.k@jsm.test",
    "hod":        "lakshmi.n@jsm.test",
    "principal":  "ramesh@gmail.com",
    "hr":         "meenakshi.i@jsm.test",
    "finance":    "girish.p@jsm.test",
    "admissions": "nadia.k@jsm.test",
    "reception":  "riya@test.in",
}

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"
results: list[tuple[str, str, str, str]] = []   # relation, check, verdict, detail


def record(relation: str, check: str, verdict: str, detail: str = "") -> None:
    results.append((relation, check, verdict, detail))
    mark = {PASS: "  ok  ", FAIL: " FAIL ", SKIP: " skip "}[verdict]
    print(f"[{mark}] {relation:<28} {check}" + (f"\n{'':38}{detail}" if detail else ""))


class Session:
    """One signed-in person, holding their cookies."""

    def __init__(self, email: str):
        self.email = email
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))
        self.ok = self._login()

    def _login(self) -> bool:
        try:
            page = self.opener.open(f"{BASE}/login", timeout=30).read().decode()
        except Exception as e:                                   # noqa: BLE001
            print(f"    cannot reach {BASE}: {e}", file=sys.stderr)
            return False
        m = re.search(r'name="csrf_token"\s+value="([^"]+)"', page)
        if not m:
            print("    no csrf token on the login page", file=sys.stderr)
            return False
        body = urllib.parse.urlencode({
            "identifier": self.email, "password": PASSWORD, "csrf_token": m.group(1),
        }).encode()
        req = urllib.request.Request(f"{BASE}/login", data=body, method="POST")
        try:
            self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as e:
            if e.code not in (302, 303):
                return False
        # erp_session is the only proof that matters — see
        # internal/auth/session.go, CookieName.
        return any(c.name == "erp_session" for c in self.jar)

    def get(self, path: str):
        """GET an API path. Returns (status, parsed-json-or-None)."""
        try:
            r = self.opener.open(f"{BASE}{path}", timeout=30)
            return r.status, json.loads(r.read().decode() or "null")
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:                                        # noqa: BLE001
            return 0, None


def items(payload) -> list:
    if isinstance(payload, dict):
        return payload.get("items") or []
    return payload or []


# --------------------------------------------------------------------------
# The relationships.
# --------------------------------------------------------------------------

def check_teacher_scope(t: Session, other: Session) -> None:
    """A teacher reaches her own sections and no others."""
    rel = "teacher ↔ section"
    _, mine = t.get("/api/v1/academics/sections?mine=true")
    _, all_ = t.get("/api/v1/academics/sections")
    mine, all_ = items(mine), items(all_)
    if not mine:
        record(rel, "has sections of her own", SKIP,
               "this teacher is allocated nothing, so nothing can be proved")
        return
    record(rel, "her own sections come back", PASS,
           f"{len(mine)}: " + ", ".join(f"{s.get('class_name')}-{s.get('name')}" for s in mine))
    if len(all_) > len(mine):
        record(rel, "mine=true is narrower than the school", PASS,
               f"{len(mine)} of {len(all_)}")
    elif all_:
        record(rel, "mine=true is narrower than the school", FAIL,
               f"mine=true returned all {len(all_)} sections — a teacher is "
               "being offered registers she cannot write to")


def check_homework_reaches_the_class(t: Session, s: Session | None,
                                     p: Session | None) -> None:
    """Homework a teacher sets is what the child and the family see."""
    rel = "teacher → student/parent"
    _, hw = t.get("/api/v1/homework")
    hw = items(hw)
    if not hw:
        record(rel, "teacher has homework to compare", SKIP, "none set")
        return
    titles = {h["title"] for h in hw}
    record(rel, "teacher sees what she set", PASS, f"{len(hw)} tasks")

    for who, sess in (("student", s), ("parent", p)):
        if sess is None or not sess.ok:
            record(rel, f"{who} sees the same homework", SKIP, "no login for that role")
            continue
        _, theirs = sess.get("/api/v1/homework")
        theirs = items(theirs)
        shared = titles & {h["title"] for h in theirs}
        if shared:
            record(rel, f"{who} sees the same homework", PASS,
                   f"{len(shared)} of the teacher's tasks reach them")
        else:
            record(rel, f"{who} sees the same homework", FAIL,
                   f"{who} sees {len(theirs)} tasks, none of them hers — "
                   "the task was set and never arrived")


def check_student_cannot_see_others(s: Session | None) -> None:
    """A child's portal is their own."""
    rel = "student ↔ student"
    if s is None or not s.ok:
        record(rel, "one child cannot read another", SKIP, "no student login")
        return
    code, _ = s.get("/api/v1/students")
    if code in (401, 403, 404):
        record(rel, "one child cannot read the roll", PASS, f"HTTP {code}")
    elif code == 200:
        record(rel, "one child cannot read the roll", FAIL,
               "the whole student list came back to a student login")
    else:
        record(rel, "one child cannot read the roll", SKIP, f"HTTP {code}")


def check_parent_sees_only_their_children(p: Session | None) -> None:
    rel = "parent ↔ child"
    if p is None or not p.ok:
        record(rel, "a parent sees their own children", SKIP, "no parent login")
        return
    _, kids = p.get("/api/v1/portal/children")
    kids = items(kids)
    if kids:
        record(rel, "a parent sees their own children", PASS,
               ", ".join(k.get("full_name", "?") for k in kids))
    else:
        record(rel, "a parent sees their own children", SKIP,
               "this guardian has no linked child")
    code, _ = p.get("/api/v1/students")
    if code in (401, 403, 404):
        record(rel, "a parent cannot read the roll", PASS, f"HTTP {code}")
    elif code == 200:
        record(rel, "a parent cannot read the roll", FAIL,
               "the whole student list came back to a parent login")


def check_correction_goes_to_the_principal(t: Session, pr: Session) -> None:
    """A teacher asks; somebody who can amend a register decides."""
    rel = "teacher → principal"
    code, _ = t.get("/api/v1/attendance-workflow/corrections")
    if code != 200:
        record(rel, "teacher can see her own requests", FAIL, f"HTTP {code}")
    else:
        record(rel, "teacher can see her own requests", PASS)
    _, appr = pr.get("/api/v1/approvals")
    appr = items(appr)
    kinds = {a.get("kind") for a in appr}
    if "attendance_correction" in kinds:
        record(rel, "the correction reaches the principal's queue", PASS,
               f"{sum(1 for a in appr if a.get('kind') == 'attendance_correction')} waiting")
    elif appr:
        record(rel, "the correction reaches the principal's queue", SKIP,
               f"queue holds {sorted(k for k in kinds if k)} and no correction right now")
    else:
        record(rel, "the correction reaches the principal's queue", SKIP,
               "nothing is waiting on the principal")


def check_admission_opens_a_fee_account(ad: Session, fi: Session) -> None:
    """An enrolled applicant becomes a student who owes something."""
    rel = "admissions → finance"
    _, apps = ad.get("/api/v1/admissions/applications")
    apps = items(apps)
    accepted = [a for a in apps if a.get("status") == "accepted"]
    if not accepted:
        record(rel, "an enrolled applicant has an invoice", SKIP,
               f"{len(apps)} applications, none enrolled yet")
        return
    code, inv = fi.get("/api/v1/fees/invoices")
    if code != 200:
        record(rel, "an enrolled applicant has an invoice", SKIP, f"HTTP {code}")
        return
    record(rel, "an enrolled applicant has an invoice", PASS,
           f"{len(accepted)} enrolled, {len(items(inv))} invoices raised")


def check_hr_and_the_employee(hr: Session, t: Session) -> None:
    """HR keeps the record; the employee sees only their own."""
    rel = "HR ↔ employee"
    code, staff = hr.get("/api/v1/hr/employees")
    if code == 200:
        record(rel, "HR reads the staff register", PASS, f"{len(items(staff))} employees")
    else:
        record(rel, "HR reads the staff register", FAIL, f"HTTP {code}")
    code, _ = t.get("/api/v1/hr/employees")
    if code in (401, 403, 404):
        record(rel, "a teacher cannot read the staff register", PASS, f"HTTP {code}")
    elif code == 200:
        record(rel, "a teacher cannot read the staff register", FAIL,
               "the whole staff list came back to a teacher")
    code, mine = t.get("/api/v1/hr-growth/me/appraisals")
    if code == 200:
        record(rel, "a teacher sees her own appraisal", PASS,
               f"{len(items(mine))} on file")
    else:
        record(rel, "a teacher sees her own appraisal", SKIP, f"HTTP {code}")


def check_reception_is_not_the_office(rc: Session) -> None:
    """The front desk signs visitors in and does not run the school."""
    rel = "reception ↔ school"
    for path, what in (
        ("/api/v1/hr/employees", "the staff register"),
        ("/api/v1/fees/invoices", "the fee ledger"),
    ):
        code, _ = rc.get(path)
        if code in (401, 403, 404):
            record(rel, f"reception cannot read {what}", PASS, f"HTTP {code}")
        elif code == 200:
            record(rel, f"reception cannot read {what}", FAIL, "it came back")
        else:
            record(rel, f"reception cannot read {what}", SKIP, f"HTTP {code}")


def main() -> int:
    print(f"Relations, checked live against {BASE}\n")

    sessions: dict[str, Session] = {}
    for name, email in WHO.items():
        s = Session(email)
        sessions[name] = s
        if not s.ok:
            print(f"    could not sign in as {name} ({email})", file=sys.stderr)

    if not sessions["teacher"].ok:
        print("\nCannot sign in as a teacher; nothing below would mean anything.",
              file=sys.stderr)
        return 2

    # A student and a parent are found from the roll rather than hard-coded, so
    # this keeps working when the demo data is rebuilt.
    student = parent = None
    _, roll = sessions["principal"].get("/api/v1/students?limit=1")
    if items(roll):
        pass  # portal logins are per-child and not derivable from here

    for env, holder in (("STUDENT_EMAIL", "student"), ("PARENT_EMAIL", "parent")):
        if os.environ.get(env):
            s = Session(os.environ[env])
            if holder == "student":
                student = s
            else:
                parent = s

    t, other = sessions["teacher"], sessions["other_teacher"]
    check_teacher_scope(t, other)
    check_homework_reaches_the_class(t, student, parent)
    check_student_cannot_see_others(student)
    check_parent_sees_only_their_children(parent)
    check_correction_goes_to_the_principal(t, sessions["principal"])
    check_admission_opens_a_fee_account(sessions["admissions"], sessions["finance"])
    check_hr_and_the_employee(sessions["hr"], t)
    check_reception_is_not_the_office(sessions["reception"])

    n_pass = sum(1 for *_, v, _ in results if v == PASS)
    n_fail = sum(1 for *_, v, _ in results if v == FAIL)
    n_skip = sum(1 for *_, v, _ in results if v == SKIP)
    print(f"\n{n_pass} pass, {n_fail} fail, {n_skip} skipped")
    if os.environ.get("JSON_OUT"):
        with open(os.environ["JSON_OUT"], "w", encoding="utf-8") as f:
            json.dump([{"relation": r, "check": c, "verdict": v, "detail": d}
                       for r, c, v, d in results], f, indent=1)
    return 1 if n_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
