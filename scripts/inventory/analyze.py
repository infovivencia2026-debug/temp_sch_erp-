"""Scan the repository and write data.json: every catalogue feature with its
screen, the API endpoints that screen calls, the backend files that register
them and the tables those files touch; every backend route; every table.

It reads source text, it does not run the app. Read the limits on the Summary
tab of the workbook before trusting a single row. Run:

    python3 scripts/inventory/analyze.py
    python3 scripts/inventory/build.py docs/inventory.xlsx   # needs openpyxl
"""
import re, json, pathlib, csv, subprocess, collections
R = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(__file__).resolve().parent / 'data.json'
W = R/'worker'; WEB = R/'web'/'src'

# ---------- catalogue
sd = (W/'src/routes/admin/static_data.ts').read_text().split('\n')
def jl(name):
    l = next(x for x in sd if x.startswith(f'export const {name}'))
    v = l[l.index('= ')+2:].rstrip(';')
    if v.startswith('new Set('): v = v[len('new Set('):-1]
    return json.loads(v)
roles = jl('CATALOG_ROLES'); implemented = set(jl('IMPLEMENTED_FEATURES')); perms = jl('PERMISSIONS'); sysroles = jl('SYSTEM_ROLES')
csvrows = list(csv.DictReader(open(R/'docs/edu_features.csv')))
prio = {(r['Role'], r['Feature']): r['Priority'] for r in csvrows}

# ---------- frontend registry
reg = {}
for f in sorted((WEB/'features').rglob('*.ts*')):
    if '.test.' in f.name: continue
    t = f.read_text()
    bento = f.name == 'bento-registry.ts'
    for m in re.finditer(r"'([a-z_0-9]+\.[a-z_0-9]+\.[a-z_0-9]+)':\s*(?:screen|lazy)\(\s*\(\)\s*=>\s*import\(\s*'([^']+)'\s*\)", t, re.S):
        s0 = m.group(2)
        p = (WEB/s0[2:]) if s0.startswith('@/') else (f.parent/s0).resolve()
        for ext in ('.tsx', '.ts', '/index.tsx'):
            if pathlib.Path(str(p)+ext).exists(): p = pathlib.Path(str(p)+ext); break
        reg.setdefault(m.group(1), {})['bento' if bento else 'screen'] = p

# ---------- backend routes
routes = []  # method, path, perm, file, line
def norm(p):
    out = []
    for seg in p.split('?')[0].split('/'):
        if seg == '': 
            if not out: out.append('')
            continue
        if seg.startswith('${') or seg.startswith('{') or seg.startswith(':'): out.append('{}'); 
        elif '${' in seg:
            head = seg[:seg.index('${')]
            if head: out.append(head)
            break
        else: out.append(seg)
    return '/'.join(out).rstrip('/')
for f in sorted((W/'src').rglob('*.ts')):
    if '/test' in str(f): continue
    t = f.read_text()
    consts = dict(re.findall(r"const ([A-Za-z_]+) = ['\"`]([^'\"`$]*)['\"`]", t))
    def fill(p): return re.sub(r'\$\{([A-Za-z_]+)\}', lambda m: consts.get(m.group(1), '{'+m.group(1)+'}'), p)
    for i, l in enumerate(t.split('\n'), 1):
        m = re.search(r"\br\.(get|post|put|patch|del|delete)\(\s*['\"`]([^'\"`]+)['\"`]\s*,\s*([^,]+),", l)
        if m: routes.append(dict(method={'del':'DELETE','delete':'DELETE'}.get(m.group(1), m.group(1).upper()), path=fill(m.group(2)), perm=m.group(3).strip().strip("'\""), file=str(f.relative_to(R)), line=i)); continue
        m = re.search(r"\br\.typed\(\s*['\"`](GET|POST|PUT|PATCH|DELETE) ([^'\"`]+)['\"`]\s*,\s*([^,]+),", l)
        if m: routes.append(dict(method=m.group(1), path=fill(m.group(2)), perm=m.group(3).strip().strip("'\""), file=str(f.relative_to(R)), line=i))
route_by_norm = collections.defaultdict(list)
for r in routes: route_by_norm[norm(r['path'])].append(r)
# device/public handlers in index.ts
idx = (W/'src/index.ts').read_text()
public = sorted(set(re.findall(r"['\"`](/(?:api/v1/)?[a-zA-Z0-9_\-/{}:.]+)['\"`]", idx)))

