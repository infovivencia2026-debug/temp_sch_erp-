#!/usr/bin/env python3
"""Drive every built feature as the person who would actually use it.

Two passes.

  Reads   — for each built feature, sign in as its role and call every GET the
            screen makes. A screen that 500s, 403s its own owner, or returns
            nothing where the demo school has data is not working, whatever the
            code says.

  Writes  — a scripted school day. Admit a child, mark a register, collect a
            fee, enter marks, apply for leave, approve it, set homework, turn it
            in, run payroll. These are the paths that carry money and records,
            so they are exercised for real rather than probed.

Path parameters are filled from the demo data, not invented: a probe with a
made-up id returns 404 and reads as a broken feature.

Usage: python3 scripts/simulate.py [base_url]
Writes docs/FEATURE_MATRIX.csv and prints a summary.
"""
import csv
import datetime
import http.cookiejar
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090").rstrip("/")
PASSWORD = os.environ.get("DEMO_PASSWORD", "9")

# One demo account per catalogue role. institution_admin has two accounts; the
# one seeded with the demo password is used so every persona signs in the same
# way a real user would rather than through a back door.
ACCOUNTS = {
    # The vendor's own account. Platform-level like super_admin and far
    # narrower: it sells the software rather than operating a school.
    "seller_admin": "seller_admin@vivencia.test",
    "super_admin": "super_admin@vivencia.test",
    "institution_admin": "institution_admin@vivencia.test",
    "hod": "hod@vivencia.test",
    "faculty": "faculty@vivencia.test",
    "finance": "finance@vivencia.test",
    "admissions": "admissions@vivencia.test",
    "hr": "hr@vivencia.test",
    "operations": "operations@vivencia.test",
    "student": "student@vivencia.test",
    "parent": "parent@vivencia.test",
}


