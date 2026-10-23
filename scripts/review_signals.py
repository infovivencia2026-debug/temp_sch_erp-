# -*- coding: utf-8 -*-
"""Every cross-role signal the product sends, read out of the Worker.

The hand-written chains cover the big journeys. They cannot cover four hundred
features, and the owner is right that the interesting half is the rest: a
status posted, a concern answered, an exam date moved, a book overdue. Each of
those is a row somewhere that makes a bell ring in somebody else's account.

Rather than invent that list, it is read. Every place the Worker writes a
notification is a relation with three facts already in the source: what kind of
thing happened, what the person is told, and which screen the notification
opens. That is exactly "press here, check there", and it is true by
construction because it comes from the code that does it.
"""
import io, os, re, glob

ROOT = r"C:\Users\sony\AppData\Local\Temp\claude\c--Users-sony-projects-temp-sch-erp-\9039b9d2-69ae-4db2-8919-6e5d1f9d7553\scratchpad\wt-cf"
SRC = os.path.join(ROOT, 'worker', 'src')

# A readable name for the area a file belongs to.
AREA = {
    'comms': 'Communication', 'fees': 'Fees', 'exams': 'Examinations', 'hr': 'HR & staff',
    'portal': 'Family portal', 'ops': 'Operations', 'academics': 'Academics',
    'admissions': 'Admissions', 'scheduling': 'Transport & timetable', 'help': 'Help desk',
    'teaching': 'Teaching', 'growth': 'Growth', 'admin': 'Administration',
    'payroll': 'Payroll', 'daily': 'Daily digest', 'misc': 'Other', 'board_exams': 'Board exams',
}

# Where a /go/ link lands, in words a reviewer can act on.
WHERE = {
    'my_profile/my_pay': 'that person > My profile > My pay',
    'approvals/approvals': 'the approver > Approvals',
    'attendance/take_attendance': 'the teacher > Take attendance',
    'fees_payments': 'the parent > Fees & payments',
    'fee_receipts': 'the parent > Receipts',
    'fee_counter': 'finance > Take fee payment',
    'homework': 'the student/parent > Homework',
    'leave/leave': 'HR > Leave',
    'my_profile/leave_self_service': 'that person > My profile > Leave',
    'help/helpdesk': 'the help desk',
    'messages?box=parents': 'the teacher > Messages > Parents',
    'messages?box=staff': 'the colleague > Messages > Colleagues',
    'certificates_transfers': 'the office > Certificates & transfers',
    'enquiries/enquiries': 'admissions > Enquiries',
    'assignments_submissions': 'the teacher > Assignments',
    'courses_subjects': 'the student > Courses',
    'exams/question_papers': 'the teacher > Question papers',
    'concessions': 'finance > Concessions',
}


def files():
    for pat in ('*.ts', '*/*.ts', '*/*/*.ts'):
        for f in glob.glob(os.path.join(SRC, 'routes', pat)):
            yield f


def area_of(path):
    rel = os.path.relpath(path, os.path.join(SRC, 'routes')).replace('\\', '/')
    head = rel.split('/')[0].replace('.ts', '')
    return AREA.get(head, head.replace('_', ' ').title())


def nice(kind):
    return kind.replace('_', ' ')


def split_top(s):
    """Split a SQL tuple on commas that are not inside quotes or brackets."""
    out, buf, depth, q = [], '', 0, ''
    for ch in s:
        if q:
            buf += ch
            if ch == q:
                q = ''
            continue
        if ch in "'\"":
            q = ch
            buf += ch
        elif ch in '([':
            depth += 1
            buf += ch
        elif ch in ')]':
            depth -= 1
            buf += ch
        elif ch == ',' and depth == 0:
            out.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


