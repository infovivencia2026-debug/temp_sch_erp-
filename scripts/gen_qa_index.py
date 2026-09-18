#!/usr/bin/env python3
"""Generate a QA index page: every feature, grouped by role, as a clickable
deep-link with a tick box, so a tester can walk the whole product from one page.

Reads docs/edu_features.csv (the same source the catalog is built from) and
internal/api/implemented_gen.go (which features have a real screen behind them),
and writes web/public/qa/index.html — served statically by Cloudflare Pages at
/qa/, no login needed to view. Each link opens /<role>/<section>/<feature> in
the app (sign in first). Run: python scripts/gen_qa_index.py
"""
import csv, pathlib, re, html, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV = ROOT / "docs" / "edu_features.csv"
IMPL = ROOT / "internal" / "api" / "implemented_gen.go"
OUT = ROOT / "web" / "public" / "qa" / "index.html"

ROLE_KEYS = {
    "Super Admin": "super_admin", "Institution Admin / Principal": "institution_admin",
    "Faculty / Teacher": "faculty", "HOD / Department Head": "hod", "Librarian": "librarian",
    "Transport Manager": "transport_manager", "Student": "student", "Parent / Guardian": "parent",
    "Accounts & Finance": "finance", "Board / Trustee": "board_member",
    "Admissions & Front Office": "admissions", "Receptionist / Front Office": "front_office",
    "HR & Payroll": "hr", "Seller Admin": "seller_admin", "Examination Controller": "exam_controller",
    "IT Administrator": "it_admin", "Operations Staff": "operations", "Driver / Bus Attendant": "driver",
    "Nurse / Clinic": "nurse", "Counsellor": "counsellor", "Discipline Officer": "discipline_officer",
    "Hostel Warden": "hostel_warden", "Activity / Sports Coordinator": "activity_coord",
}

def slug(s):
    s = s.lower(); s = re.sub(r"[’'`]", "", s); s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")

impl = set(re.findall(r'"([a-z0-9_.]+)":\s*true', IMPL.read_text(encoding="utf-8")))

roles = {}  # role_name -> {sec_name -> [ (name, key, path, live) ]}
for r in csv.DictReader(CSV.open(encoding="utf-8", newline="")):
    role_name = r["Role"].strip(); rk = ROLE_KEYS.get(role_name)
    if not rk:
        continue
    sec = r["Section"].strip(); feat = r["Feature"].strip()
    key = f"{rk}.{slug(sec)}.{slug(feat)}"
    path = f"/{rk}/{slug(sec)}/{slug(feat)}"
    roles.setdefault(role_name, {}).setdefault(r["Workspace"].strip() + " · " + sec, []).append(
        (feat, key, path, key in impl))

total = sum(len(v) for r in roles.values() for v in r.values())
live = sum(1 for r in roles.values() for v in r.values() for f in v if f[3])