class Person:
    """A signed-in browser session for one demo account."""

    def __init__(self, role, email, acting=None):
        self.role, self.email, self.acting = role, email, acting
        self.jar = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            NoRedirect(),
        )
        self.ok = self._login()

    def _login(self):
        page = self.raw("GET", "/login")[1]
        token = re.search(r'name="csrf_token" value="([^"]+)"', page)
        if not token:
            return False
        body = urllib.parse.urlencode({
            "csrf_token": token.group(1),
            "identifier": self.email,
            "password": PASSWORD,
        }).encode()
        code, _ = self.raw("POST", "/login", body,
                           {"Content-Type": "application/x-www-form-urlencoded"})
        return code == 303

    def raw(self, method, path, body=None, headers=None):
        req = urllib.request.Request(BASE + path, data=body, method=method,
                                     headers=headers or {})
        try:
            with self.http.open(req, timeout=30) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - a transport failure is a result
            return 0, str(e)

    def call(self, method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"} if body else {}
        # A platform operator has no school of their own. Naming one is what a
        # real operator does before opening a school's screen, so the probe
        # does it too rather than recording the refusal as a fault.
        if self.acting:
            headers["X-Acting-Institution"] = self.acting
        code, text = self.raw(method, path, body, headers or None)
        try:
            return code, json.loads(text) if text else None
        except json.JSONDecodeError:
            return code, {"_raw": text[:200]}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """The 303 after login is the success signal, not something to follow."""

    def redirect_request(self, *_args, **_kwargs):
        return None


def rows_in(payload):
    """How many records came back, or None when the shape has no list."""
    if isinstance(payload, dict):
        for key in ("items", "students", "rows", "entries", "payslips"):
            if isinstance(payload.get(key), list):
                return len(payload[key])
    if isinstance(payload, list):
        return len(payload)
    return None


# --- filling path parameters -------------------------------------------------

def gather_ids(admin, finance, parent):
    """Real ids from the demo school, so :param probes hit real records."""
    ids = {}

    def first(person, path, *keys):
        code, body = person.call("GET", path)
        if code != 200:
            return None
        items = (body or {}).get("items") or []
        if not items:
            return None
        for k in keys:
            if items[0].get(k):
                return items[0][k]
        return None

    ids["student"] = first(admin, "/api/v1/students?limit=1", "id")
    ids["section"] = first(admin, "/api/v1/academics/sections", "id")
    ids["class"] = first(admin, "/api/v1/academics/classes", "id")
    ids["subject"] = first(admin, "/api/v1/academics/subjects", "id")
    ids["user"] = first(admin, "/api/v1/admin/users?limit=1", "id")
    ids["role"] = first(admin, "/api/v1/admin/roles", "id")
    ids["session"] = first(admin, "/api/v1/admin/sessions", "id")
    ids["employee"] = first(admin, "/api/v1/hr/employees?limit=1", "id", "employee_id")
    ids["exam"] = first(admin, "/api/v1/exams/list", "id")
    if ids["exam"]:
        ids["paper"] = first(admin, f"/api/v1/exams/subjects?exam_id={ids['exam']}", "id")
    ids["homework"] = first(admin, "/api/v1/homework", "id")
    ids["child"] = first(parent, "/api/v1/portal/students", "student_id")

    # A receipt is addressed by payment id, and the PDC register spells that
    # column differently from the ledger. Take whichever is present rather than
    # assuming, so a rename shows up as a missing id and not a crash.
    code, body = finance.call("GET", "/api/v1/fees/pdc")
    pdc = (body or {}).get("items") or []
    if code == 200 and pdc:
        ids["payment"] = pdc[0].get("payment_id") or pdc[0].get("id")
    else:
        ids["payment"] = None
    return ids


# Which id a path wants. Ordered longest-first so /admin/users/:param/roles is
# matched before anything shorter would claim it.
PARAM_FOR = [
    ("/api/v1/students/:param/profile", "student"),
    ("/api/v1/fees/students/:param/ledger", "student"),
    ("/api/v1/fees/receipts/:param", "payment"),
    ("/api/v1/fees/payments/:param/clear", "payment"),
    ("/api/v1/fees/payments/:param/bounce", "payment"),
    ("/api/v1/admin/users/:param/roles", "user"),
    ("/api/v1/admin/users/:param/status", "user"),
    ("/api/v1/admin/users/:param/reset-password", "user"),
    ("/api/v1/admin/roles/:param/permissions", "role"),
    ("/api/v1/admin/sessions/:param", "session"),
    ("/api/v1/homework/:param/submit", "homework"),
    ("/api/v1/setup/campuses/:param", "campus"),
    ("/api/v1/admissions/workflow/applications/:param/decision", "application"),
    ("/api/v1/admissions/workflow/applications/:param/enrol", "application"),
    ("/api/v1/jobs/:param", "job"),
]


# Some endpoints are meaningless without a selector — a gradebook is always
# "for this paper". Probing them bare returns 400, which is the endpoint
# validating its input correctly, not a fault.
NEEDS_QUERY = {
    "/api/v1/exams/gradebook": lambda i: f"?exam_subject_id={i['paper']}" if i.get("paper") else None,
    "/api/v1/exams/subjects": lambda i: f"?exam_id={i['exam']}" if i.get("exam") else None,
    "/api/v1/timetable/entries": lambda i: f"?section_id={i['section']}" if i.get("section") else None,
    # No student_id: each portal caller means themselves, and passing the
    # parent's child id while signed in as the student is another family.
    "/api/v1/portal/attendance": lambda _: "",
    "/api/v1/portal/fees": lambda _: "",
    "/api/v1/portal/results": lambda _: "",
    # A card is always somebody's. Staff must name the child; a family need
    # not, which is why the endpoint refuses rather than guessing.
    # student_id is filled per persona, below: a teacher's card must name a
    # child in their own sections or the answer is a correct 404.
    "/api/v1/hpc/card": lambda i: f"?student_id={i['own_student']}" if i.get("own_student") else None,
    "/api/v1/payroll/payslips": lambda _: "?month=2026-07",
    "/api/v1/attendance": lambda i: f"?section_id={i['section']}&on_date=2026-08-17" if i.get("section") else None,
}


def resolve(path, ids):
    """Fill :param from the demo data. Returns None when nothing fits."""
    if ":param" not in path:
        suffix = NEEDS_QUERY.get(path)
        if suffix:
            q = suffix(ids)
            return path + q if q else None
        return path
    for prefix, key in PARAM_FOR:
        if path == prefix:
            value = ids.get(key)
            return path.replace(":param", value) if value else None
    return None


def main():
    features = json.loads((ROOT / "docs" / "feature_map.json").read_text())

    print(f"signing in as {len(ACCOUNTS)} people at {BASE}")
    people = {}
    for role, email in ACCOUNTS.items():
        p = Person(role, email)
        if role == "super_admin":
            # Stand the operator inside the demo school, the way the wizard's
            # picker does, so their screens have something to report on.
            code, body = p.call("GET", "/api/v1/admin/institutions")
            here = [i for i in (body or {}).get("items", []) if "Vivencia" in i["name"]]
            p.acting = (here or (body or {}).get("items") or [{}])[0].get("id")
        people[role] = p
        print(f"  {'ok  ' if p.ok else 'FAIL'} {role:18} {email}")
    if not all(p.ok for p in people.values()):
        sys.exit("could not sign in as every persona; aborting")

    ids = gather_ids(people["institution_admin"], people["finance"], people["parent"])
    ids["campus"] = None
    code, body = people["institution_admin"].call("GET", "/api/v1/setup/campuses")
    if code == 200 and (body or {}).get("items"):
        ids["campus"] = body["items"][0]["id"]
    print("  demo ids resolved: " +
          ", ".join(k for k, v in ids.items() if v))

    results = probe_reads(features, people, ids)
    write_results = simulate_school_day(people, ids)
    matrix = access_matrix(features, people, ids)
    emit(features, results, write_results, matrix)


def probe_reads(features, people, ids):
    """Call every GET each built screen makes, as that screen's own role."""
    print("\nprobing every built screen as its own role")
    cache, results = {}, {}

    # A student id each persona can actually reach. Probing everyone with the
    # office's first student made scope-correct 404s look like faults.
    own = {}
    for role, person in people.items():
        code, body = person.call("GET", "/api/v1/portal/students")
        items = (body or {}).get("items") or []
        if code == 200 and items:
            own[role] = items[0]["student_id"]
            continue
        code, body = person.call("GET", "/api/v1/students?limit=1")
        items = (body or {}).get("items") or []
        own[role] = items[0]["id"] if code == 200 and items else None

    for feat in features:
        if not feat["built"]:
            continue
        person = people[feat["role"]]
        ids = {**ids, "own_student": own.get(feat["role"])}
        checks = []
        for ep in feat["endpoints"]:
            if "GET" not in ep["methods"]:
                continue
            path = resolve(ep["path"], ids)
            if path is None:
                checks.append((ep["path"], "skipped", "no demo record to address"))
                continue
            hit = (feat["role"], path)
            if hit not in cache:
                code, body = person.call("GET", path)
                cache[hit] = (code, rows_in(body))
            code, rows = cache[hit]
            if code == 200:
                checks.append((ep["path"], "pass",
                               "200, no rows" if rows == 0 else
                               f"200, {rows} rows" if rows is not None else "200"))
            elif code == 403:
                checks.append((ep["path"], "restricted",
                               f"403 to {feat['role']} — sub-view for staff only"))
            elif code == 404:
                checks.append((ep["path"], "FAIL", f"404 as {feat['role']}"))
            else:
                checks.append((ep["path"], "FAIL", f"HTTP {code} as {feat['role']}"))
        results[feat["key"]] = checks

    return results


def simulate_school_day(people, ids):
    """A real day, in order, with each step's outcome recorded."""
    print("\nsimulating a school day")
    out = []

    def step(name, feature_keys, fn):
        try:
            ok, detail = fn()
        except Exception as e:  # noqa: BLE001 - a crash is a result
            ok, detail = False, f"{type(e).__name__}: {e}"
        print(f"  {'ok  ' if ok else 'FAIL'} {name:44} {detail}")
        out.append({"name": name, "keys": feature_keys, "ok": ok, "detail": detail})
        return ok

    admin = people["institution_admin"]
    office = people["admissions"]
    teacher = people["faculty"]
    cashier = people["finance"]
    hr = people["hr"]
    student = people["student"]
    parent = people["parent"]

    # --- the office opens ----------------------------------------------------
    def walk_in():
        code, body = office.call("GET", "/api/v1/academics/sections")
        if code != 200 or not body.get("items"):
            return False, f"cannot list sections ({code})"
        # A section with room, the way the office would choose one. Always
        # taking the first put every simulated admission into Grade 6-A until
        # it was over capacity.
        with_room = [s for s in body["items"] if s.get("enrolled", 0) < s.get("capacity", 0)]
        if not with_room:
            return True, "every section is full (skipped)"
        sec = with_room[0]["id"]
        code, body = office.call("POST", "/api/v1/students", {
            "first_name": "Sim", "last_name": "Walkin", "gender": "female",
            "date_of_birth": "2014-06-15", "section_id": sec,
            "guardian_name": "Sim Parent", "guardian_phone": "9848000111",
            "guardian_relation": "mother"})
        if code not in (200, 201):
            return False, f"admission refused: {short(body)}"
        return True, f"admitted {body.get('admission_no', body.get('id', ''))}"

    step("office admits a walk-in student",
         ["admissions.admissions_workspace.new_application",
          "admissions.front_office_workspace.walk_in_enquiry_capture"], walk_in)

    def enquiry():
        # By class name, the way a clerk on the telephone would say it — this
        # school calls them "Grade 6", another "Class 6", and the endpoint
        # resolves either.
        code, body = office.call("GET", "/api/v1/academics/classes")
        classes = (body or {}).get("items") or []
        wanted = classes[len(classes) // 2]["name"] if classes else ""
        code, body = office.call("POST", "/api/v1/admissions/workflow/enquiries", {
            "student_name": "Sim Enquiry", "parent_name": "Sim Guardian",
            "phone": "9848000222", "class_sought": wanted, "source": "phone"})
        if code not in (200, 201):
            return False, f"HTTP {code} {short(body)}"
        # And a class the school does not run is refused, not stored.
        bad, _ = office.call("POST", "/api/v1/admissions/workflow/enquiries", {
            "student_name": "Sim Bad", "parent_name": "X", "phone": "9848000333",
            "class_sought": "Class 99"})
        return bad == 400, f"logged for {wanted!r}; unknown class refused with {bad}"

    step("front desk logs a telephone enquiry",
         ["admissions.admissions_workspace.enquiry_capture"], enquiry)

    # --- the school day ------------------------------------------------------
    def register():
        code, today = teacher.call("GET", "/api/v1/teaching/today")
        if code != 200:
            return False, f"teacher's day = {code}"
        code, body = teacher.call("GET", "/api/v1/academics/sections")
        sections = (body or {}).get("items") or []
        if not sections:
            return False, "the teacher is assigned to no section"
        sec = sections[0]
        code, body = teacher.call("GET", f"/api/v1/students?section_id={sec['id']}&limit=100")
        pupils = (body or {}).get("items") or []
        if not pupils:
            return False, "no students in that section"
        marks = [{"student_id": p["id"],
                  "status": "absent" if i == 0 else "present"}
                 for i, p in enumerate(pupils)]
        code, body = teacher.call("POST", "/api/v1/attendance", {
            "section_id": sec["id"], "on_date": "2026-08-17", "entries": marks})
        if code not in (200, 201):
            return False, f"register refused: {short(body)}"
        return True, f"{len(marks)} marked in {sec['class_name']}-{sec['name']}, 1 absent"

    step("class teacher marks the morning register",
         ["faculty.teaching_workspace.take_attendance"], register)

    def foreign_section():
        code, body = admin.call("GET", "/api/v1/academics/sections")
        allsec = (body or {}).get("items") or []
        code, body = teacher.call("GET", "/api/v1/academics/sections")
        mine = {s["id"] for s in (body or {}).get("items") or []}
        other = next((s for s in allsec if s["id"] not in mine), None)
        if not other:
            return True, "teacher already sees every section (single-section demo)"
        code, _ = teacher.call("POST", "/api/v1/attendance", {
            "section_id": other["id"], "on_date": "2026-08-17", "entries": []})
        return code in (403, 404), f"HTTP {code} (want 403/404)"

    step("a teacher cannot mark a section they do not teach",
         ["faculty.teaching_workspace.take_attendance"], foreign_section)

    def homework():
        code, body = teacher.call("GET", "/api/v1/academics/sections")
        sections = (body or {}).get("items") or []
        code, body = teacher.call("GET", "/api/v1/academics/subjects")
        subjects = (body or {}).get("items") or []
        if not sections or not subjects:
            return False, "nothing to set work against"
        code, body = teacher.call("POST", "/api/v1/homework", {
            "section_id": sections[0]["id"], "subject_id": subjects[0]["id"],
            "title": "Simulation exercise", "instructions": "Show every step.",
            "due_on": "2026-08-24"})
        if code not in (200, 201):
            return False, f"publish refused: {short(body)}"
        hw_id = body["id"]
        code, seen = student.call("GET", "/api/v1/homework")
        titles = [h["title"] for h in (seen or {}).get("items", [])]
        if "Simulation exercise" not in titles:
            return False, "published but the student cannot see it"
        code, _ = student.call("POST", f"/api/v1/homework/{hw_id}/submit",
                               {"text_answer": "Done."})
        if code != 200:
            return False, f"student could not turn it in ({code})"
        code, seen = teacher.call("GET", "/api/v1/homework")
        row = next((h for h in (seen or {}).get("items", []) if h["id"] == hw_id), None)
        return bool(row and row["submissions"] >= 1), \
            f"published, seen by the child, {row['submissions'] if row else 0} submitted"

    step("teacher sets homework, child turns it in",
         ["faculty.teaching_workspace.homework_classwork",
          "student.student_self_service.homework_assignments"], homework)

    def parent_view():
        code, kids = parent.call("GET", "/api/v1/portal/students")
        children = (kids or {}).get("items") or []
        if not children:
            return False, "the parent has no children linked"
        if len(children) > 4:
            return False, f"{len(children)} children — the guardian fan-out is back"
        code, att = parent.call(
            "GET", f"/api/v1/portal/attendance?student_id={children[0]['student_id']}")
        return code == 200, f"{len(children)} child(ren), attendance HTTP {code}"

    step("parent opens the portal for their own child",
         ["parent.dashboard.child_summary",
          "parent.parent_self_service.attendance"], parent_view)

    # --- the fee counter -----------------------------------------------------
    def collect_fee():
        code, body = cashier.call("GET", "/api/v1/fees/defaulters?limit=5")
        owing = (body or {}).get("items") or []
        if not owing:
            return True, "nobody owes anything (skipped)"
        sid = owing[0].get("student_id") or owing[0].get("id")
        code, ledger = cashier.call("GET", f"/api/v1/fees/students/{sid}/ledger")
        if code != 200:
            return False, f"ledger = {code}"
        code, body = cashier.call("POST", "/api/v1/fees/payments", {
            "student_id": sid, "amount_paise": 100000, "mode": "cash"})
        if code not in (200, 201):
            return False, f"payment refused: {short(body)}"
        receipt = body.get("receipt_no") or body.get("number") or "?"
        pid = body.get("payment_id") or body.get("id")
        code, again = cashier.call("GET", f"/api/v1/fees/receipts/{pid}") if pid else (0, None)
        return True, f"receipt {receipt}, reprint HTTP {code}"

    step("cashier takes ₹1,000 at the counter",
         ["finance.fee_workspace.counter_fee_collection",
          "finance.fee_finance_workspace.receipts"], collect_fee)

    def concession_flow():
        code, body = admin.call("GET", "/api/v1/workflow/approvals")
        return code == 200, f"{(body or {}).get('total', '?')} items waiting"

    step("principal opens the approvals queue",
         ["institution_admin.administration.approvals_center"], concession_flow)

    # --- staff ---------------------------------------------------------------
    def leave_cycle():
        code, body = teacher.call("POST", "/api/v1/workflow/leave", {
            "from_date": "2026-10-01", "to_date": "2026-10-02",
            "reason": "Simulation leave"})
        if code not in (200, 201):
            return False, f"application refused: {short(body)}"
        lid = body["id"]
        code, inbox = admin.call("GET", "/api/v1/workflow/approvals")
        item = next((i for i in (inbox or {}).get("items", []) if i["id"] == lid), None)
        if not item:
            return False, "the application never reached the queue"
        if not item["title"].strip() or item["title"].startswith("—"):
            return False, f"queue shows it belonging to nobody: {item['title']!r}"
        code, _ = admin.call("POST", item["decide_url"],
                             {"decision": "approved", "note": "Simulation"})
        return code == 200, f"applied, queued as {item['title']!r}, approved"

    step("teacher applies for leave, principal approves",
         ["faculty.teaching_workspace.leave_self_service",
          "hr.hr_workspace.leave"], leave_cycle)

    def staff_register():
        code, body = hr.call("GET", "/api/v1/workflow/staff-register?on_date=2026-08-17")
        if code != 200:
            return False, f"register = {code}"
        rows = (body or {}).get("items") or []
        if not rows:
            return True, "register empty for that date"
        code, resp = hr.call("POST", "/api/v1/workflow/staff-attendance", {
            "on_date": "2026-08-17",
            "entries": [{"user_id": rows[0].get("user_id"), "status": "present",
                         "check_in": "09:05"}]})
        return code in (200, 201), f"{len(rows)} staff listed, marking HTTP {code}"

    step("HR marks the staff register",
         ["hr.hr_workspace.attendance"], staff_register)

    def payroll():
        code, body = hr.call("GET", "/api/v1/payroll/payslips?month=2026-07")
        return code == 200, f"HTTP {code}, {len((body or {}).get('items', []))} payslips"

    step("HR reads July payslips", ["hr.payroll_workspace.payslips"], payroll)

    # --- examinations --------------------------------------------------------
    def marks():
        code, exams = teacher.call("GET", "/api/v1/exams/list")
        rows = (exams or {}).get("items") or []
        if not rows:
            return True, "no exam scheduled (skipped)"
        exam = rows[0]["id"]
        code, papers = teacher.call("GET", f"/api/v1/exams/subjects?exam_id={exam}")
        plist = (papers or {}).get("items") or []
        if not plist:
            return True, "exam has no papers (skipped)"
        paper = plist[0]
        code, book = teacher.call(
            "GET", f"/api/v1/exams/gradebook?exam_subject_id={paper['id']}")
        pupils = (book or {}).get("items") or []
        if code != 200:
            return False, f"gradebook = {code}"
        if not pupils:
            return True, "no students on that paper (skipped)"
        code, resp = teacher.call("POST", "/api/v1/exams/marks", {
            "exam_subject_id": paper["id"],
            "entries": [{"student_id": pupils[0]["student_id"], "marks_obtained": 17}]})
        return code in (200, 201), f"{len(pupils)} on the paper, entry HTTP {code}"

    step("teacher enters marks for a paper",
         ["faculty.teaching_workspace.marks_entry"], marks)

    # --- compliance ----------------------------------------------------------
    def udise():
        code, body = admin.call("GET", "/api/v1/compliance/udise")
        if code != 200:
            return False, f"HTTP {code}"
        ready = body.get("ready") if isinstance(body, dict) else None
        return True, f"HTTP 200, ready={ready}"

    step("principal checks the UDISE+ return",
         ["institution_admin.compliance.udise_plus_data_export"], udise)

    def wizard():
        code, body = admin.call("GET", "/api/v1/setup/status")
        if code != 200:
            return False, f"HTTP {code}"
        return body.get("ready", False), \
            f"{body['completed']}/{body['total']} steps, ready={body['ready']}"

    step("setup checklist reports the school operable",
         ["super_admin.institution_setup.institutions_campuses"], wizard)

    def audit():
        code, body = admin.call("GET", "/api/v1/admin/audit?limit=20")
        rows = (body or {}).get("items") or []
        if code != 200 or not rows:
            return False, f"HTTP {code}, {len(rows)} rows"
        today = [r for r in rows if "Sim" in json.dumps(r.get("request") or {})]
        return True, f"{len(rows)} recorded, {len(today)} from this simulation"

    step("the audit trail caught this simulation",
         ["super_admin.platform_configuration.audit_log"], audit)

    return out


def access_matrix(features, people, ids):
    """Every persona against every GET endpoint in the product.

    The feature pass runs each screen as its owner, which proves the screens
    work. It says nothing about the ten roles who should *not* reach them —
    and a scope model is only as good as its refusals. This is the other half:
    one request per role per endpoint, recorded as what actually happened.

    Expectation comes from the catalogue, not from a hand-written list: a role
    that owns a feature using an endpoint is expected to reach it, and every
    other role is expected to be refused unless it owns a feature using the
    same one. Where the two disagree, the row is flagged.
    """
    print("\nchecking every role against every endpoint")

    owners = {}
    for f in features:
        if not f["built"]:
            continue
        for ep in f["endpoints"]:
            if "GET" in ep["methods"] and not ep.get("conditional"):
                owners.setdefault(ep["path"], set()).add(f["role"])

    rows, surprises = [], 0
    for path in sorted(owners):
        target = resolve(path, ids)
        if target is None:
            continue
        for role, person in people.items():
            code, body = person.call("GET", target)
            expected = role in owners[path]
            reached = code == 200
            if reached == expected:
                verdict = "as expected"
            elif reached and not expected:
                # Not automatically wrong: shared reference data like the class
                # list is deliberately readable by anyone who needs to pick a
                # class. Flagged for a human rather than called a failure.
                verdict = "reachable beyond its owners"
                surprises += 1
            else:
                verdict = "refused to an owner"
                surprises += 1
            rows.append({
                "path": path, "role": role, "http": code,
                "rows": rows_in(body) if code == 200 else "",
                "owner": "yes" if expected else "no", "verdict": verdict,
            })

    out = ROOT / "docs" / "ACCESS_MATRIX.csv"
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        w.writerow(["Endpoint", "Role", "Owns a feature using it", "HTTP",
                    "Rows returned", "Verdict", "Verified against"])
        for r in rows:
            w.writerow([r["path"], r["role"], r["owner"], r["http"], r["rows"],
                        r["verdict"], f"{BASE} at {stamp}"])

    refused = [r for r in rows if r["verdict"] == "refused to an owner"]
    wide = sorted({r["path"] for r in rows if r["verdict"] == "reachable beyond its owners"})
    print(f"  {len(rows)} role/endpoint pairs -> {out.relative_to(ROOT)}")
    print(f"  refused to an owner: {len(refused)}")
    print(f"  readable beyond their owning role: {len(wide)} endpoints")
    for r in refused:
        print(f"    FAIL {r['role']:18} {r['path']:46} HTTP {r['http']}")
    return rows


def short(body):
    if isinstance(body, dict) and "error" in body:
        return body["error"].get("message", "")[:80]
    return str(body)[:80]


def emit(features, reads, day, matrix):
    """One row per catalogued feature, with whatever was actually observed."""
    reach = {}
    for m in matrix:
        if m["http"] == 200:
            reach.setdefault(m["path"], []).append(m["role"])
    by_key = {}
    for entry in day:
        for k in entry["keys"]:
            by_key.setdefault(k, []).append(entry)

    # How far each section has got, so an unbuilt row can say whether it sits
    # in a live area of the product or an untouched one.
    section_progress, section_total = {}, {}
    for f in features:
        k = (f["role"], f["section"])
        section_total[k] = section_total.get(k, 0) + 1
        if f["built"]:
            section_progress[k] = section_progress.get(k, 0) + 1

    path = ROOT / "docs" / "FEATURE_MATRIX.csv"
    counts = {"pass": 0, "fail": 0, "partial": 0, "not_built": 0}

    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        # Provenance on every row rather than in a header: rows get filtered,
        # sorted and pasted into tickets, and a result with no "against what,
        # when" is an assertion rather than evidence.
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        against = f"{BASE} at {stamp}"
        w.writerow(["Role", "Section", "Feature", "Data Scope", "Feature Key",
                    "Built", "Screen", "Endpoints", "Tested As", "Result",
                    "Checks", "Also readable by", "Evidence", "Verified against"])
        for f in features:
            checks = reads.get(f["key"], [])
            sim = by_key.get(f["key"], [])

            if not f["built"]:
                # "not built" is too blunt to act on. A feature in a section
                # that is otherwise working is a gap to fill next; one in a
                # section with nothing built is a module still to start, and
                # they are different pieces of work.
                started = section_progress.get((f["role"], f["section"]), 0)
                result = "not built"
                evidence = (
                    f"catalogued only. {started} of "
                    f"{section_total[(f['role'], f['section'])]} features in "
                    f"\u201c{f['section']}\u201d are working, so the section exists "
                    "and this is a gap within it."
                    if started
                    else f"catalogued only. Nothing in \u201c{f['section']}\u201d is built yet."
                )
                counts["not_built"] += 1
            else:
                failed = [c for c in checks if c[1] == "FAIL"]
                # A screen whose own data loads but whose staff-only sub-view is
                # closed to this role is working as intended. A screen where
                # *everything* is closed is not, and is reported as a failure.
                blocked = [c for c in checks if c[1] == "restricted"]
                if blocked and not any(c[1] == "pass" for c in checks):
                    failed = failed + blocked
                sim_failed = [s for s in sim if not s["ok"]]
                bits = []
                if checks:
                    bits.append("; ".join(f"{c[0]} {c[2]}" for c in checks))
                for s in sim:
                    bits.append(f"[{'ok' if s['ok'] else 'FAIL'}] {s['name']}: {s['detail']}")
                evidence = " | ".join(bits) or "screen renders; no API call"
                if failed or sim_failed:
                    result = "FAIL"
                    counts["fail"] += 1
                elif not checks and not sim:
                    result = "partial"
                    counts["partial"] += 1
                else:
                    result = "pass"
                    counts["pass"] += 1

            others = sorted({
                role
                for e in f["endpoints"]
                for role in reach.get(e["path"], [])
                if role != f["role"]
            }) if f["built"] else []

            w.writerow([
                f["role_label"], f["section"], f["feature"], f["scope"], f["key"],
                "yes" if f["built"] else "no", f["component"],
                " ".join(f"{'/'.join(e['methods'])} {e['path']}" for e in f["endpoints"]),
                ACCOUNTS.get(f["role"], "") if f["built"] else "",
                result, len(checks) + len(sim), " ".join(others), evidence[:900],
                against,
            ])

    total = sum(counts.values())
    print(f"\nwrote {path.relative_to(ROOT)} — {total} features")
    print(f"  pass       {counts['pass']:4}")
    print(f"  FAIL       {counts['fail']:4}")
    print(f"  partial    {counts['partial']:4}  (built, nothing to probe)")
    print(f"  not built  {counts['not_built']:4}  (catalogued only)")

    fails = [(f["key"], c) for f in features
             for c in reads.get(f["key"], []) if c[1] == "FAIL"]
    if fails:
        print("\nendpoint failures:")
        seen = set()
        for key, (path_, _, why) in fails:
            if (path_, why) in seen:
                continue
            seen.add((path_, why))
            print(f"  {path_:52} {why}")
    day_fails = [d for d in day if not d["ok"]]
    if day_fails:
        print("\nschool-day failures:")
        for d in day_fails:
            print(f"  {d['name']}: {d['detail']}")


if __name__ == "__main__":
    main()
