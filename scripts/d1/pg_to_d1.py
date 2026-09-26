#!/usr/bin/env python3
"""Copy a Postgres database into a SQLite file shaped for Cloudflare D1.

    python3 scripts/d1/pg_to_d1.py "$DATABASE_URL" out/

Produces, under out/:
    schema.sql     SQLite DDL (tables, primary keys, uniques, foreign keys,
                   plain indexes) in an order that satisfies foreign keys
    data.sql       one INSERT per row, same table order
    school_erp.db  a local SQLite database built from both, for checking
    report.md      what was carried over, what was dropped, and row counts

It needs only psql on PATH and the Python standard library. Nothing on the
Postgres side is modified: every query is a read.

WHAT DOES NOT CROSS. SQLite has no row-level security, no plpgsql, no
triggers written in plpgsql, no LISTEN/NOTIFY, no array or jsonb types, no
partial or expression indexes worth translating, and no CHECK expressions in
Postgres syntax. All of those are left behind and listed in report.md. The
River queue tables (river_*) and the goose version table are internal to the
Postgres deployment and are skipped on purpose.

TYPE MAPPING. uuid, text, citext, enums, inet, bit, dates and times -> TEXT.
Timestamps are written as UTC ISO-8601 with a trailing Z. Integers -> INTEGER.
Booleans -> INTEGER 0/1. numeric -> TEXT, so money keeps every digit (SQLite
REAL would round). jsonb -> TEXT holding JSON. Arrays -> TEXT holding a JSON
array. bytea -> BLOB. Generated columns become ordinary columns holding the
value Postgres computed at export time.
"""
import csv
import json
import io
import os
import re
import sqlite3
import subprocess
import sys
from collections import defaultdict

NULL = "\x01PGNULL\x01"   # sentinel psql writes for NULL; cannot appear in real text
SKIP_TABLE = re.compile(r"^(river_.*|goose_db_version)$")


def psql(url, sql):
    """Run one query, return rows as lists of strings (tab separated, unaligned)."""
    out = subprocess.run(
        ["psql", url, "-XAt", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql],
        check=True, capture_output=True, text=True).stdout
    return [line.split("\t") for line in out.splitlines()]


def q(name):
    return '"' + name.replace('"', '""') + '"'


def sqlite_type(data_type, udt):
    if udt in ("int2", "int4", "int8", "bool"):
        return "INTEGER"
    if udt == "bytea":
        return "BLOB"
    return "TEXT"  # uuid, text, citext, timestamps, dates, numeric, jsonb, arrays, enums, inet, bit


def export_expr(col, data_type, udt):
    """The SELECT expression that renders a column as the text SQLite will store."""
    c = q(col)
    if udt == "bool":
        return f"{c}::int"
    if udt == "timestamptz":
        return f"to_char({c} at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
    if udt == "timestamp":
        return f"to_char({c}, 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"
    if data_type == "ARRAY" or udt in ("jsonb", "json"):
        return f"to_jsonb({c})::text"
    if udt == "bytea":
        return f"encode({c}, 'hex')"
    return f"{c}::text"


