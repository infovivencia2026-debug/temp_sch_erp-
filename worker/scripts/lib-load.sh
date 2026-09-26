# Shared by load-production.sh and switchover.sh. Source it from the worker/
# directory (both scripts cd there first). Needs: WR (the wrangler command),
# STAMP, NOW. Every function writes to Cloudflare only; nothing touches Neon.

# load_school <slug> <institution id> <export dir> <platform user ids...>
# Creates school-erp-<slug>-<STAMP>, moves TENANT_<SLUG> in wrangler.jsonc to
# it, applies db/tenant.sql, adds a stand-in row per platform account (rows in
# the school link to it; it cannot sign in there), loads data.sql (split for
# D1's 100 KB statement limit), and writes the school, plans, subscription
# and sign-ins into CONTROL. Sets LOADED_DB to the new database's name.
load_school() {
  local slug="$1" inst="$2" dir="$3"; shift 3
  local name="school-erp-$slug-$STAMP"
  local binding="TENANT_$(echo "$slug" | tr 'a-z-' 'A-Z_')"
  local db="$dir/school_erp.db"
  echo "== $slug -> $name"

  local id
  id="$($WR d1 create "$name" --location apac 2>&1 | grep -o '"database_id": *"[^"]*"' | cut -d'"' -f4)"
  [ -n "$id" ] || { echo "could not create $name" >&2; return 1; }
  python3 - "$binding" "$name" "$id" <<'PY'
import re, sys
b, n, i = sys.argv[1:]
s = open("wrangler.jsonc").read()
s = re.sub(r'    ,\{ "binding": "' + re.escape(b) + r'"[^\n]*\n', '', s)
line = f'    ,{{ "binding": "{b}", "database_name": "{n}", "database_id": "{i}" }}\n'
s = s.replace("    // TENANT_<slug> bindings are appended here", line + "    // TENANT_<slug> bindings are appended here", 1)
open("wrangler.jsonc", "w").write(s)
PY

  # Schema once: a database that already has it (an interrupted run) keeps it.
  local has
  has="$($WR d1 execute "$name" --remote --json --command "SELECT count(*) AS n FROM sqlite_master WHERE name='students'" 2>/dev/null | grep -o '"n": *[0-9]*' | grep -o '[0-9]*$' || true)"
  if [ "${has:-0}" = "0" ]; then
    $WR d1 execute "$name" --remote --yes --file=db/tenant.sql >/dev/null
  fi
  local pu
  for pu in "$@"; do
    $WR d1 execute "$name" --remote --yes --command \
      "INSERT OR IGNORE INTO users (id, institution_id, full_name, status, created_at, updated_at) VALUES ('$pu', NULL, 'Platform staff (signs in through CONTROL)', 'active', '$NOW', '$NOW')" >/dev/null
  done
  cp "$dir/data.sql" "$dir/data.split.sql"
  python3 ../scripts/d1/split_big.py "$dir/data.split.sql" "$db"
  $WR d1 execute "$name" --remote --yes --file="$dir/data.split.sql" | grep -E "Executed|rror"

  local ctl
  ctl="$(sqlite3 "$db" "
    SELECT printf('INSERT OR REPLACE INTO institutions (id,name,short_name,slug,status,timezone,locale,primary_color,logo_key,teacher_day_code_secret,d1_database_id,d1_binding,created_at,updated_at) VALUES (%Q,%Q,%Q,%Q,%Q,%Q,%Q,%Q,%Q,%s,%Q,%Q,%Q,%Q);',
      id,name,short_name,slug,status,timezone,locale,primary_color,logo_key,
      CASE WHEN teacher_day_code_secret IS NULL THEN 'NULL' ELSE 'X''' || hex(teacher_day_code_secret) || '''' END,
      '$id','$binding',created_at,updated_at) FROM institutions WHERE id='$inst';
    SELECT printf('INSERT OR REPLACE INTO plans (code,name,price_paise,price_monthly_paise,max_students,max_campuses,max_storage_gb,modules,sequence,custom_integration,retired_at) VALUES (%Q,%Q,%d,%s,%s,%s,%s,%Q,%d,%d,%Q);',
      code,name,price_paise,coalesce(price_monthly_paise,'NULL'),coalesce(max_students,'NULL'),coalesce(max_campuses,'NULL'),coalesce(max_storage_gb,'NULL'),modules,sequence,custom_integration,retired_at) FROM plans;
    SELECT printf('INSERT OR REPLACE INTO subscriptions (institution_id,plan_code,status,started_on,renews_on,trial_ends_on,licensed_students,agreed_price_paise,storage_gb,notes,updated_at) VALUES (%Q,%Q,%Q,%Q,%Q,%Q,%s,%s,%s,%Q,%Q);',
      institution_id,plan_code,status,started_on,renews_on,trial_ends_on,coalesce(licensed_students,'NULL'),coalesce(agreed_price_paise,'NULL'),coalesce(storage_gb,'NULL'),notes,updated_at) FROM subscriptions WHERE institution_id='$inst';
    SELECT printf('INSERT OR IGNORE INTO login_index (kind,value,institution_id,user_id,created_at) VALUES (%Q,%Q,%Q,%Q,%Q);', k, v, '$inst', id, created_at) FROM (
      SELECT 'email' k, email v, id, created_at FROM users WHERE institution_id='$inst' AND email IS NOT NULL AND email <> ''
      UNION ALL SELECT 'phone', phone, id, created_at FROM users WHERE institution_id='$inst' AND phone IS NOT NULL AND phone <> ''
      UNION ALL SELECT 'username', username, id, created_at FROM users WHERE institution_id='$inst' AND username IS NOT NULL AND username <> '');
  ")"
  # Exactly the snapshot: old sign-in and subscription rows go first.
  printf '%s\n%s\n' "DELETE FROM login_index WHERE institution_id = '$inst'; DELETE FROM subscriptions WHERE institution_id = '$inst';" "$ctl" > "$dir/control.sql"
  $WR d1 execute CONTROL --remote --yes --file="$dir/control.sql" | grep -E "Executed|rror"
  LOADED_DB="$name"
}

# load_platform <postgres url> <out file> <platform user ids...>
# Copies the platform staff accounts into CONTROL. The URL is opened
# read-only (Neon, or a local restore of a snapshot).
load_platform() {
  local url="$1" out="$2"; shift 2
  local ids; ids="$(printf "'%s'," "$@")"; ids="${ids%,}"
  PGOPTIONS='-c default_transaction_read_only=on' psql "$url" -XAt -v ON_ERROR_STOP=1 -c "
    SELECT format('INSERT OR REPLACE INTO platform_users (id,email,username,phone,full_name,password_hash,status,created_at,updated_at) VALUES (%L,%L,%L,%L,%L,%L,%L,%L,%L);
                   INSERT OR IGNORE INTO login_index (kind,value,institution_id,user_id,created_at) SELECT ''email'', %L, NULL, %L, %L WHERE %L IS NOT NULL;
                   INSERT OR IGNORE INTO login_index (kind,value,institution_id,user_id,created_at) SELECT ''username'', %L, NULL, %L, %L WHERE %L IS NOT NULL;',
      id, email, username, phone, full_name, password_hash, status, created_at, updated_at,
      email, id, created_at, email, username, id, created_at, username)
    FROM users WHERE id IN ($ids)
    UNION ALL
    -- Their platform roles (super_admin, seller_admin, support_admin): the
    -- Worker reads CONTROL.platform_user_roles to decide what they may do,
    -- and an account with none gets no permissions at all.
    SELECT format('INSERT OR IGNORE INTO platform_user_roles (user_id, role_key, created_at) VALUES (%L, %L, %L);',
      ur.user_id, r.key, ur.created_at)
    FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id IN ($ids) AND r.institution_id IS NULL" > "$out"
  $WR d1 execute CONTROL --remote --yes --file="$out" | grep -E "Executed|rror"
}

# verify_counts <d1 database name> <local sqlite export> <extra users>
# Compares every table's row count in D1 with the export's. <extra users> is
# the number of platform stand-in rows added to users on D1 only. Returns 1
# and prints the differences if any table differs.
verify_counts() {
  local name="$1" db="$2" extra="$3" tables t sql out
  tables="$(sqlite3 "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")"
  : > "$db.expected"; : > "$db.actual"
  for t in $tables; do
    echo "$t $(sqlite3 "$db" "SELECT count(*) FROM \"$t\"")" >> "$db.expected"
  done
  # 40 tables per query keeps the statement well under D1's limits.
  echo "$tables" | xargs -n 40 | while read -r chunk; do
    sql=""
    for t in $chunk; do
      [ -n "$sql" ] && sql="$sql UNION ALL "
      sql="${sql}SELECT '$t' AS t, count(*) AS n FROM \"$t\""
    done
    out="$($WR d1 execute "$name" --remote --json --command "$sql")"
    printf '%s' "$out" | python3 -c '
import json, sys
for r in json.load(sys.stdin)[0]["results"]:
    print(r["t"], r["n"])' >> "$db.actual"
  done
  python3 - "$db.expected" "$db.actual" "$extra" <<'PY'
import sys
exp = dict(l.split() for l in open(sys.argv[1]) if l.strip())
act = dict(l.split() for l in open(sys.argv[2]) if l.strip())
extra = int(sys.argv[3])
bad = []
for t, n in exp.items():
    want = int(n) + (extra if t == "users" else 0)
    got = act.get(t)
    if got is None or int(got) != want:
        bad.append(f"  {t}: snapshot {want}, D1 {got}")
print(f"  {len(exp)} tables compared")
if bad:
    print("COUNTS DIFFER:"); print("\n".join(bad)); sys.exit(1)
PY
}