rows_html = []
for role_name in sorted(roles):
    secs = roles[role_name]
    n = sum(len(v) for v in secs.values())
    rows_html.append(f'<section class="role" data-role="{html.escape(role_name.lower())}"><h2>{html.escape(role_name)} <span class="count">{n}</span></h2>')
    for sec_name in secs:
        rows_html.append(f'<h3>{html.escape(sec_name)}</h3><ul>')
        for feat, key, path, is_live in secs[sec_name]:
            cls = "live" if is_live else "stub"
            tag = "" if is_live else '<span class="stub-tag">stub</span>'
            rows_html.append(
                f'<li class="{cls}" data-name="{html.escape((feat+" "+key).lower())}">'
                f'<input type="checkbox" data-k="{html.escape(key)}">'
                f'<a href="{html.escape(path)}" target="_blank" rel="noopener">{html.escape(feat)}</a>'
                f'{tag}<code>{html.escape(key)}</code></li>')
        rows_html.append('</ul>')
    rows_html.append('</section>')

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(f"""<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feature test index · School ERP</title>
<style>
:root{{--bg:#f7f8fa;--card:#fff;--fg:#111827;--muted:#6b7280;--border:#e5e7eb;--accent:#2563eb;--stub:#b45309}}
@media(prefers-color-scheme:dark){{:root{{--bg:#0a0a0a;--card:#141414;--fg:#fafafa;--muted:#9ca3af;--border:#262626;--accent:#3b82f6}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 'Inter',system-ui,-apple-system,'Segoe UI',sans-serif}}
header{{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--border);padding:16px;z-index:2}}
h1{{margin:0 0 4px;font-size:20px}}
.sub{{color:var(--muted);font-size:13px}}
.tools{{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}}
input[type=search],select{{padding:9px 12px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:inherit;font:inherit;min-height:40px}}
input[type=search]{{flex:1;min-width:160px}}
main{{padding:16px;max-width:900px;margin:0 auto}}
.role{{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px}}
h2{{font-size:16px;margin:0 0 8px;display:flex;align-items:center;gap:8px}}
.count{{font-size:12px;color:var(--muted);font-weight:500}}
h3{{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 6px}}
ul{{list-style:none;margin:0;padding:0}}
li{{display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--border);flex-wrap:wrap}}
li:last-child{{border-bottom:0}}
li a{{color:var(--accent);text-decoration:none;font-weight:500;flex:1;min-width:120px}}
li a:hover{{text-decoration:underline}}
li code{{font-size:11px;color:var(--muted);font-family:ui-monospace,monospace}}
li.done{{opacity:.5}}
.stub-tag{{font-size:10px;color:var(--stub);border:1px solid var(--stub);border-radius:5px;padding:0 5px}}
input[type=checkbox]{{width:20px;height:20px;flex:none}}
.hidden{{display:none}}
</style></head><body>
<header>
<h1>Feature test index</h1>
<div class="sub">{live} live features to click through · {total} catalogued. Sign in at <a href="/login">/login</a> first, then open each link (new tab). Ticks are saved on this device.</div>
<div class="tools">
<input type="search" id="q" placeholder="Filter by name or key…">
<select id="rolef"><option value="">All roles</option>{''.join(f'<option value="{html.escape(r.lower())}">{html.escape(r)}</option>' for r in sorted(roles))}</select>
<label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="liveonly">Live only</label>
</div></header>
<main>{''.join(rows_html)}</main>
<script>
try{{var saved=JSON.parse(localStorage.getItem('qa-done')||'{{}}');}}catch(e){{var saved={{}};}}
document.querySelectorAll('input[type=checkbox][data-k]').forEach(function(c){{
  if(saved[c.dataset.k]){{c.checked=true;c.closest('li').classList.add('done');}}
  c.addEventListener('change',function(){{saved[c.dataset.k]=c.checked;c.closest('li').classList.toggle('done',c.checked);
    try{{localStorage.setItem('qa-done',JSON.stringify(saved));}}catch(e){{}}}});
}});
function apply(){{
  var q=(document.getElementById('q').value||'').toLowerCase();
  var rf=document.getElementById('rolef').value;
  var lo=document.getElementById('liveonly').checked;
  document.querySelectorAll('.role').forEach(function(sec){{
    var roleMatch=!rf||sec.dataset.role===rf; var any=false;
    sec.querySelectorAll('li').forEach(function(li){{
      var ok=roleMatch&&(!q||li.dataset.name.indexOf(q)>=0)&&(!lo||li.classList.contains('live'));
      li.classList.toggle('hidden',!ok); if(ok)any=true;
    }});
    sec.classList.toggle('hidden',!any);
  }});
}}
document.getElementById('q').addEventListener('input',apply);
document.getElementById('rolef').addEventListener('change',apply);
document.getElementById('liveonly').addEventListener('change',apply);
</script></body></html>""", encoding="utf-8", newline="\n")
print(f"QA index: {live} live / {total} features across {len(roles)} roles -> {OUT}")