def literal_default(d, udt):
    """Translate the few Postgres defaults SQLite can hold; anything else is dropped."""
    if d is None or d == "":
        return None
    d = d.strip()
    # Postgres filled ids and timestamps in by itself, and code written for it
    # leaves them out of INSERTs. SQLite can do the same with expression
    # defaults, in the formats the export writes.
    if d in ("now()", "CURRENT_TIMESTAMP", "transaction_timestamp()", "statement_timestamp()", "clock_timestamp()"):
        return "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))" if udt == "timestamptz" else "(strftime('%Y-%m-%dT%H:%M:%f','now'))"
    m_int = re.match(r"^\(now\(\) \+ '(\d+):(\d+):(\d+)'::interval\)$", d)
    if m_int:
        secs = int(m_int.group(1)) * 3600 + int(m_int.group(2)) * 60 + int(m_int.group(3))
        return f"(strftime('%Y-%m-%dT%H:%M:%fZ','now','+{secs} seconds'))"
    if d.startswith("ARRAY["):  # arrays are stored as JSON text
        items = [x.strip().split("::")[0] for x in d[6:d.rindex("]")].split(",") if x.strip()]
        vals = [json.dumps(x[1:-1]) if x.startswith("'") else x for x in items]
        return "'" + "[" + ",".join(vals) + "]" + "'"
    if d == "CURRENT_DATE":
        return "(date('now'))"
    if d == "gen_random_uuid()":
        return ("(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || "
                "substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || "
                "substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))")
    if d.startswith("nextval(") or "gen_random_uuid" in d or d.startswith("now()") or "CURRENT_" in d.upper():
        return None  # an expression SQLite cannot hold; recorded in the report
    if udt == "bool":
        return {"true": "1", "false": "0"}.get(d)
    m = re.match(r"^'(.*)'::[a-z_ \[\]]+$", d, re.S)
    if m:
        return "'" + m.group(1).replace("'", "''") + "'"
    if re.match(r"^-?\d+(\.\d+)?$", d):
        return d
    if d.startswith("'{}'::") or d in ("'{}'::jsonb", "'[]'::jsonb"):
        return "'{}'" if "{}" in d else "'[]'"
    if d.startswith("ARRAY[]"):
        return "'[]'"
    return None


