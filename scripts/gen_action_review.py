"""Every action button in the product, mapped to the screens and roles that reach it.

The feature sheet lists screens. This lists what you can press once you are on
one: print, export, download, import. Built by reading the code rather than by
remembering, so it stays true when somebody adds a button.
"""
import csv, io, re, json, os, glob

root = r"C:\Users\sony\AppData\Local\Temp\claude\c--Users-sony-projects-temp-sch-erp-\9039b9d2-69ae-4db2-8919-6e5d1f9d7553\scratchpad\wt-cf"
WEB = os.path.join(root, 'web', 'src')
FEAT = os.path.join(WEB, 'features')

# --- feature key -> screen module ------------------------------------------
key_to_mod = {}
sources = [os.path.join(FEAT, 'registry.ts')]
# Some are named foo-keys.ts and some just keys.ts; take every .ts under features.
sources += [f for f in glob.glob(os.path.join(FEAT, '**', '*.ts'), recursive=True)
           if f not in sources]
re_entry = re.compile(r"'([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)':\s*(?:screen|lazy)\(\s*\(\)\s*=>\s*import\('([^']+)'\)")
for src in sources:
    txt = io.open(src, encoding='utf-8').read()
    base = os.path.dirname(src)
    for key, rel in re_entry.findall(txt):
        p = os.path.normpath(os.path.join(base, rel)) if rel.startswith('.') else os.path.normpath(
            os.path.join(WEB, rel.replace('@/', '')))
        key_to_mod[key] = p + '.tsx'

# --- roles, screen names, and which keys ship ------------------------------
sd = io.open(os.path.join(root, 'worker', 'src', 'routes', 'admin', 'static_data.ts'), encoding='utf-8').read()
built = set(json.loads(re.search(r'IMPLEMENTED_FEATURES[^=]*=\s*new Set\((\[.*?\])\)', sd, re.S).group(1)))

lines = io.open(os.path.join(WEB, 'catalog.gen.ts'), encoding='utf-8').read().split('\n')
role_of, feat_name = {}, {}
rn = ''
for i, ln in enumerate(lines):
    m = re.match(r"^    key: '([a-z_]+)',", ln)
    if m:
        n = re.match(r"^    name: '(.*)',$", lines[i + 1]) if i + 1 < len(lines) else None
        rn = n.group(1).replace("\\'", "'") if n else m.group(1)
        continue
    f = re.search(r"\{ key: '([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)', slug: '[^']*', name: '(.*?)', scope:", ln)
    if f:
        role_of[f.group(1)] = rn
        feat_name[f.group(1)] = f.group(2).replace("\\'", "'")


def read(path):
    for cand in (path, path.replace('.tsx', '.ts')):
        try:
            return io.open(cand, encoding='utf-8').read()
        except OSError:
            continue
    return ''


def family(path):
    """The screen file plus the local components it is assembled from.

    A Download lives in Receipts.tsx, which the portal screen imports; reading
    only the screen file missed every one of them. One level deep catches the
    panels a screen is built from and stops short of the whole library.
    """
    files = [path]
    base = os.path.dirname(path)
    txt0 = read(path)
    # Static imports, and the dynamic ones a hub screen uses for its tabs
    # (FeesHub loads Receipts with screen(() => import('./Receipts'))), which
    # is where a parent's Download receipt button actually lives.
    rels = re.findall(r"from '(\.[^']+)'", txt0) + re.findall(r"import\('(\.[^']+)'\)", txt0)
    for rel in rels:
        cand = os.path.normpath(os.path.join(base, rel)) + '.tsx'
        if cand not in files:
            files.append(cand)
    return files


def actions_in(path):
    txt = '\n'.join(read(f) for f in family(path))
    if not txt.strip():
        return []
    found = []
    for label in re.findall(r"<PrintButton[^>]*?label=\{?['\"]([^'\"]+)", txt, re.S):
        found.append(('Print', label))
    found += [('Print', 'Print')] * len(re.findall(r"<PrintButton(?![^>]*label=)", txt))
    if re.search(r"<Table\b", txt):
        found.append(('Export', 'Export (table to spreadsheet)'))
    for label in re.findall(r">\s*(Export[^<{]*)<", txt):
        found.append(('Export', label.strip()))
    if 'saveFile(' in txt:
        found.append(('Download', 'Download (PDF the server draws)'))
    if re.search(r"printDocument\(", txt) and '<PrintButton' not in txt:
        found.append(('Print', 'Print'))
    for label in re.findall(r">\s*(Import[^<{]*)<", txt):
        found.append(('Import', label.strip()))
    # An ES module import is not a button. Only a visible affordance counts:
    # a file picker, or the word Import inside a string the user can read.
    if re.search(r"type=.file.", txt) or re.search(r"['\"][^'\"]*Import[^'\"]*['\"]", txt):
        found.append(('Import', 'Import from a spreadsheet'))
    seen, out = set(), []
    for a in found:
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


WHAT = {
    'Print': 'Opens a print preview on the school letterhead, then prints or saves as PDF.',
    'Export': 'Downloads what is on screen as a spreadsheet (CSV), opens in Excel.',
    'Download': 'Saves a PDF the server draws (receipt, certificate) straight to the device.',
    'Import': 'Uploads a filled spreadsheet to create or update many records at once.',
}

rows = []
for key, mod in sorted(key_to_mod.items()):
    if key not in role_of:
        continue
    for kind, label in actions_in(mod):
        rows.append([role_of[key], feat_name.get(key, ''), key,
                     'yes' if key in built else 'not yet',
                     kind, label, WHAT[kind], ''])

out = os.path.join(root, 'docs', 'ACTION_REVIEW.csv')
with io.open(out, 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Role', 'Screen', 'Permission key', 'Built?', 'Action', 'Button', 'What it does', 'Your remarks'])
    w.writerows(rows)

unmapped = sorted(k for k in role_of if k not in key_to_mod and k in built)
print('screens with a module found:', len(key_to_mod))
print('built screens with no module found:', len(unmapped))
for k in unmapped[:10]:
    print('   -', k)
print('action rows:', len(rows))
for k in WHAT:
    print('  ', k, sum(1 for r in rows if r[4] == k))
print('->', out)
