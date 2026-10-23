#!/usr/bin/env python3
"""Build docs/feature-map.md and docs/feature-map.csv from the code itself.

Three layers, each read from its own source of truth and then joined:

  frontend  web/src/catalog.gen.ts (every catalogued feature, by role and
            section) and web/src/features/registry.ts (which of them has a
            screen), then the api.* calls those screens and their imports make;
  backend   every r.get/post/put/patch/del/typed(...) registration under
            worker/src/routes, with its permission key and the tables its SQL
            (and the services it imports) names;
  database  every CREATE TABLE in worker/migrations/{tenant,control}, with
            renames and drops applied in order.

Nothing in the output is hand-written. The script also runs the cross-checks
that a hand-made map cannot: a screen calling a path no route serves, a route
guarded by a permission the seed does not define, a table no code reads or
writes, two routes on one path, a route an earlier pattern shadows.

    python scripts/gen_feature_map.py
"""
import re, os, json, glob, csv, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(ROOT, "web", "src")
K = os.path.join(ROOT, "worker", "src")
DOCS = os.path.join(ROOT, "docs")


def rd(p): return open(p, encoding="utf-8", errors="replace").read()
def rel(p): return os.path.relpath(p, ROOT).replace("\\", "/")
def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), s, flags=re.S)
    return re.sub(r"(^|\s)//[^\n]*", r"\1", s)


# ---------- DATABASE ----------
tables = {}
for scope in ("tenant", "control"):
    for f in sorted(glob.glob(os.path.join(ROOT, "worker", "migrations", scope, "*.sql"))):
        s = re.sub(r"--[^\n]*", "", rd(f))
        for m in re.finditer(r"CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"`]?([A-Za-z_][A-Za-z0-9_]*)", s, re.I):
            tables.setdefault(m.group(1).lower(), (scope, os.path.basename(f)))
        for m in re.finditer(r"ALTER\s+TABLE\s+[\"`]?([A-Za-z_][A-Za-z0-9_]*)[\"`]?\s+RENAME\s+TO\s+[\"`]?([A-Za-z_][A-Za-z0-9_]*)", s, re.I):
            old, new = m.group(1).lower(), m.group(2).lower()
            tables[new] = tables.pop(old, (scope, os.path.basename(f)))
        for m in re.finditer(r"DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\"`]?([A-Za-z_][A-Za-z0-9_]*)", s, re.I):
            t = m.group(1).lower()
            if t in tables and not re.search(r"(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|RENAME\s+TO\s+)[\"`]?" + t + r"\b", s[m.end():], re.I):
                tables.pop(t, None)
TABLESET = set(tables)
NOISE = {"sqlite_master", "json_each", "json_tree", "pragma_table_info", "_migrations", "dual", "sqlite_sequence", "temp"}