# ---------- tables
tables = {}
for scope in ('control', 'tenant'):
    t = (W/f'db/{scope}.sql').read_text()
    for m in re.finditer(r'CREATE TABLE IF NOT EXISTS "?([a-z_0-9]+)"?\s*\((.*?)\n\);', t, re.S):
        body = m.group(2)
        cols = [x for x in body.split('\n') if re.match(r'\s*"?[a-z_0-9]+"? [A-Z]', x)]
        tables[(scope, m.group(1))] = dict(scope=scope, name=m.group(1), cols=len(cols), fks=len(re.findall(r'FOREIGN KEY', body)), idx=0, pk='PRIMARY KEY' in body)
    for m in re.finditer(r'CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"?[a-z_0-9]+"? ON "?([a-z_0-9]+)"?', t):
        k = (scope, m.group(1))
        if k in tables: tables[k]['idx'] += 1
tnames = {n for (_, n) in tables}
migr = {}
for scope in ('control', 'tenant'):
    for f in sorted((W/f'migrations/{scope}').glob('*.sql')):
        for m in re.finditer(r'CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?', f.read_text()):
            migr.setdefault((scope, m.group(1)), f.name)

SQLRE = re.compile(r'\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"?([a-z_][a-z_0-9]+)"?')
def tables_in(text): return sorted({m for m in SQLRE.findall(text) if m in tnames})
file_tables = {}; file_stub = {}
srcfiles = [f for f in (W/'src').rglob('*.ts')]
for f in srcfiles:
    t = f.read_text(); rel = str(f.relative_to(R))
    file_tables[rel] = tables_in(t)
    file_stub[rel] = len(re.findall(r'notImplemented\(|HttpError\(501', t))
table_users = collections.defaultdict(set)
for f, ts in file_tables.items():
    for t in ts: table_users[t].add(f)

# ---------- frontend API calls per file
APIRE = re.compile(r"['\"`](?:GET |POST |PUT |PATCH |DELETE )?(/api/v1)?(/[a-zA-Z0-9_\-/{}$.:]*?)(?:\?[^'\"`]*)?['\"`]")
def api_paths(text):
    out = set()
    for m in re.finditer(r"['\"`]/api/v1(/[^'\"`?\s]*)", text): out.add(norm(m.group(1)))
    for m in re.finditer(r"api\.call\(\s*['\"`](?:GET|POST|PUT|PATCH|DELETE) (/[^'\"`?\s]*)", text): out.add(norm(m.group(1)))
    return {p for p in out if p}
def local_imports(f, depth=3, seen=None):
    seen = seen if seen is not None else set()
    if f in seen or not f.exists(): return seen
    seen.add(f)
    if depth == 0: return seen
    for m in re.finditer(r"from\s+['\"](\.{1,2}/[^'\"]+|@/features/[^'\"]+|@/components/[^'\"]+)['\"]", f.read_text()):
        s = m.group(1)
        base = (WEB/s[2:]) if s.startswith('@/') else (f.parent/s)
        for ext in ('.tsx', '.ts', '/index.tsx', '/index.ts'):
            p = pathlib.Path(str(base.resolve())+ext)
            if p.exists():
                if 'components/ui' in str(p) or '/lib/' in str(p): break
                local_imports(p, depth-1, seen); break
    return seen
ALLW = '\n'.join(f.read_text() for f in (W/'src').rglob('*.ts'))
def outside(p):
    lit = '/'.join(x for x in p.split('/') if x != '{}')
    head = '/'.join(p.split('/')[:3])
    return ("'/api/v1" + head) in ALLW or ('/api/v1' + lit) in ALLW or ("'" + head + "'") in ALLW or (head + '/') in ALLW and p.startswith('/public')
def match(p):
    if p.endswith('/{}') and p[:-3] in route_by_norm: return route_by_norm[p[:-3]]
    if p in route_by_norm: return route_by_norm[p]
    pre = [r for c, rs in route_by_norm.items() if c.startswith(p + '/') for r in rs]
    if pre: return pre
    if outside(p): return [dict(file='worker/src/index.ts', path=p, method='*')]
    # template tail like /students/{}/x{} or prefix built by concatenation
    segs = p.split('/')
    for cand, rs in route_by_norm.items():
        cs = cand.split('/')
        if len(cs) == len(segs) and all(a == b or a == '{}' or b == '{}' or '{}' in b for a, b in zip(cs, segs)): return rs
    return []
# web tests index
webtests = [f for f in WEB.rglob('*.test.ts*')]
wtests = [f for f in (W/'test').rglob('*.test.ts')]
wtext = {f: f.read_text() for f in wtests}