def collect():
    """One row per notification kind: what happened, and which screen it opens.

    Parsed from the statement itself rather than by scanning for any quoted
    word nearby -- the first attempt did that and reported 'pending', 'active'
    and 'all' as kinds of notification, which is noise presented as fact. The
    column list and the VALUES tuple are lined up, and only the literals
    actually sitting in the kind and link positions are read.
    """
    seen = {}
    pat = re.compile(
        r"INSERT INTO notifications\s*\(([^)]*)\)\s*(?:\n|\s)*VALUES\s*\(([^)]*)\)", re.S)
    for path in files():
        txt = io.open(path, encoding='utf-8').read()
        if 'INSERT INTO notifications' not in txt:
            continue
        area = area_of(path)
        for m in pat.finditer(txt):
            cols = [c.strip().strip('"') for c in split_top(m.group(1))]
            vals = split_top(m.group(2))
            if len(cols) != len(vals):
                continue
            row = dict(zip(cols, vals))

            def lit(name):
                v = row.get(name, '')
                mm = re.match(r"^'(.*)'$", v.strip(), re.S)
                return mm.group(1) if mm else ''

            kind = lit('kind')
            if not kind:
                continue
            link = lit('link')
            land = ''
            if link.startswith('/go/'):
                base = link[4:].split('?')[0].rstrip('/')
                for probe, words in WHERE.items():
                    if base.startswith(probe.split('?')[0]):
                        land = words
                        break
                if not land:
                    land = 'the screen at ' + link
            key = (area, kind)
            if key in seen and seen[key][2]:
                continue
            seen[key] = (area, kind, land, os.path.relpath(path, SRC).replace('\\', '/'))
    return sorted(seen.values())


def call_sites():
    """The notifications sent through the shared helpers.

    Most of them are: only five places write the INSERT by hand, and the rest
    go through notifyStmt / notify / notifyMany / notifySchool / notifyAudience.
    The arguments carry what a reviewer needs anyway -- a kind, the sentence the
    person is actually shown, and often the screen it opens -- so the call site
    is read rather than the table.
    """
    helpers = ('notifyStmt', 'notifyMany', 'notifySchool', 'notifyAudience', 'notify')
    pat = re.compile(r"\b(" + '|'.join(helpers) + r")\(", re.S)
    out = {}
    for path in files():
        txt = io.open(path, encoding='utf-8').read()
        area = area_of(path)
        for m in pat.finditer(txt):
            # the call's own parentheses, so a nested call does not end it early
            i, depth = m.end() - 1, 0
            while i < len(txt) and i < m.end() + 1200:
                if txt[i] == '(':
                    depth += 1
                elif txt[i] == ')':
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            call = txt[m.end():i]
            lits = [s for s in re.findall(r"'((?:[^'\\]|\\.){0,120})'", call)]
            kind = next((s for s in lits if re.fullmatch(r"[a-z][a-z0-9_.]{2,40}", s)
                         and not s.startswith('/go')), '')
            title = next((s for s in lits if ' ' in s and not s.startswith('/go')), '')
            link = next((s for s in lits if s.startswith('/go/')), '')
            if not kind and not title:
                continue
            land = ''
            if link:
                base = link[4:].split('?')[0].rstrip('/')
                for probe, words in WHERE.items():
                    if base.startswith(probe.split('?')[0]):
                        land = words
                        break
                if not land:
                    land = 'the screen at ' + link
            key = (area, kind or title[:28])
            if key in out and out[key][2]:
                continue
            out[key] = (area, kind or '(no kind)', land, os.path.relpath(path, SRC).replace('\\', '/'), title)
    return out


def clean_title(t):
    """A title, or nothing. Never half of one.

    These come out of template literals, so a fragment like " paid" or ";" is
    the tail of a sentence the code builds at run time. A fragment in a review
    sheet is worse than a blank: it reads as the message and is not.
    """
    t = (t or '').strip()
    if len(t) < 10 or not re.match(r"^[A-Z]", t):
        return ''
    return t


def merged():
    rows = {}
    for area, kind, land, f in collect():
        rows[(area, kind)] = (area, kind, land, f, '')
    for key, v in call_sites().items():
        if key not in rows or not rows[key][2]:
            rows[key] = v
    return sorted((a, k, land, f, clean_title(t)) for a, k, land, f, t in rows.values())


SIGNALS = merged()

if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    print('signals found:', len(SIGNALS))
    for a, k, land, f in SIGNALS[:25]:
        print('  %-22s %-34s -> %s' % (a, k, land or '(link not named in this file)'))