# ---------- BACKEND ----------
# GET /session is answered in index.ts before the router runs.
routes = [dict(method="GET", path="/session", perm="auth", file="worker/src/index.ts", line=70, typed=False, htables=[])]
Q = r"['\"`]"
route_re = re.compile(r"\br\.(get|post|put|patch|del)\(\s*" + Q + r"([^'\"`]+)" + Q + r"\s*,\s*(?:" + Q + r"([^'\"`]+)" + Q + r"|([A-Za-z_][A-Za-z0-9_.]*))", re.S)
typed_re = re.compile(r"\br\.typed\(\s*" + Q + r"(GET|POST|PUT|PATCH|DELETE) ([^'\"`]+)" + Q + r"\s*,\s*(?:" + Q + r"([^'\"`]+)" + Q + r"|([A-Za-z_][A-Za-z0-9_.]*))", re.S)
sql_tbl_re = re.compile(r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE|EXISTS)\s+[\"`]?([a-z_][a-z0-9_]*)", re.I)
str_re = re.compile(r"`[^`]*`|'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"", re.S)
file_tables, file_strict, global_consts = {}, {}, {}
worker_files = [f for f in glob.glob(os.path.join(K, "**", "*.ts"), recursive=True)
                if not (rel(f).endswith(".d.ts") or rel(f).endswith(".test.ts") or "/test/" in rel(f))]
# two passes so an alias (const desk = SUPPORT_DESK) resolves whichever file defines it
for f in worker_files:
    for m in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['\"`]([^'\"`]*)['\"`]", strip_comments(rd(f))):
        v = m.group(2)
        if (re.fullmatch(r"[a-z_.0-9]+", v) or v.startswith("/")) and m.group(1) not in global_consts: global_consts[m.group(1)] = v
for f in worker_files:
    fr = rel(f)
    s = strip_comments(rd(f))
    consts = {}
    for m in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['\"`]([^'\"`]*)['\"`]", s):
        v = m.group(2)
        if (re.fullmatch(r"[a-z_.0-9]+", v) or v.startswith("/")) and m.group(1) not in consts: consts[m.group(1)] = v
    for m in re.finditer(r"\b(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Z_][A-Z0-9_]*)\b", s):
        if m.group(1) not in consts and m.group(2) in global_consts: consts[m.group(1)] = global_consts[m.group(2)]
    def fix_path(pth):
        return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: consts.get(m.group(1), global_consts.get(m.group(1), m.group(0))), pth)
    raw = rd(f)
    ctes = {m.group(1).lower() for m in re.finditer(r"(?:\bWITH(?:\s+RECURSIVE)?\s+|,\s*)([a-z_][a-z0-9_]*)\s+AS\s*\(", raw, re.I)}
    strings = " ".join(m.group(0) for m in str_re.finditer(s))
    strict = {m.group(1).lower() for m in sql_tbl_re.finditer(strings)} - ctes
    loose = {m.group(1).lower() for m in sql_tbl_re.finditer(raw)}
    file_tables[fr] = strict | (loose & TABLESET)
    file_strict[fr] = {t for t in strict if "_" in t}
    def perm_of(m, a, b):
        if m.group(a): return m.group(a)
        return consts.get(m.group(b)) or global_consts.get(m.group(b)) or ("IDENT:" + m.group(b))
    def span_end(start):
        # index just past the ')' that closes the call opened at s[start] == '('
        depth = 0; i = start; n = len(s); q = None
        while i < n:
            ch = s[i]
            if q:
                if ch == "\\": i += 2; continue
                if ch == q: q = None
            elif ch in "'\"`": q = ch
            elif ch in "([{": depth += 1
            elif ch in ")]}":
                depth -= 1
                if depth == 0: return i + 1
            i += 1
        return n
    def body_of(name, near=0):
        # top-level definitions only (column 0 or inside the register function's one indent); a handler's own
        # `const rows = ...` must not be mistaken for a module-wide SQL fragment of the same name. When a name is
        # defined more than once, the definition nearest above the handler is the one in scope.
        ms = list(re.finditer(r"^(?: {0,2}|\t?)(?:export\s+)?(?:async\s+)?(?:function\s+" + name + r"\s*[<(]|(?:const|let)\s+" + name + r"\s*(?::[^=]+)?=)", s, re.M))
        if not ms: return ""
        before = [x for x in ms if x.start() < near]
        m = before[-1] if before else ms[0]
        # the body runs to the close of the first bracket or template opened on the definition's line; a one-line value is the line
        eol = s.find("\n", m.end() - 1)
        if eol < 0: eol = len(s)
        head = s[m.end() - 1:eol]
        k = next((i for i, ch in enumerate(head) if ch in "([{`"), -1)
        if k < 0: return s[m.start():eol]
        o = m.end() - 1 + k
        if s[o] == "`":
            e = s.find("`", o + 1)
            return s[m.start():(e + 1 if e > 0 else eol)]
        return s[m.start():span_end(o)]
    local_fn = {nm for nm in re.findall(r"^(?: {0,2}|\t?)(?:export\s+)?(?:async\s+)?(?:function\s+|(?:const|let)\s+)([A-Za-z_][A-Za-z0-9_]*)", s, re.M)}
    regs = list(route_re.finditer(s)) + list(typed_re.finditer(s))
    spans = {}
    for m in regs:
        o = s.find("(", m.start()); spans[m.start()] = s[o:span_end(o)]
    # a helper called from most registrations in the file (a wrapper such as fin(...)) is route-wide, not this route's own tables
    use = collections.Counter(nm for sp in spans.values() for nm in set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", sp)) if nm in local_fn)
    wrappers = {nm for nm, n in use.items() if len(regs) >= 4 and n >= max(4, len(regs) // 2)}
    def handler_tables(m):
        span = spans[m.start()]
        text = span
        # every local function or const the handler names (SQL fragments held in consts, named handlers, helpers), wrappers aside
        for nm in set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", span)):
            if nm in local_fn and nm not in wrappers: text += body_of(nm, m.start())
        return {t.lower() for t in sql_tbl_re.findall(text)} & TABLESET - ctes
    for m in regs:
        g = m.groups()
        if m.re is route_re:
            meth, path = ("DELETE" if g[0] == "del" else g[0].upper()), g[1]
        else:
            meth, path = g[0], g[1]
        routes.append(dict(method=meth, path=fix_path(path), perm=perm_of(m, 3, 4), file=fr, line=s[:m.start()].count("\n") + 1,
                           typed=m.re is typed_re, htables=sorted(handler_tables(m))))

imp_re = re.compile(r"from\s+['\"](\.{1,2}/[^'\"]+)['\"]")
def resolve(frm, spec):
    base = os.path.normpath(os.path.join(os.path.dirname(os.path.join(ROOT, frm)), spec))
    for c in (base + ".ts", os.path.join(base, "index.ts")):
        if os.path.exists(c): return rel(c)
    return None
imports = {f: [x for x in (resolve(f, m.group(1)) for m in imp_re.finditer(rd(os.path.join(ROOT, f)))) if x] for f in file_tables}
def tables_of(f, depth=2, seen=None):
    seen = seen if seen is not None else set()
    if f in seen or depth < 0: return set()
    seen.add(f)
    out = set(file_tables.get(f, set()))
    for i in imports.get(f, []):
        if "/services/" in i or "/routes/" in i: out |= tables_of(i, depth - 1, seen)
    return out
route_files = {r["file"] for r in routes}
route_tables = {f: tables_of(f) & TABLESET for f in route_files}
route_unknown = {f: v for f, v in ((f, sorted(file_strict.get(f, set()) - TABLESET - NOISE)) for f in route_files) if v}

def compile_route(p):
    src = re.escape(p).replace(r"\{", "{").replace(r"\}", "}")
    src = re.sub(r"\{[A-Za-z_]+\}", "[^/]+", src)
    src = re.sub(r"\\\*$", ".*", src)
    return re.compile("^" + src + "/?$")
compiled = [(r, compile_route(r["path"])) for r in routes]
def match(meth, path):
    for r, rx in compiled:
        if r["method"] == meth and rx.match(path): return r
    if "{x}" in path:
        segs = path.strip("/").split("/")
        for r, rx in compiled:
            if r["method"] != meth: continue
            rs = r["path"].strip("/").split("/")
            if r["path"].endswith("*"):
                if len(rs) - 1 <= len(segs) and all(a == "{x}" or b.startswith("{") or a == b for a, b in zip(segs, rs[:-1])): return r
                continue
            if len(rs) == len(segs) and all(a == "{x}" or b.startswith("{") or a == b for a, b in zip(segs, rs)): return r
    return None

seed = rd(os.path.join(K, "services", "provision_seed.ts"))
perms = set(re.findall(r'\["([a-z_.0-9]+)","[a-z_0-9]+","', seed))

# ---------- FRONTEND ----------
cat = rd(os.path.join(W, "catalog.gen.ts"))
features, role_names, section_names = {}, {}, {}
role = sec = None
for line in cat.splitlines():
    m = re.match(r"    key: '([a-z_]+)',\s*$", line)
    if m: role = m.group(1); continue
    m = re.match(r"    name: '((?:[^'\\]|\\.)*)',\s*$", line)
    if m and role: role_names.setdefault(role, m.group(1)); continue
    m = re.match(r"        slug: '([a-z_0-9]+)',\s*$", line)
    if m: sec = m.group(1); continue
    m = re.match(r"        name: '((?:[^'\\]|\\.)*)',\s*$", line)
    if m and role and sec: section_names[(role, sec)] = m.group(1); continue
    m = re.match(r"\s+\{ key: '([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)', slug: '[^']*', name: '((?:[^'\\]|\\.)*)'", line)
    if m: features[m.group(1)] = dict(role=role, section=sec, name=m.group(2).replace("\\'", "'"))
reg = rd(os.path.join(W, "features", "registry.ts"))
registry = {m.group(1): m.group(2) for m in re.finditer(r"'([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)':\s*screen\(\(\)\s*=>\s*import\('\./([^']+)'\)", reg)}

call_re = re.compile(r"api\.(get|post|put|patch|del|delete)\s*(?:<[^()]*?>)?\s*\(\s*([`'\"])((?:(?!\2).)*)\2", re.S)
concat_re = re.compile(r"api\.(get|post|put|patch|del|delete)\s*(?:<[^()]*?>)?\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*([`'\"])((?:(?!\3).)*)\3", re.S)
fetch_re = re.compile(r"fetch\(\s*([`'\"])((?:(?!\1).)*)\1\s*(?:,\s*\{([^}]*)\})?", re.S)
typedcall_re = re.compile(r"api\.call\s*(?:<[^()]*?>)?\s*\(\s*['\"`](GET|POST|PUT|PATCH|DELETE) ([^'\"`]+)['\"`]")
platform_re = re.compile(r"usePlatform(Save)?\s*(?:<[^()]*?>)?\s*\(\s*[^,]+,\s*['\"`]([^'\"`]+)['\"`]\s*(?:,\s*['\"](post|put)['\"])?")
web_imp_re = re.compile(r"from\s+['\"]((?:\.{1,2}|@)/[^'\"]+)['\"]")
dyn_imp_re = re.compile(r"import\(\s*['\"]((?:\.{1,2}|@)/[^'\"]+)['\"]\s*\)")
def wresolve(frm, spec):
    base = os.path.join(W, spec[2:]) if spec.startswith("@/") else os.path.normpath(os.path.join(os.path.dirname(frm), spec))
    for c in (base + ".tsx", base + ".ts", os.path.join(base, "index.tsx"), os.path.join(base, "index.ts")):
        if os.path.exists(c): return c
    return None
def file_consts(path):
    s = rd(path)
    c = {m.group(1): m.group(2) for m in re.finditer(r"\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['\"`](/api/v1[^'\"`$]*)['\"`]", s)}
    for m in re.finditer(r"\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$", s, re.M):
        if m.group(2) in c: c.setdefault(m.group(1), c[m.group(2)])
    return c
def consts_for(path):
    c = dict(file_consts(path))
    for m in web_imp_re.finditer(rd(path)):
        t = wresolve(path, m.group(1))
        if t:
            for k, v in file_consts(t).items(): c.setdefault(k, v)
    return c
def norm(p):
    p = re.sub(r"\$\{[^}]*\}", "{x}", p)
    p = re.sub(r"\$\{.*$", "{x}", p).split("?")[0]
    return "/".join("{x}" if "{x}" in seg else seg for seg in p.split("/"))
def export_bodies(path, names):
    """The source of just these exported functions/consts of a module (brace-balanced), or None if any is not found."""
    s = rd(path); parts = []
    for nm in names:
        if re.search(r"export\s+(?:type|interface|enum)\s+" + re.escape(nm) + r"\b", s): continue  # types carry no calls
        if re.search(r"export\s*\{[^}]*\b" + re.escape(nm) + r"\b[^}]*\}\s*from", s): continue  # re-export of a formatter or constant
        m = re.search(r"export\s+(?:default\s+)?(?:async\s+)?(?:function\s+" + re.escape(nm) + r"\s*[<(]|(?:const|let)\s+" + re.escape(nm) + r"\b[^=]*=)", s)
        if not m: return None
        i = m.end() - 1
        depth = 0; q = None; start = m.start(); n = len(s); opened = False
        while i < n:
            ch = s[i]
            if q:
                if ch == "\\": i += 2; continue
                if ch == q: q = None
            elif ch in "'\"`": q = ch
            elif ch in "([{": depth += 1; opened = True
            elif ch in ")]}":
                depth -= 1
                if depth == 0 and opened and (i + 1 >= n or not re.match(r"\s*(=>|\(|\.|\{)", s[i + 1:i + 4])): i += 1; break
            elif opened and depth == 0 and ch == "\n": break
            i += 1
        parts.append(s[start:i])
    return "\n".join(parts)

def calls_in(path, depth=1, seen=None, only=None):
    seen = seen if seen is not None else set()
    if not path or (path, only) in seen or not os.path.exists(path): return set()
    seen.add((path, only)); out = set()
    s = rd(path)
    if only:
        sub = export_bodies(path, only)
        if sub is not None: s = sub
    local = consts_for(path)
    def pre(pth): return re.sub(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: local.get(m.group(1), m.group(0)), pth)
    found = []
    for m in call_re.finditer(s):
        meth = "DELETE" if m.group(1) in ("del", "delete") else m.group(1).upper()
        raw = pre(m.group(3))
        # a literal followed by "+ ..." continues with either a query string or a path segment
        found.append((meth, [raw.rstrip("/") + "/{x}", raw] if re.match(r"\s*\+", s[m.end():]) else [raw]))
    for m in platform_re.finditer(s):
        found.append((("PUT" if not m.group(3) else m.group(3).upper()) if m.group(1) else "GET", ["/api/v1/admin/platform" + m.group(2)]))
    for m in concat_re.finditer(s):
        meth = "DELETE" if m.group(1) in ("del", "delete") else m.group(1).upper()
        found.append((meth, [local.get(m.group(2), "${" + m.group(2) + "}") + m.group(4)]))
    for m in fetch_re.finditer(s):
        mm = re.search(r"method:\s*['\"]([A-Z]+)['\"]", m.group(3) or "")
        found.append((mm.group(1) if mm else "GET", [pre(m.group(2))]))
    for meth, raws in found:
        ps = [norm(r) for r in raws]
        p = next((x for x in ps if x.startswith("/api/v1/") and match(meth, x[7:])), ps[0])
        if p.startswith("/api/v1/"): out.add((meth, p[7:], rel(path)))
        elif p.startswith("/") or p.startswith("{x}") or p.startswith("${"): out.add((meth, "DYNAMIC:" + p, rel(path)))
    for m in typedcall_re.finditer(s):
        out.add((m.group(1), re.sub(r"\{[A-Za-z_]+\}", "{x}", m.group(2)), rel(path)))
    if depth > 0:
        full = rd(path)
        for m in re.finditer(r"import\s+(?:type\s+)?([^;'\"]*?)\s+from\s+['\"]((?:\.{1,2}|@)/[^'\"]+)['\"]", full):
            spec, target = m.group(1), m.group(2)
            t = wresolve(path, target)
            if not t: continue
            tr = t.replace("\\", "/")
            if not (("/features/" in tr or "/lib/" in tr) and "lib/api" not in tr): continue
            named = re.search(r"\{([^}]*)\}", spec)
            has_default = bool(re.match(r"\s*[A-Za-z_$][\w$]*", spec)) or "* as" in spec
            names = None
            if named and not has_default:
                names = tuple(sorted({re.sub(r"^type\s+", "", x.strip()).split(" as ")[0].strip() for x in named.group(1).split(",") if x.strip()}))
            out |= calls_in(t, depth - 1, seen, names)
        for m in dyn_imp_re.finditer(full):
            t = wresolve(path, m.group(1))
            if t and "/features/" in t.replace("\\", "/"): out |= calls_in(t, depth - 1, seen)
    return out

route_by_key = {f"{r['method']} {r['path']}": r for r in routes}
for r in routes:
    # tables named in the handler itself; a handler that only delegates to a service falls back to the file's closure
    if r["htables"]: r["tables"], r["tsrc"] = r["htables"], "handler"
    else:
        own = file_tables.get(r["file"], set()) & TABLESET
        r["tables"], r["tsrc"] = sorted(own or route_tables.get(r["file"], set())), "file"
rows = []; missing = {}
for key, comp in registry.items():
    cpath = wresolve(os.path.join(W, "features", "x.ts"), "./" + comp)
    eps = set(); tbls = set(); files = set(); dynamic = set()
    for meth, p, src in sorted(calls_in(cpath, 2)):
        if src.startswith("web/src/lib/"): continue  # shared shell calls (session, bootstrap, pagers), not the feature's own
        if p.startswith("DYNAMIC:"):
            dynamic.add(f"{meth} {p[8:]}"); continue
        r = match(meth, p)
        if r:
            eps.add(f"{meth} {r['path']}"); files.add(r["file"]); tbls |= set(r["tables"])
        else:
            missing.setdefault(f"{meth} {p}", set()).add(src)
    f = features.get(key, {})
    rows.append(dict(key=key, role=f.get("role", ""), section=f.get("section", ""), name=f.get("name", ""),
                     in_catalog=key in features, screen="web/src/features/" + comp, screen_exists=cpath is not None,
                     endpoints=sorted(eps), route_files=sorted(files), tables=sorted(tbls), dynamic=sorted(dynamic)))

perm_bad = sorted({(r["perm"], r["file"], r["line"]) for r in routes if r["perm"] != "auth" and not r["perm"].startswith("IDENT:") and r["perm"] not in perms})
perm_ident = sorted({(r["perm"], r["file"], r["line"]) for r in routes if r["perm"].startswith("IDENT:")})
all_calls = set()
for f in glob.glob(os.path.join(W, "**", "*.ts*"), recursive=True):
    for meth, p, _ in calls_in(f, 0):
        if p.startswith("DYNAMIC:"): continue
        r = match(meth, p)
        if r: all_calls.add(f"{r['method']} {r['path']}")
uncalled = [r for r in routes if f"{r['method']} {r['path']}" not in all_calls]
referenced = set().union(*(file_tables[f] for f in file_tables)) & TABLESET
orphan_tables = sorted(TABLESET - referenced)
dups = collections.Counter((r["method"], r["path"]) for r in routes)
shadow = []
for r, rx in compiled:
    first = match(r["method"], re.sub(r"\{[A-Za-z_]+\}", "x", r["path"]))
    if first is not None and first is not r and first["path"] != r["path"]:
        shadow.append((f"{r['method']} {r['path']}", f"{r['file']}:{r['line']}", f"{first['path']} ({first['file']}:{first['line']})"))

OPEN_PREFIXES = ("/me", "/profile", "/portal", "/public", "/session", "/login", "/signup", "/store", "/help", "/assist", "/status")
auth_write = [r for r in routes if r["perm"] == "auth" and r["method"] != "GET" and not r["path"].startswith(OPEN_PREFIXES)]
out = dict(rows=rows, routes=routes, tables=tables, missing_routes={k: sorted(v) for k, v in missing.items()}, perm_bad=perm_bad, perm_ident=perm_ident,
           auth_write=auth_write,
           uncalled=uncalled, orphan_tables=orphan_tables, route_unknown=route_unknown,
           dup_routes=[f"{m} {p}" for (m, p), c in dups.items() if c > 1], shadowed=shadow,
           unbuilt=sorted(k for k in features if k not in registry),
           registry_not_in_catalog=sorted(k for k in registry if k not in features),
           missing_screen=[r["key"] for r in rows if not r["screen_exists"]],
           no_endpoint=[r["key"] for r in rows if not r["endpoints"]],
           counts=dict(features=len(features), built=len(registry), routes=len(routes), tables=len(TABLESET)))


# ---------- RENDER ----------
def render(out):
    c = out["counts"]
    L = []
    w = L.append
    w("# Feature map: screen, routes, tables")
    w("")
    w("Generated by `scripts/gen_feature_map.py` from the code. Do not edit by hand; rerun the script.")
    w("")
    w("| Layer | Source | Count |")
    w("|---|---|---|")
    w(f"| Catalogued features | web/src/catalog.gen.ts | {c['features']} |")
    w(f"| Built screens | web/src/features/registry.ts | {c['built']} |")
    w(f"| Worker routes | worker/src/routes/**, worker/src/index.ts | {c['routes']} |")
    w(f"| D1 tables (tenant + control) | worker/migrations/{{tenant,control}} | {c['tables']} |")
    w("")
    w("## Checks")
    w("")
    checks = [
        ("Screen calls a path no route serves", [f"`{k}` from {', '.join(v)}" for k, v in out["missing_routes"].items()]),
        ("Route guarded by a permission the seed does not define", [f"`{p}` at {f}:{l}" for p, f, l in out["perm_bad"]]),
        ("Route permission that could not be read from the source", [f"`{p}` at {f}:{l}" for p, f, l in out["perm_ident"]]),
        ("Two routes on one method and path", [f"`{x}`" for x in out["dup_routes"]]),
        ("Route that an earlier pattern always matches first", [f"`{a}` at {b}, shadowed by `{c_}`" for a, b, c_ in out["shadowed"]]),
        ("Registered screen whose file does not exist", [f"`{k}`" for k in out["missing_screen"]]),
        ("Registered screen with no catalogue entry", [f"`{k}`" for k in out["registry_not_in_catalog"]]),
        ("Built screen that calls no route", [f"`{k}`" for k in out["no_endpoint"]]),
        ("Table that no Worker code reads or writes", [f"`{t}` ({tables[t][0]}, {tables[t][1]})" for t in out["orphan_tables"]]),
        ("Name used as a table in route SQL that no migration creates", [f"`{t}` in {f}" for f, ts in out["route_unknown"].items() for t in ts]),
        ("Write route open to any signed-in user (permission `auth`) outside the self-service prefixes", [f"`{r['method']} {r['path']}` at {r['file']}:{r['line']}" for r in out["auth_write"]]),
    ]
    for title, items in checks:
        w(f"- **{title}:** {len(items)}")
        for it in items: w(f"  - {it}")
    w("")
    w(f"- **Catalogued features without a screen:** {len(out['unbuilt'])} (listed at the end; they render the catalogue placeholder).")
    w(f"- **Routes with no static caller in web/src:** {len(out['uncalled'])} (listed at the end; reached by mobile, the public site, cron or paths built at run time).")
    w("")
    w("## Built features")
    w("")
    w("Each feature: its screen, the routes the screen (and the modules it imports) calls, with the permission in brackets and the route's")
    w("file and line after the arrow, then the tables each route's handler names. A handler that only delegates to a service is marked")
    w("`(file)` and shows the tables of its whole route file and the services it imports. Calls made by the shared shell")
    w("(`web/src/lib`: session, bootstrap, pagers) are left out of every feature. Table lists are read statically from the")
    w("SQL a handler and the module-level helpers it names contain, so a helper shared by several handlers can add its tables to each.")
    w("")
    by_role = collections.OrderedDict()
    for r in sorted(out["rows"], key=lambda r: (r["role"], r["section"], r["name"])):
        by_role.setdefault(r["role"], collections.OrderedDict()).setdefault(r["section"], []).append(r)
    for role, secs in by_role.items():
        w(f"### {role_names.get(role, role)} (`{role}`)")
        w("")
        for sec, rs in secs.items():
            w(f"#### {section_names.get((role, sec), sec)}")
            w("")
            for r in rs:
                w(f"- **{r['name']}** `{r['key']}`")
                w(f"  - Screen: `{r['screen']}`")
                if r["endpoints"]:
                    w("  - Routes:")
                    for e in r["endpoints"]:
                        rt = route_by_key[e]
                        tl = ", ".join(f"`{t}`" for t in rt["tables"]) or "no table"
                        w(f"    - `{e}` [{rt['perm']}] -> {rt['file']}:{rt['line']}{' (file)' if rt['tsrc'] == 'file' else ''}: {tl}")
                if r["dynamic"]:
                    w("  - Paths built at run time (not matched): " + ", ".join(f"`{d}`" for d in r["dynamic"]))
                w("  - All tables: " + (", ".join(f"`{t}`" for t in r["tables"]) if r["tables"] else "none"))
            w("")
    w("## Catalogued features without a screen")
    w("")
    ub = collections.OrderedDict()
    for k in out["unbuilt"]:
        f = features[k]; ub.setdefault(f["role"], []).append(f"`{k}` {f['name']}")
    for role, items in ub.items():
        w(f"- **{role_names.get(role, role)}** ({len(items)}): " + "; ".join(items))
    w("")
    w("## Routes with no static caller in web/src")
    w("")
    uc = collections.OrderedDict()
    for r in sorted(out["uncalled"], key=lambda r: (r["file"], r["line"])):
        uc.setdefault(r["file"], []).append(f"`{r['method']} {r['path']}` [{r['perm']}]")
    for f, items in uc.items():
        w(f"- **{f}** ({len(items)}): " + ", ".join(items))
    w("")
    w("## Tables")
    w("")
    w("| Table | Scope | Created in | Route files that touch it |")
    w("|---|---|---|---|")
    users = collections.defaultdict(list)
    for f, ts in route_tables.items():
        for t in ts: users[t].append(f.replace("worker/src/routes/", ""))
    for t in sorted(tables):
        sc, mig = tables[t]
        w(f"| `{t}` | {sc} | {mig} | {', '.join(sorted(users.get(t, []))) or '-'} |")
    open(os.path.join(DOCS, "feature-map.md"), "w", encoding="utf-8", newline="\n").write("\n".join(L) + "\n")

    with open(os.path.join(DOCS, "feature-map.csv"), "w", encoding="utf-8", newline="") as fh:
        cw = csv.writer(fh)
        cw.writerow(["role", "section", "feature", "key", "screen", "method", "path", "permission", "route_file", "tables"])
        for r in sorted(out["rows"], key=lambda r: (r["role"], r["section"], r["name"])):
            if not r["endpoints"]:
                cw.writerow([r["role"], r["section"], r["name"], r["key"], r["screen"], "", "", "", "", ""])
            for e in r["endpoints"]:
                rt = route_by_key[e]
                cw.writerow([r["role"], r["section"], r["name"], r["key"], r["screen"], rt["method"], rt["path"], rt["perm"], rt["file"],
                             " ".join(rt["tables"])])


if __name__ == "__main__":
    render(out)
    print(out["counts"])
    for k in ("missing_routes", "perm_bad", "perm_ident", "dup_routes", "shadowed", "missing_screen", "registry_not_in_catalog", "no_endpoint", "orphan_tables", "unbuilt", "uncalled"):
        print(f"{k}: {len(out[k])}")
    print("unknown table names in route SQL:", sum(len(v) for v in out["route_unknown"].values()))
