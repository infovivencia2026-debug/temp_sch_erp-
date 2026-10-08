# -*- coding: utf-8 -*-
"""Does every chain row name a role that really has that screen?

The owner found "Staff attendance register" credited to a HOD, who does not
have it -- their "Take attendance" is the children. A sheet that sends a tester
to a screen their login does not carry wastes their morning and makes them
doubt the rest of it, so the rows are checked against the catalogue rather than
trusted.

Matching is deliberately loose: the chains are written in a person's words
("Payroll > Run payroll") and the catalogue in the product's ("Monthly
payroll"). A row is only reported when NO screen of that role shares a
meaningful word with it, which catches a wrong ROLE -- the mistake that
actually hurts.
"""
import csv, io, os, re, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from chains import CHAINS

ROOT = r"C:\Users\sony\AppData\Local\Temp\claude\c--Users-sony-projects-temp-sch-erp-\9039b9d2-69ae-4db2-8919-6e5d1f9d7553\scratchpad\wt-cf"
rows = list(csv.DictReader(io.open(os.path.join(ROOT, 'docs', 'FEATURE_REVIEW.csv'), encoding='utf-8-sig')))

by_role, sections = {}, {}
for r in rows:
    by_role.setdefault(r['Role'], []).append(re.sub(r'^\s*\u2514\s*', '', r['Feature']))
    sections.setdefault(r['Role'], []).append(r['Section'])

# chain role -> catalogue role
ALIAS = {
    'HR & Payroll': 'HR & Payroll', 'Institution Admin': 'Institution Admin / Principal',
    'Accounts & Finance': 'Accounts & Finance', 'Finance': 'Accounts & Finance',
    'Transport Manager': 'Transport Manager', 'Parent': 'Parent / Guardian',
    'Faculty': 'Faculty / Teacher', 'HOD': 'HOD / Department Head',
    'Exam Controller': 'Examination Controller', 'Admissions': 'Admissions & Front Office',
    'Librarian': 'Librarian', 'Driver': 'Driver / Bus Attendant', 'Student': 'Student',
    'Staff member': None, 'Attendant / Transport Manager': 'Transport Manager',
    'Front office': 'Admissions & Front Office',
}

STOP = set('the a an of and or to for in on at by with what who when where this that it is are '
           'my your их > & - new all one two take make set add see read run'.split())


def words(s):
    return {w for w in re.split(r"[^a-z0-9]+", s.lower()) if len(w) > 3 and w not in STOP}


bad = 0
for flow, step, who, screen, action, happens, elsewhere, verify, verified in CHAINS:
    # "HR & Payroll, or Institution Admin" is two roles, and the driver's
    # phone app is not a catalogued screen at all.
    if 'bus-tracker' in screen:
        continue
    for part in re.split(r"\s*/\s*|,\s*or\s+", who):
        role = ALIAS.get(part.strip(), ALIAS.get(who.strip(), part.strip()))
        if role is None:
            continue
        if role not in by_role:
            print('UNKNOWN ROLE  %-16s step %s  "%s"' % (flow[:16], step, part.strip()))
            bad += 1
            continue
        want = words(screen)
        if not want:
            continue
        # A chain may name the SECTION ("My Child's Bus") where the catalogue
        # names the feature inside it ("Live bus tracking"); both are how a
        # person would say where they are, so either counts.
        here = by_role[role] + sections.get(role, [])
        if not any(want & words(f) for f in here):
            print('ROLE LACKS IT %-16s step %s  %-26s has no screen like "%s"'
                  % (flow[:16], step, role[:26], screen))
            bad += 1
print()
print('chain rows:', len(CHAINS), '| questionable:', bad)
