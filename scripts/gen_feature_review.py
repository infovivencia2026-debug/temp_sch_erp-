import csv, io, re, json, os

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

def short(text, limit=70):
    """One short line a person can scan, not the catalogue paragraph.

    The leading clause is the definition; what follows a colon or a dash is
    nearly always the elaboration, and a reviewer reading four hundred rows
    does not want it. Cut there first, then cap on a word boundary.
    """
    t = re.sub(r'\s+', ' ', text or '').strip().replace("''", "'")
    if not t:
        return ''
    t = re.split(r'(?<=[.])\s+(?=[A-Z])', t)[0]          # first sentence
    t = re.split(r'\s+[-–—]+\s+|:\s+', t)[0]   # before a dash or colon
    t = t.rstrip(' .')
    if len(t) > limit:
        t = t[:limit].rsplit(' ', 1)[0] + '...'
    return t

# Role-wise, so a reviewer can take one role at a time.
rows.sort(key=lambda r: (r[0], r[1], r[2], r[3]))

out = os.path.join(root, 'docs', 'FEATURE_REVIEW.csv')
with io.open(out, 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Role', 'Workspace', 'Section', 'Feature', 'Permission key',
                'Built?', 'What it is for', 'Remarks'])
    for r in rows:
        w.writerow(list(r[:6]) + [short(r[6]), ''])

print('rows:', len(rows))
print('roles:', len({r[0] for r in rows}))
print('built:', sum(1 for r in rows if r[5] == 'yes'), 'not yet:', sum(1 for r in rows if r[5] != 'yes'))
print('->', out)