features = []
all_called = collections.Counter()
for role in roles:
    for sec in role['sections']:
        for ft in sec['features']:
            k = ft['key']; e = reg.get(k, {})
            scr = e.get('screen'); bento = e.get('bento')
            files = set()
            for s in (scr, bento):
                if s: files |= local_imports(s)
            paths = set()
            for f in files: paths |= api_paths(f.read_text())
            rfiles = set(); missing = []
            for p in sorted(paths):
                rs = match(p)
                if rs: rfiles |= {r['file'] for r in rs}
                else: missing.append(p)
                all_called[p] += 1
            tbs = sorted({t for rf in rfiles for t in file_tables.get(rf, [])})
            stubs = sum(file_stub.get(rf, 0) for rf in rfiles)
            wt = sorted({f.name for f, t in wtext.items() if any(('/' + p.strip('/').split('/{}')[0]) in t for p in paths if len(p) > 3)})
            st = [x for x in webtests if scr and x.name.split('.')[0] == scr.name.split('.')[0]]
            features.append(dict(role=role['name'], role_key=role['key'], workspace=sec.get('workspace', ''), section=sec['name'], name=ft['name'], key=k, tier=ft.get('tier', ''), scope=ft.get('scope', ''),
                priority=prio.get((role['name'], ft['name']), ''), summary=ft.get('summary', ''),
                screen=str(scr.relative_to(R)) if scr else '', bento=str(bento.relative_to(R)) if bento else '', implemented=k in implemented,
                api=sorted(paths), missing=missing, route_files=sorted(rfiles), tables=tbs, stubs=stubs, worker_tests=wt, web_tests=[x.name for x in st]))

# every frontend call anywhere
allfront = collections.defaultdict(set)
for f in WEB.rglob('*.ts*'):
    if '.test.' in f.name or f.name.endswith('.d.ts'): continue
    for p in api_paths(f.read_text()): allfront[p].add(str(f.relative_to(R)))
front_missing = {p: sorted(fs) for p, fs in allfront.items() if not match(p)}
called_norms = set(allfront)
def is_called(r):
    n = norm(r['path'])
    if n in called_norms: return True
    segs = n.split('/')
    for c in called_norms:
        cs = c.split('/')
        if len(cs) == len(segs) and all(a == b or a == '{}' or b == '{}' or '{}' in a for a, b in zip(cs, segs)): return True
    return False
for r in routes: r['called'] = is_called(r); r['tables'] = file_tables.get(r['file'], []); 
tabs = []
for (scope, n), t in sorted(tables.items()):
    users = sorted(table_users.get(n, []))
    tabs.append(dict(**t, migration=migr.get((scope, n), 'baseline'), used_by=users))
stubs=[]
for f in srcfiles:
    for i,l in enumerate(f.read_text().split('\n'),1):
        if re.search(r'notImplemented\(|HttpError\(501', l) and 'const notImplemented' not in l and 'function notImplemented' not in l and not l.strip().startswith(('//','*','/*')): stubs.append(dict(file=str(f.relative_to(R)), line=i, text=l.strip()[:220]))
json.dump(dict(stubs=stubs, features=features, routes=routes, tables=tabs, front_missing=front_missing, public=public, perms=perms, sysroles=[dict(key=r['key'], name=r['name'], n=len(r.get('permissions', []))) for r in sysroles]), open(OUT, 'w'))
F = features
print('features', len(F), 'with screen', sum(1 for f in F if f['screen']), 'implemented', sum(f['implemented'] for f in F), 'no screen', sum(1 for f in F if not f['screen'] and not f['bento']))
print('features with missing API', sum(1 for f in F if f['missing']), 'features w/ no api at all but screen', sum(1 for f in F if f['screen'] and not f['api']))
print('routes', len(routes), 'never called from web', sum(1 for r in routes if not r['called']))
print('tables', len(tabs), 'unused by worker src', sum(1 for t in tabs if not t['used_by']), 'no index', sum(1 for t in tabs if t['idx'] == 0 and not t['pk']))
print('frontend paths with no backend route:', len(front_missing))
for p, fs in sorted(front_missing.items())[:80]: print('  ', p, '<-', fs[0], f'(+{len(fs)-1})' if len(fs) > 1 else '')

print('stubs', len(stubs))
print('unused tables:', [(t['scope'], t['name']) for t in tabs if not t['used_by']])
print('no screen:', [f['key'] for f in F if not f['screen'] and not f['bento']])
print('screen, no api:', [f['key'] for f in F if f['screen'] and not f['api']])
print('still missing:', sorted({m for f in F for m in f['missing']}))
