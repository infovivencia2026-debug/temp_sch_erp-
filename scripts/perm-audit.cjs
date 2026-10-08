// Every screen a role can open × every write its buttons make × whether the role may make it.
const fs = require('fs'), path = require('path')
const ROOT = path.resolve(__dirname, '..')
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])

// 1. Server routes and the permission each one checks.
const routes = []
for (const f of walk(ROOT + '/worker/src/routes').filter((f) => f.endsWith('.ts'))) {
  const s = fs.readFileSync(f, 'utf8')
  const consts = {}
  for (const m of s.matchAll(/const\s+([A-Z_]+)\s*=\s*'([^']+)'/g)) consts[m[1]] = m[2]
  const perm = (x) => { x = x.trim(); const q = /^['"`]([^'"`]+)['"`]$/.exec(x); return q ? q[1] : consts[x] ?? '?' + x }
  for (const m of s.matchAll(/r\.(get|post|put|patch|del)\(\s*['`]([^'`]+)['`]\s*,\s*([^,)]+)/g)) routes.push({ method: m[1] === 'del' ? 'DELETE' : m[1].toUpperCase(), path: m[2], perm: perm(m[3]), file: path.basename(f) })
  for (const m of s.matchAll(/r\.typed\(\s*'([A-Z]+) ([^']+)'\s*,\s*([^,)]+)/g)) routes.push({ method: m[1], path: m[2], perm: perm(m[3]), file: path.basename(f) })
}
const rx = (p) => new RegExp('^' + p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}|\{[^}]+\}/g, '[^/]+') + '$')
for (const r of routes) r.re = rx(r.path)
const findRoute = (method, p) => routes.find((r) => r.method === method && r.re.test(p))

// 2. Screens and the writes their buttons make.
const reg = fs.readFileSync(ROOT + '/web/src/features/registry.ts', 'utf8')
const screens = [...reg.matchAll(/'([a-z_]+\.[a-z0-9_]+\.[a-z0-9_]+)':\s*screen\(\(\)\s*=>\s*import\('\.\/([^']+)'\)/g)].map((m) => ({ key: m[1], file: m[2] }))
const fileOf = (rel, from) => { for (const ext of ['.tsx', '.ts', '/index.tsx']) { const p = path.resolve(from, rel + ext); if (fs.existsSync(p)) return p } return null }
const writesOf = (() => {
  const cache = {}
  return (start) => {
    if (cache[start]) return cache[start]
    const seen = new Set(), calls = [], cans = new Set()
    const visit = (f, depth) => {
      if (!f || seen.has(f) || depth > 2) return; seen.add(f)
      const s = fs.readFileSync(f, 'utf8')
      for (const m of s.matchAll(/api\.(post|put|patch|del|delete)\s*(?:<[^()]*?>)?\(\s*[`'"]([^`'"]+)[`'"]/g)) calls.push({ method: m[1].startsWith('del') ? 'DELETE' : m[1].toUpperCase(), url: m[2], file: path.basename(f) })
      for (const m of s.matchAll(/api\.call\(\s*'(POST|PUT|PATCH|DELETE) ([^']+)'/g)) calls.push({ method: m[1], url: m[2], file: path.basename(f) })
      for (const m of s.matchAll(/can\(\s*'([^']+)'/g)) cans.add(m[1])
      for (const m of s.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) visit(fileOf(m[1], path.dirname(f)), depth + 1)
    }
    visit(fileOf('./' + start, ROOT + '/web/src/features'), 0)
    return (cache[start] = { calls, cans })
  }
})()

// 3. What each role holds by default.
const seed = fs.readFileSync(ROOT + '/worker/src/services/provision_seed.ts', 'utf8')
const roles = JSON.parse(/export const ROLES[^=]*=\s*(\[[\s\S]*?\])\s*\n/.exec(seed)[1])

const out = []
const unmatched = new Set()
for (const sc of screens) {
  const role = roles.find((r) => r.key === sc.key.split('.')[0])
  if (!role || !role.perms.includes(sc.key)) continue
  const { calls, cans } = writesOf(sc.file)
  for (const c of calls) {
    const p = c.url.replace(/^\/api\/v1/, '').replace(/\$\{[^}]*\}/g, 'X').split('?')[0]
    const r = findRoute(c.method, p)
    if (!r) { unmatched.add(c.method + ' ' + p); continue }
    if (['auth', 'public'].includes(r.perm) || r.perm.startsWith('?') || role.perms.includes(r.perm)) continue
    out.push({ role: role.key, screen: sc.key, call: `${c.method} ${r.path}`, needs: r.perm, gated: cans.has(r.perm), file: c.file })
  }
}
const uniq = [...new Map(out.map((o) => [o.role + o.screen + o.call, o])).values()]
const shown = uniq.filter((o) => !o.gated)
console.log('screens checked:', screens.length, '| mismatches:', uniq.length, '| of which button not hidden:', shown.length, '| routes:', routes.length, '| unmatched calls:', unmatched.size)
const byRole = {}; for (const o of shown) byRole[o.role] = (byRole[o.role] || 0) + 1



/* THE RULE (owner, 2026-10-08: "don't repeat things like this"): a role that
   can open a screen must be able to press its buttons, or not see them. A
   finding is either fixed (grant the permission, or hide the button behind
   can()) or, when the screen already hides it some other way, listed in
   scripts/perm-audit-allow.txt as "role<TAB>screen<TAB>call". Anything else
   fails the build. */
const allowFile = path.join(ROOT, 'scripts', 'perm-audit-allow.txt')
const allow = new Set((fs.existsSync(allowFile) ? fs.readFileSync(allowFile, 'utf8') : '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
const fresh = shown.filter((o) => !allow.has(`${o.role}\t${o.screen}\t${o.call}`))
if (process.argv.includes('--write-allow')) {
  fs.writeFileSync(allowFile, '# Buttons the audit flags that the screen already hides another way. role<TAB>screen<TAB>call\n' + shown.map((o) => `${o.role}\t${o.screen}\t${o.call}`).join('\n') + '\n')
  console.log('wrote', shown.length, 'lines to', allowFile)
} else if (fresh.length) {
  console.error(`\nperm-audit: ${fresh.length} button(s) a role can see but the server will refuse:`)
  for (const o of fresh) console.error(`  ${o.role} · ${o.screen} · ${o.call} needs ${o.needs} (${o.file})`)
  console.error('Grant the permission to the role, hide the button behind can(), or (if already hidden) add it to scripts/perm-audit-allow.txt.')
  process.exit(1)
} else console.log('perm-audit: ok')
