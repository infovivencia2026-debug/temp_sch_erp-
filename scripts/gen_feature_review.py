import csv, io, re, json, os, glob

root = r"C:\Users\sony\AppData\Local\Temp\claude\c--Users-sony-projects-temp-sch-erp-\9039b9d2-69ae-4db2-8919-6e5d1f9d7553\scratchpad\wt-cf"

# The Worker's own list of what actually ships.
sd = io.open(os.path.join(root, 'worker', 'src', 'routes', 'admin', 'static_data.ts'), encoding='utf-8').read()
m = re.search(r'IMPLEMENTED_FEATURES[^=]*=\s*new Set\((\[.*?\])\)', sd, re.S)
built = set(json.loads(m.group(1)))

lines = io.open(os.path.join(root, 'web', 'src', 'catalog.gen.ts'), encoding='utf-8').read().split('\n')

def unq(s):
    return s.replace("\\'", "'").replace('\\"', '"').replace('\\\\', '\\')

role_key = role_name = ''
sec_slug = sec_name = workspace = ''
rows = []

re_rolekey = re.compile(r"^    key: '([a-z_]+)',")
re_name    = re.compile(r"^    name: '(.*)',$")
re_secslug = re.compile(r"^        slug: '([a-z0-9_]+)',")
re_secname = re.compile(r"^        name: '(.*)',$")
re_ws      = re.compile(r"^        workspace: '(.*)',$")
re_feat    = re.compile(r"\{ key: '([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)', slug: '[^']*', name: '(.*?)', scope:")
re_sum     = re.compile(r"summary: '(.*?)' \}\s*,?\s*$")

for i, ln in enumerate(lines):
    mk = re_rolekey.match(ln)
    if mk:
        role_key = mk.group(1)
        nm = re_name.match(lines[i + 1]) if i + 1 < len(lines) else None
        role_name = unq(nm.group(1)) if nm else role_key
        continue
    ms = re_secslug.match(ln)
    if ms:
        sec_slug = ms.group(1)
        sec_name, workspace = '', ''
        for j in range(i + 1, min(i + 5, len(lines))):
            n2 = re_secname.match(lines[j])
            if n2 and not sec_name:
                sec_name = unq(n2.group(1))
            w2 = re_ws.match(lines[j])
            if w2:
                workspace = unq(w2.group(1))
        continue
    mf = re_feat.search(ln)
    if mf:
        key, feat = mf.group(1), unq(mf.group(2))
        s = re_sum.search(ln)
        summary = unq(s.group(1)) if s else ''
        rows.append((role_name, workspace or sec_name, sec_name, feat, key,
                     'yes' if key in built else 'not yet', summary))

def short(text):
    """One whole sentence, never a sentence with its end cut off.

    This used to cap at seventy characters and append dots, which turned
    "What HR calculated for the month, read before the money moves, and the
    bank file" into "...read before the money moves, and..." -- shorter, and
    no longer a statement of anything. Short means one sentence, not a
    fragment: the first sentence, with the elaboration after a colon or dash
    dropped, and then left alone however long it is.
    """
    t = re.sub(r'\s+', ' ', text or '').strip().replace("''", "'")
    if not t:
        return ''
    t = re.split(r'(?<=[.])\s+(?=[A-Z])', t)[0]          # first sentence
    t = re.split(r'\s+[-–—]+\s+|:\s+', t)[0]   # before a dash or colon
    return t.rstrip(' .')


# --- the tabs inside a screen ----------------------------------------------
# A menu entry is often several screens behind one name: "School property &
# budgeting" is Budget and Property & assets. The sheet listed the entry and
# stopped there, so half the product was missing from a review of it.
FEAT = os.path.join(root, 'web', 'src', 'features')
key_to_mod = {}
_sources = [os.path.join(FEAT, 'registry.ts')]
_sources += [f for f in glob.glob(os.path.join(FEAT, '**', '*.ts'), recursive=True) if f not in _sources]
_re_entry = re.compile(
    r"'([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)':\s*(?:screen|lazy)\(\s*\(\)\s*=>\s*import\('([^']+)'\)"
    r"(?:\s*\.then\(\s*\(?\w+\)?\s*=>\s*\(\{\s*default:\s*\w+\.(\w+))?", re.S)
for _src in _sources:
    _txt = io.open(_src, encoding='utf-8').read()
    _base = os.path.dirname(_src)
    for _key, _rel, _named in _re_entry.findall(_txt):
        _p = os.path.normpath(os.path.join(_base, _rel)) if _rel.startswith('.') else os.path.normpath(
            os.path.join(root, 'web', 'src', _rel.replace('@/', '')))
        key_to_mod[_key] = (_p + '.tsx', _named or '')


def _read(path):
    for cand in (path, path.replace('.tsx', '.ts')):
        try:
            return io.open(cand, encoding='utf-8').read()
        except OSError:
            continue
    return ''


def tabs_of(key):
    """The tab labels inside a screen, in order, or [] when it has none.

    Both tab styles declare the same shape -- { key: 'x', label: 'Y', ... } --
    whether the screen is a finance Bundle or a portal hub, so one pattern
    finds both. Read from the component the menu entry opens, not the whole
    file, so a file holding two screens does not lend one screen's tabs to the
    other.
    """
    mod, export = key_to_mod.get(key, ('', ''))
    if not mod:
        return []
    txt = _read(mod)
    if not txt.strip():
        return []
    if export:
        m = re.search(r"function\s+" + re.escape(export) + r"\s*\(", txt)
        if not m:
            return []
        # To the END of that function, not the end of the file. One file holds
        # all nine finance bundles, so an unbounded slice gave the salary entry
        # every tab declared below it -- petty cash and the budget turned up
        # under "Approve & pay salaries".
        k, depth = m.end() - 1, 0
        while k < len(txt):
            if txt[k] == '(':
                depth += 1
            elif txt[k] == ')':
                depth -= 1
                if depth == 0:
                    break
            k += 1
        i = txt.find('{', k)
        if i < 0:
            return []
        depth, j = 0, i
        while j < len(txt):
            if txt[j] == '{':
                depth += 1
            elif txt[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        txt = txt[i:j + 1]
    return [unq(l) for _k, l in re.findall(r"\{\s*key: '([a-z0-9_-]+)',\s*label: '((?:[^'\\]|\\.)*)'", txt)]

# Role-wise, so a reviewer can take one role at a time.
rows.sort(key=lambda r: (r[0], r[1], r[2], r[3]))

out = os.path.join(root, 'docs', 'FEATURE_REVIEW.csv')
with io.open(out, 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Role', 'Workspace', 'Section', 'Feature', 'Permission key',
                'Built?', 'What it is for', 'Remarks'])
    subs = 0
    for r in rows:
        w.writerow(list(r[:6]) + [short(r[6]), ''])
        # Then each tab inside it, indented, so a review of the entry is a
        # review of everything behind it.
        for tab in tabs_of(r[4]):
            subs += 1
            w.writerow([r[0], r[1], r[2], '    └ ' + tab, r[4], r[5],
                        'A tab inside ' + r[3], ''])
    print('sub-tab rows:', subs)

print('rows:', len(rows))
print('roles:', len({r[0] for r in rows}))
print('built:', sum(1 for r in rows if r[5] == 'yes'), 'not yet:', sum(1 for r in rows if r[5] != 'yes'))
print('->', out)
