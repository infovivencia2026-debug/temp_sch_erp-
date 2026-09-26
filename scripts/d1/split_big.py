#!/usr/bin/env python3
"""Make a data.sql from pg_to_d1.py fit D1's statement size limit.

    python3 scripts/d1/split_big.py out/data.sql out/school_erp.db

D1 refuses any single SQL statement over 100,000 bytes (SQLITE_TOOBIG). A
row holding a long text or blob -- a retained import file, a large audit
detail -- becomes one INSERT bigger than that. Every such INSERT is rewritten
in place: the long values go in empty, and follow-up UPDATEs append them in
pieces keyed by the row's primary key. The file is also made re-runnable
(INSERT OR IGNORE), so a load that stopped half way can simply be run again.
The schema database is only read, for primary keys.
"""
import re
import sqlite3
import sys

LIMIT = 90_000          # bytes per statement, under D1's 100,000
PIECE = 30_000          # characters of a string literal per UPDATE


def literals(values: str):
    """Split the inside of VALUES ( ... ) into SQL literal tokens."""
    out, i, n = [], 0, len(values)
    while i < n:
        while i < n and values[i] in " ,\n":
            i += 1
        if i >= n:
            break
        if values[i] == "'" or (values[i] in "xX" and values[i + 1:i + 2] == "'"):
            j = i + (2 if values[i] in "xX" else 1)
            while True:
                j = values.index("'", j)
                if values[j + 1:j + 2] == "'":
                    j += 2
                    continue
                break
            out.append(values[i:j + 1])
            i = j + 1
        else:
            j = i
            while j < n and values[j] not in ",":
                j += 1
            out.append(values[i:j].strip())
            i = j
    return out


def main():
    path, dbpath = sys.argv[1], sys.argv[2]
    db = sqlite3.connect(dbpath)
    pks = {}
    for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        cols = sorted((r[5], r[1]) for r in db.execute(f'PRAGMA table_info("{t}")') if r[5])
        pks[t] = [c for _, c in cols]

    # Columns that point into their own table (users.pin_set_by -> users).
    # D1 checks a foreign key as each row lands, so a row naming a later row
    # fails; these go in empty and are filled in once every row exists.
    selfref = {}
    for t in pks:
        cols_ = [r[3] for r in db.execute(f'PRAGMA foreign_key_list("{t}")') if r[2] == t]
        if cols_:
            selfref[t] = cols_
    late = []

    data = open(path, encoding="utf-8").read()
    # Statements end with ");" or ";" at a line end; INSERT values may hold newlines.
    stmts = re.split(r"(?<=;)\n(?=INSERT |UPDATE |PRAGMA |$)", data)
    out, split = [], 0
    head = re.compile(r'^INSERT INTO "((?:[^"]|"")+)" \((.*?)\) VALUES \((.*)\);$', re.S)
    for st in stmts:
        if not st.strip():
            continue
        # Short-lived counters with no primary key: a re-run would duplicate
        # them, and they mean nothing on a new server.
        if st.startswith('INSERT INTO "rate_limit_hits"'):
            continue
        if st.startswith("INSERT INTO "):
            st = "INSERT OR IGNORE INTO " + st[len("INSERT INTO "):]
        mt = re.match(r'^INSERT OR IGNORE INTO "((?:[^"]|"")+)"', st)
        if mt and mt.group(1) in selfref and pks.get(mt.group(1)):
            m0 = head.match(st.replace("INSERT OR IGNORE INTO ", "INSERT INTO ", 1))
            if m0:
                tb = m0.group(1).replace('""', '"')
                cs = [c.strip().strip('"') for c in m0.group(2).split(",")]
                vs = literals(m0.group(3))
                if len(cs) == len(vs):
                    wh = " AND ".join(f'"{k}" = {vs[cs.index(k)]}' for k in pks[tb])
                    for col in selfref[tb]:
                        i2 = cs.index(col) if col in cs else -1
                        if i2 >= 0 and vs[i2] != "NULL":
                            late.append(f'UPDATE "{tb}" SET "{col}" = {vs[i2]} WHERE {wh};')
                            vs[i2] = "NULL"
                    st = f'INSERT OR IGNORE INTO "{tb}" ({", ".join(chr(34) + c + chr(34) for c in cs)}) VALUES ({", ".join(vs)});'
        if len(st.encode()) <= LIMIT:
            out.append(st)
            continue
        m = head.match(st.replace("INSERT OR IGNORE INTO ", "INSERT INTO ", 1))
        if not m:
            sys.exit(f"cannot parse oversized statement: {st[:120]}")
        table = m.group(1).replace('""', '"')
        cols = [c.strip().strip('"') for c in m.group(2).split(",")]
        vals = literals(m.group(3))
        if len(cols) != len(vals) or not pks.get(table):
            sys.exit(f"{table}: cannot split (columns {len(cols)} vs values {len(vals)}, primary key {pks.get(table)})")
        where = " AND ".join(f'"{k}" = {vals[cols.index(k)]}' for k in pks[table])
        tail = []
        for idx, v in enumerate(vals):
            if len(v.encode()) < 2_000 or cols[idx] in pks[table]:
                continue
            if v.startswith("'"):
                body = v[1:-1]
                vals[idx] = "''"
                # Pieces are cut on whole characters and never inside a doubled
                # quote. The first piece SETS the value and the rest append, so
                # running the file twice rebuilds the value instead of doubling it.
                k, first = 0, True
                while k < len(body):
                    end = min(k + PIECE, len(body))
                    while end < len(body) and body[k:end].count("'") % 2:
                        end += 1
                    piece = body[k:end]
                    rhs = f"'{piece}'" if first else f'"{cols[idx]}" || \'{piece}\''
                    tail.append(f'UPDATE "{table}" SET "{cols[idx]}" = {rhs} WHERE {where};')
                    k, first = end, False
            elif v[:2] in ("X'", "x'"):
                hexs = v[2:-1]
                vals[idx] = "X''"
                for n, k in enumerate(range(0, len(hexs), PIECE * 2)):
                    rhs = f"X'{hexs[k:k + PIECE * 2]}'" if n == 0 else f'"{cols[idx]}" || X\'{hexs[k:k + PIECE * 2]}\''
                    tail.append(f'UPDATE "{table}" SET "{cols[idx]}" = {rhs} WHERE {where};')
        cols_sql = ", ".join(f'"{c}"' for c in cols)
        out.append(f'INSERT OR IGNORE INTO "{table}" ({cols_sql}) VALUES ({", ".join(vals)});')
        out.extend(tail)
        split += 1
        for s in out[-len(tail) - 1:]:
            if len(s.encode()) > LIMIT:
                sys.exit(f"{table}: a piece is still over the limit")
    out.extend(late)
    open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"{path}: {split} oversized row(s) split, {len(late)} self-reference(s) deferred, {len(out)} statements")


if __name__ == "__main__":
    main()
