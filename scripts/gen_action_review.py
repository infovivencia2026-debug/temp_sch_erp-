"""Every action button in the product, mapped to the screen and role that reach it.

The feature sheet lists screens. This lists what you can press once you are on
one: print, export, download, import. Read out of the code rather than
remembered, so it stays true when somebody adds a button.

Two things it takes care to get right:

  * Which component. Two screens often share one source file -- the transport
    desk and today's runs are both in TodaysRuns.tsx -- and attributing the
    file's buttons to both put a Print on a screen that has none. The registry
    entry says which export the key opens, and only that component's body, plus
    the local components it actually renders, is read.

  * Which affordances. A button is written a dozen ways: a <PrintButton>, a
    <Button> whose text is Export, an onClick that calls saveFile, a file
    input. Matching one spelling missed the rest.
"""
import csv, io, re, json, os, glob

root = r"C:\Users\sony\AppData\Local\Temp\claude\c--Users-sony-projects-temp-sch-erp-\9039b9d2-69ae-4db2-8919-6e5d1f9d7553\scratchpad\wt-cf"
WEB = os.path.join(root, 'web', 'src')
FEAT = os.path.join(WEB, 'features')

# --- feature key -> (module, exported component) ---------------------------
key_to_mod = {}
sources = [os.path.join(FEAT, 'registry.ts')]
sources += [f for f in glob.glob(os.path.join(FEAT, '**', '*.ts'), recursive=True) if f not in sources]

re_entry = re.compile(
    r"'([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)':\s*(?:screen|lazy)\(\s*\(\)\s*=>\s*import\('([^']+)'\)"
    r"(?:\s*\.then\(\s*\(?\w+\)?\s*=>\s*\(\{\s*default:\s*\w+\.(\w+))?", re.S)

for src in sources:
    txt = io.open(src, encoding='utf-8').read()
    base = os.path.dirname(src)
    for key, rel, named in re_entry.findall(txt):
        p = os.path.normpath(os.path.join(base, rel)) if rel.startswith('.') else os.path.normpath(
            os.path.join(WEB, rel.replace('@/', '')))
        key_to_mod[key] = (p + '.tsx', named or '')

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