def translate_index(definition, name, table, boolcols):
    """Postgres partial/expression btree index -> SQLite, or None."""
    if " USING btree " not in definition:
        return None
    d = definition.replace("public.", "")
    d = re.sub(r" USING btree ", " ", d)
    d = d.replace("CREATE UNIQUE INDEX " + name, "CREATE UNIQUE INDEX " + q(name)).replace(
        "CREATE INDEX " + name, "CREATE INDEX " + q(name))
    # casts: ::uuid, ::text[], ::timestamp with time zone, ::character varying
    d = re.sub(r"::(timestamp|time)( with(out)? time zone)?(\[\])?", "", d)
    d = re.sub(r"::(character varying|double precision)(\[\])?", "", d)
    d = re.sub(r"::\"?[a-z_][a-z0-9_]*\"?(\[\])?", "", d)
    # x = ANY (ARRAY['a', 'b']) -> x IN ('a', 'b');  <> ALL -> NOT IN
    for op, repl in (("= ANY", "IN"), ("<> ALL", "NOT IN")):
        d = re.sub(re.escape(op) + r" \(\(ARRAY\[([^\]]*)\]\)\)", repl + r" (\1)", d)
        d = re.sub(re.escape(op) + r" \(ARRAY\[([^\]]*)\]\)", repl + r" (\1)", d)
    d = d.replace("btrim(", "trim(").replace(" NULLS FIRST", "").replace(" NULLS LAST", "")
    if re.search(r"AT TIME ZONE|date_trunc|\bARRAY\b|@>|<@|&&|\bto_tsvector\b|\bimmutable_", d, re.I):
        return None
    if " WHERE " in d:
        head, where = d.split(" WHERE ", 1)
        for col in boolcols:
            where = re.sub(r'(?<![\w."])"?%s"?(?!\s*(=|<>|!=|IS\b|>|<|\w))' % re.escape(col),
                           f'"{col}" = 1', where)
        d = head + " WHERE " + where
    return d


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    url, out = sys.argv[1], sys.argv[2]
    # Optional third argument: one school's institution id. With it, every
    # table is cut down to that school's rows, for the database-per-school
    # layout. Without it, the whole database is copied as before.
    school = sys.argv[3] if len(sys.argv) == 4 else None
    if school and not re.fullmatch(r"[0-9a-f-]{36}", school):
        sys.exit("institution id must be a uuid")
    os.makedirs(out, exist_ok=True)
    dropped = defaultdict(list)

    # ---- tables and columns -------------------------------------------------
    tables = [r[0] for r in psql(url, """
        select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r' order by 1""")]
    tables = [t for t in tables if not SKIP_TABLE.match(t)]
    skipped = [t for t in tables if SKIP_TABLE.match(t)]
    for r in psql(url, "select table_name from information_schema.views where table_schema='public'"):
        dropped["views"].append(r[0])

    cols = defaultdict(list)
    for t, name, dt, udt, nullable, default, gen in psql(url, """
        select table_name, column_name, data_type, udt_name, is_nullable,
               coalesce(column_default,''), is_generated
        from information_schema.columns where table_schema='public'
        order by table_name, ordinal_position"""):
        if t in tables:
            cols[t].append(dict(name=name, dt=dt, udt=udt, null=nullable == "YES",
                                default=default, generated=gen == "ALWAYS"))
            if gen == "ALWAYS":
                dropped["generated columns (now plain, value frozen at export)"].append(f"{t}.{name}")
            if default and literal_default(default, udt) is None:
                dropped["column defaults the app must now supply"].append(f"{t}.{name} = {default}")

    # ---- constraints ----------------------------------------------------------
    pk, uniq, fks = {}, defaultdict(list), defaultdict(list)
    for t, ctype, name, colspec, ftable, fcols, ondel in psql(url, """
        select c.conrelid::regclass::text, c.contype, c.conname,
               (select string_agg(a.attname, ',' order by k.ord)
                  from unnest(c.conkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum),
               coalesce(c.confrelid::regclass::text,''),
               coalesce((select string_agg(a.attname, ',' order by k.ord)
                  from unnest(c.confkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum),''),
               c.confdeltype
        from pg_constraint c join pg_namespace n on n.oid=c.connamespace
        where n.nspname='public' and c.contype in ('p','u','f','c','x')
        order by 1,2,3"""):
        t = t.strip('"')
        if t not in tables:
            continue
        if ctype == "p":
            pk[t] = colspec.split(",")
        elif ctype == "u":
            uniq[t].append(colspec.split(","))
        elif ctype == "f":
            if SKIP_TABLE.match(ftable):
                dropped["foreign keys to skipped tables"].append(f"{t}.{name}")
                continue
            fks[t].append((colspec.split(","), ftable.strip('"'), fcols.split(","),
                           {"c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT", "r": "RESTRICT"}.get(ondel, "NO ACTION")))
        elif ctype == "c":
            dropped["check constraints (Postgres expressions)"].append(f"{t}.{name}")
        elif ctype == "x":
            dropped["exclusion constraints"].append(f"{t}.{name}")

    # ---- per-school scope -------------------------------------------------------
    # A table with institution_id keeps that school's rows plus shared rows
    # (institution_id NULL: system roles, catalogue entries). Platform staff
    # accounts (users with no school) are the exception: they belong to the
    # CONTROL database and never go into a school's copy. A table without
    # institution_id is scoped through its foreign key to a scoped parent,
    # recursively; a table with no path to a school is shared reference data
    # and is copied whole.
    scope = {}
    def scoped(t, seen=()):
        if t in scope:
            return scope[t]
        names = {c["name"] for c in cols[t]}
        cond = None
        if school and t == "institutions":
            cond = f"id = '{school}'"
        elif school and "institution_id" in names:
            cond = f"institution_id = '{school}'" if t == "users" else \
                f"(institution_id = '{school}' OR institution_id IS NULL)"
        elif school and t not in seen:
            for local, ft, remote, _ in sorted(fks[t], key=lambda f: any(
                    c["null"] for c in cols[t] if c["name"] in f[0])):
                if len(local) != 1 or ft not in tables or ft == t:
                    continue
                parent = scoped(ft, seen + (t,))
                if parent:
                    cond = (f"({q(local[0])} IN (SELECT {q(remote[0])} FROM {q(ft)} WHERE {parent})"
                            f" OR {q(local[0])} IS NULL)")
                    break
        scope[t] = cond
        return cond
    for t in tables:
        scoped(t)
    if school:
        dropped["tables copied whole into each school (no path to a school)"].extend(
            t for t in tables if scope[t] is None)

    # ---- indexes -------------------------------------------------------------
    # Plain btree indexes are copied as they are. Partial and expression
    # indexes (WHERE status = 'draft', COALESCE(campus_id, ...), lower(...))
    # carry uniqueness rules the application relies on, and SQLite supports
    # both, so they are translated: casts stripped, ANY(ARRAY[...]) -> IN,
    # bare boolean columns -> col = 1. Each translation is tried against the
    # local SQLite build below and kept only if SQLite accepts it; the rest
    # are listed in the report.
    indexes, translated = [], []
    boolcols = {t: {c["name"] for c in cols[t] if c["udt"] == "bool"} for t in tables}
    for t, name, definition in psql(url, """
        select tablename, indexname, indexdef from pg_indexes where schemaname='public'
        and indexname not in (select conname from pg_constraint) order by 1,2"""):
        if t not in tables:
            continue
        m = re.match(r"^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING btree \(([^()]*)\)$", definition)
        if m:
            columns = [c.strip().split(" ")[0].strip('"') for c in m.group(2).split(",")]
            indexes.append((t, name, bool(m.group(1)), columns))
            continue
        sql = translate_index(definition, name, t, boolcols[t])
        if sql:
            translated.append((t, name, definition, sql))
        else:
            dropped["indexes not translated (non-btree or untranslatable)"].append(f"{t}.{name}: {definition}")

    # ---- order tables so foreign keys point backwards --------------------------
    # SQLite does not check that a referenced table exists at CREATE time, so
    # every foreign key stays in the DDL. Ordering only matters for the INSERTs.
    # Where the graph has a cycle, the most-referenced table is placed next and
    # its not-yet-satisfiable *nullable* columns are loaded as NULL and filled
    # in by UPDATEs after every table is in. A NOT NULL back-edge, or one on a
    # table without a primary key, cannot be deferred and that FK is dropped.
    order, placed, deferred, dropped_fk = [], set(), defaultdict(list), []
    remaining = set(tables)
    nullable = {t: {c["name"] for c in cols[t] if c["null"]} for t in tables}
    while remaining:
        ready = sorted(t for t in remaining
                       if all(ft in placed or ft == t for _, ft, _, _ in fks[t]))
        if not ready:
            indeg = {t: sum(1 for u in remaining if u != t for _, ft, _, _ in fks[u] if ft == t)
                     for t in remaining}
            t = max(remaining, key=lambda x: (indeg[x], -sum(ft not in placed and ft != x
                                                             for _, ft, _, _ in fks[x]), x))
            kept = []
            for fk in fks[t]:
                local, ft, _, _ = fk
                if ft in placed or ft == t:
                    kept.append(fk)
                elif t in pk and all(c in nullable[t] for c in local) and not set(local) & set(pk[t]):
                    kept.append(fk); deferred[t].extend(local)
                else:
                    dropped_fk.append(f"{t}({','.join(local)}) -> {ft}")
            fks[t] = kept
            ready = [t]
        for t in ready:
            order.append(t); placed.add(t); remaining.discard(t)
    dropped["foreign keys dropped (NOT NULL cycle, undeferrable)"].extend(dropped_fk)
    dropped["foreign key columns loaded by a later UPDATE (cycle)"].extend(
        f"{t}.{c}" for t, cs in deferred.items() for c in cs)

    # ---- schema.sql -----------------------------------------------------------
    with open(os.path.join(out, "schema.sql"), "w") as f:
        f.write("-- Generated by scripts/d1/pg_to_d1.py. SQLite dialect for Cloudflare D1.\n")
        f.write("PRAGMA foreign_keys = ON;\n\n")
        for t in order:
            lines = []
            for c in cols[t]:
                line = f"  {q(c['name'])} {sqlite_type(c['dt'], c['udt'])}"
                if c["udt"] == "citext":
                    line += " COLLATE NOCASE"
                if not c["null"]:
                    line += " NOT NULL"
                d = literal_default(c["default"], c["udt"])
                if d is not None:
                    line += f" DEFAULT {d}"
                lines.append(line)
            if t in pk:
                lines.append("  PRIMARY KEY (" + ", ".join(q(c) for c in pk[t]) + ")")
            for u in uniq[t]:
                lines.append("  UNIQUE (" + ", ".join(q(c) for c in u) + ")")
            for local, ft, remote, ondel in fks[t]:
                lines.append("  FOREIGN KEY (" + ", ".join(q(c) for c in local) + f") REFERENCES {q(ft)} ("
                             + ", ".join(q(c) for c in remote) + f") ON DELETE {ondel}")
            f.write(f"CREATE TABLE {q(t)} (\n" + ",\n".join(lines) + "\n);\n\n")
        for t, name, unique, columns in indexes:
            f.write(f"CREATE {'UNIQUE ' if unique else ''}INDEX {q(name)} ON {q(t)} ("
                    + ", ".join(q(c) for c in columns) + ");\n")

    # ---- data.sql + local sqlite ----------------------------------------------
    dbpath = os.path.join(out, "school_erp.db")
    if os.path.exists(dbpath):
        os.remove(dbpath)
    db = sqlite3.connect(dbpath)
    db.executescript(open(os.path.join(out, "schema.sql")).read())
    # Foreign keys are checked once, after every row is in, so a broken
    # reference is reported by table instead of stopping the load midway.
    db.execute("PRAGMA foreign_keys = OFF")
    kept = []
    for t, name, definition, sql in translated:
        try:
            db.execute(sql)
            kept.append(sql)
        except sqlite3.Error as e:
            dropped["indexes not translated (SQLite refused)"].append(f"{t}.{name}: {e}: {definition}")
    with open(os.path.join(out, "schema.sql"), "a") as f:
        f.write("\n-- Partial and expression indexes translated from Postgres.\n")
        for sql in kept:
            f.write(sql + ";\n")
    dropped["partial/expression indexes translated (kept)"].extend(
        sql.split(" ON ")[0].split()[-1] for sql in kept)
    counts = {}
    with open(os.path.join(out, "data.sql"), "w") as f:
        f.write("PRAGMA defer_foreign_keys = ON;\n")
        updates = []
        for t in order:
            cs = cols[t]
            select = ", ".join(export_expr(c["name"], c["dt"], c["udt"]) for c in cs)
            copy = f"\\copy (select {select} from {q(t)}{' WHERE ' + scope[t] if scope.get(t) else ''}) to stdout with (format csv, null '{NULL}')"
            raw = subprocess.run(["psql", url, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", copy],
                                 check=True, capture_output=True, text=True).stdout
            n = 0
            names = ", ".join(q(c["name"]) for c in cs)
            placeholders = ", ".join("?" for _ in cs)
            batch = []
            late = set(deferred.get(t, ()))
            pkcols = pk.get(t, [])
            for row in csv.reader(io.StringIO(raw)):
                vals, lits = [], []
                keyvals, fixes = {}, []
                for c, v in zip(cs, row):
                    if c["name"] in late and v != NULL:
                        fixes.append((c["name"], "'" + v.replace("'", "''") + "'", v))
                        v = NULL
                    if c["name"] in pkcols:
                        keyvals[c["name"]] = v
                    if v == NULL:
                        vals.append(None); lits.append("NULL")
                    elif c["udt"] == "bytea":
                        vals.append(bytes.fromhex(v)); lits.append(f"X'{v}'")
                    elif c["udt"] in ("int2", "int4", "int8", "bool"):
                        vals.append(int(v)); lits.append(v)
                    else:
                        vals.append(v); lits.append("'" + v.replace("'", "''") + "'")
                batch.append(vals)
                f.write(f"INSERT INTO {q(t)} ({names}) VALUES ({', '.join(lits)});\n")
                for col, lit, v in fixes:
                    where = " AND ".join(f"{q(k)} = '{keyvals[k]}'" for k in pkcols)
                    updates.append((f"UPDATE {q(t)} SET {q(col)} = {lit} WHERE {where};",
                                    f"UPDATE {q(t)} SET {q(col)} = ? WHERE " +
                                    " AND ".join(f"{q(k)} = ?" for k in pkcols),
                                    [v] + [keyvals[k] for k in pkcols]))
                n += 1
            if batch:
                db.executemany(f"INSERT INTO {q(t)} ({names}) VALUES ({placeholders})", batch)
            counts[t] = n
            print(f"{t}: {n}", file=sys.stderr)
        for lit, stmt, args in updates:
            f.write(lit + "\n")
            db.execute(stmt, args)
    db.commit()
    fk_errors = db.execute("PRAGMA foreign_key_check").fetchall()
    db.close()

    # ---- verify against Postgres ------------------------------------------
    mismatches = []
    db = sqlite3.connect(dbpath)
    for t in order:
        pg_n = int(psql(url, f"select count(*) from {q(t)}" + (f" WHERE {scope[t]}" if scope.get(t) else ""))[0][0])
        sq_n = db.execute(f"select count(*) from {q(t)}").fetchone()[0]
        if pg_n != sq_n:
            mismatches.append((t, pg_n, sq_n))
    db.close()

    # ---- report ---------------------------------------------------------------
    with open(os.path.join(out, "report.md"), "w") as f:
        f.write("# Postgres to D1 export report\n\n")
        f.write(f"Tables copied: {len(order)}. Rows copied: {sum(counts.values())}.\n")
        f.write(f"Local SQLite size: {os.path.getsize(dbpath) / 1e6:.1f} MB (D1 limit is 10 GB per database).\n\n")
        f.write("## Verification\n\n")
        f.write("Row counts match Postgres for every table.\n" if not mismatches else
                "ROW COUNT MISMATCHES:\n" + "".join(f"- {t}: postgres {a}, sqlite {b}\n" for t, a, b in mismatches))
        if not fk_errors:
            f.write("Foreign keys check clean in SQLite.\n")
        else:
            by = defaultdict(int)
            for tbl, _rowid, parent, _i in fk_errors:
                by[(tbl, parent)] += 1
            f.write(f"FOREIGN KEY VIOLATIONS: {len(fk_errors)} rows point at a row that is not in this copy"
                    " (for a per-school copy: a link to another school's row). By table:\n")
            f.writelines(f"- {tbl} -> {parent}: {n}\n" for (tbl, parent), n in sorted(by.items()))
        f.write("\n## Not carried over\n\n")
        f.write("Row-level security policies, plpgsql functions, triggers, LISTEN/NOTIFY, "
                "and the River job queue have no SQLite equivalent and are not in schema.sql. "
                "Tenant scoping and the fee/payment trigger logic must be re-implemented in the "
                "application before anything writes to D1.\n\n")
        for k, v in sorted(dropped.items()):
            if v:
                f.write(f"### {k} ({len(v)})\n\n" + "".join(f"- {x}\n" for x in v) + "\n")
        f.write("## Row counts\n\n" + "".join(f"- {t}: {n}\n" for t, n in counts.items()))
    print(f"done: {len(order)} tables, {sum(counts.values())} rows, "
          f"{len(mismatches)} count mismatches, {len(fk_errors)} FK violations", file=sys.stderr)
    sys.exit(1 if mismatches or fk_errors else 0)


if __name__ == "__main__":
    main()