def blocks(txt):
    """Top-level components in a file, by name, with their bodies."""
    out = {}
    for m in re.finditer(r"^(?:export\s+)?(?:default\s+)?function\s+(\w+)\s*\(", txt, re.M):
        name = m.group(1)
        # Walk the parameter list to its closing paren FIRST. Taking the next
        # brace instead cut `function Seating({ examId, picker }: {...})` off
        # at the destructuring brace, so the body was its own arguments and
        # every button inside it vanished -- which is how Hall tickets lost
        # its Print.
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
            continue
        depth, j = 0, i
        while j < len(txt):
            if txt[j] == '{':
                depth += 1
            elif txt[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out[name] = txt[i:j + 1]
    return out


def default_name(txt):
    m = re.search(r"export\s+default\s+function\s+(\w+)", txt)
    return m.group(1) if m else ''


def scope_for(path, export):
    """The text belonging to this screen: its component and the local
    components it renders, followed transitively. Whole file as a fallback."""
    txt = read(path)
    if not txt.strip():
        return ''
    bs = blocks(txt)
    start = export or default_name(txt)
    if start not in bs:
        return txt
    want, seen, parts = [start], set(), []
    while want:
        n = want.pop()
        if n in seen:
            continue
        seen.add(n)
        body = bs.get(n, '')
        parts.append(body)
        for ref in set(re.findall(r"<(\w+)[\s/>]", body)):
            if ref in bs and ref not in seen:
                want.append(ref)
    return '\n'.join(parts)


def children_of(path, export):
    """Modules this screen is assembled from: static imports it uses, and the
    dynamic ones a hub loads for its tabs (FeesHub loads Receipts that way,
    which is where a parent's Download lives)."""
    txt = read(path)
    base = os.path.dirname(path)
    rels = re.findall(r"from '(\.[^']+)'", txt) + re.findall(r"import\('(\.[^']+)'\)", txt)
    out = []
    for rel in rels:
        cand = os.path.normpath(os.path.join(base, rel)) + '.tsx'
        if cand not in out:
            out.append(cand)
    return out


PRINT_CALLS = re.compile(r"printDocument\(|window\.print\(")
DOWNLOAD_CALLS = re.compile(r"saveFile\(|URL\.createObjectURL\(")


def label_hits(txt, word):
    """A visible control whose words include this one, however it is written."""
    hits = []
    for m in re.finditer(r"<(?:Button|button|PrintButton)\b[^>]*>(.*?)</(?:Button|button|PrintButton)>", txt, re.S):
        inner = re.sub(r"<[^>]+>", " ", m.group(1))
        inner = re.sub(r"\{[^{}]*\}", " ", inner)
        inner = re.sub(r"\s+", " ", inner).strip()
        # A label is words a person reads. Anything carrying code punctuation
        # is a fragment of an onClick that leaked through, not a button name.
        if (re.search(r"\b" + word + r"\b", inner, re.I) and len(inner) < 60
                and not re.search(r"[(){}`$]", inner)):
            hits.append(inner)
    for m in re.finditer(r"label=\{?['\"]([^'\"]*)['\"]", txt):
        if re.search(r"\b" + word + r"\b", m.group(1), re.I):
            hits.append(m.group(1))
    return hits


def actions_in(path, export):
    txt = scope_for(path, export)
    for child in children_of(path, export):
        txt += '\n' + read(child)
    if not txt.strip():
        return []
    found = []

    for lab in re.findall(r"<PrintButton[^>]*?label=\{?['\"]([^'\"]+)", txt, re.S):
        found.append(('Print', lab))
    found += [('Print', 'Print')] * len(re.findall(r"<PrintButton(?![^>]*label=)", txt))
    for lab in label_hits(txt, 'print'):
        found.append(('Print', lab))
    if PRINT_CALLS.search(txt) and not found:
        found.append(('Print', 'Print'))

    if re.search(r"<Table\b", txt):
        found.append(('Export', 'Export (table to spreadsheet)'))
    for lab in label_hits(txt, 'export'):
        found.append(('Export', lab))
    for lab in label_hits(txt, 'download'):
        found.append(('Download', lab))
    if DOWNLOAD_CALLS.search(txt):
        found.append(('Download', 'Download (a file the server draws)'))

    for lab in label_hits(txt, 'import') + label_hits(txt, 'upload'):
        found.append(('Import', lab))
    if re.search(r"type=.file.", txt):
        found.append(('Import', 'Upload a file'))

    # One button, one action. "Export for re-import" carries both words and was
    # listed twice, as an Export and as an Import -- the first classification
    # wins, and the order above runs from the most specific wording down.
    seen, labels, out = set(), set(), []
    for kind, label in found:
        if (kind, label) in seen or label in labels:
            continue
        seen.add((kind, label))
        labels.add(label)
        out.append((kind, label))
    return out


WHAT = {
    'Print': 'Print preview on the letterhead, then print or save as PDF',
    'Export': 'This table as a spreadsheet, opens in Excel',
    'Download': 'Saves a PDF the server draws, such as a receipt',
    'Import': 'Upload a filled spreadsheet to add or update many records',
}

rows = []
for key, (mod, export) in sorted(key_to_mod.items()):
    if key not in role_of:
        continue
    for kind, label in actions_in(mod, export):
        rows.append([role_of[key], feat_name.get(key, ''), key,
                     'yes' if key in built else 'not yet',
                     kind, label, WHAT[kind], ''])

# Role-wise, so a reviewer can take one role at a time.
rows.sort(key=lambda r: (r[0], r[1], r[4], r[5]))

out = os.path.join(root, 'docs', 'ACTION_REVIEW.csv')
with io.open(out, 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Role', 'Screen', 'Permission key', 'Built?', 'Action', 'Button', 'What it does', 'Remarks'])
    w.writerows(rows)

unmapped = sorted(k for k in role_of if k not in key_to_mod and k in built)
print('screens with a module found:', len(key_to_mod))
print('built screens with no module found:', len(unmapped))
print('action rows:', len(rows))
for k in WHAT:
    print('  ', k, sum(1 for r in rows if r[4] == k))
print('->', out)
