#!/usr/bin/env python3
"""Precompute the assistant's answers, so the common question costs nothing.

    python3 scripts/gen_answers.py
        writes worker/src/routes/misc/assistant/help_answers_data.ts

Nearly every question a clerk asks is "how do I X" or "where is X", and the
catalogue already holds the answer to both: the sentence explaining what the
screen is for and the workspace and section it sits in. Assembling that is a
table lookup, and it is strictly more accurate than a model paraphrasing the
same sentence. matchHelp in worker/src/routes/misc/assistant.ts scores these
rows; anything it is not confident about goes to the model.

THE SOURCE IS THE LIVE CATALOGUE, NOT A SPREADSHEET. This used to read
docs/FEATURES.csv, a verification log that the catalogue moved away from, and
by 2026-09 it was sending staff to 177 screens that no longer existed. It now
reads web/src/catalog.gen.ts (itself generated from docs/edu_features.csv) and
keeps only features the SPA actually maps to a screen (the `*registry.ts` and
`*-keys.ts` files under web/src/features) -- the same two facts the sidebar is
built from. web/src/features/help-answers.test.ts fails if a row names a
screen that is not both catalogued and mapped, so a stale file cannot ship.
Run it (or `npm run feature:sync`) whenever the catalogue changes.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "web" / "src" / "catalog.gen.ts"
FEATURES = ROOT / "web" / "src" / "features"
OUT = ROOT / "worker" / "src" / "routes" / "misc" / "assistant" / "help_answers_data.ts"

# Mirrored by STOP/stem in worker/src/routes/misc/assistant.ts; keep in step.
STOP = {
    "a", "an", "the", "i", "how", "do", "does", "can", "to", "of", "in", "on",
    "for", "is", "are", "it", "my", "me", "we", "you", "where", "what", "and",
    "with", "from", "at", "by", "or", "be", "as", "this", "that", "if", "when",
    "there", "here", "want", "need", "please", "would", "should", "could",
}

SCOPE_TEXT = {
    "platform": "every school on the platform",
    "institution": "the whole school",
    "campus": "your campus",
    "department": "the departments you head",
    "assigned_classes": "the classes you teach",
    "self": "your own record",
    "children": "your own children",
}


def stem(w: str) -> str:
    """Drop a trailing plural s on longer words only (fee/fees), nothing more."""
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def words(s: str) -> list[str]:
    return [stem(w) for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP]


def ts_string(m: re.Match) -> str:
    """Decode a single-quoted TS string literal as catalog.gen.ts writes them."""
    return re.sub(r"\\(.)", r"\1", m)


def catalogue() -> list[dict]:
    """Every feature in catalogue order, with its role, section and workspace."""
    src = CATALOG.read_text(encoding="utf-8")
    body = src[src.index("export const ROLES"):]
    out: list[dict] = []
    role = None
    sec = None
    lit = r"'((?:[^'\\]|\\.)*)'"
    role_re = re.compile(r"^    key: " + lit + r",\n    name: " + lit, re.M)
    sec_re = re.compile(r"^        slug: " + lit + r",\n        name: " + lit + r",\n        workspace: " + lit, re.M)
    feat_re = re.compile(r"^          \{ key: " + lit + r", slug: " + lit + r", name: " + lit
                         + r", scope: " + lit + r", tier: " + lit + r", summary: " + lit + r" \},$", re.M)
    events = []
    for m in role_re.finditer(body):
        events.append((m.start(), "role", m))
    for m in sec_re.finditer(body):
        events.append((m.start(), "sec", m))
    for m in feat_re.finditer(body):
        events.append((m.start(), "feat", m))
    for _, kind, m in sorted(events, key=lambda e: e[0]):
        if kind == "role":
            role = ts_string(m.group(1))
        elif kind == "sec":
            sec = {"name": ts_string(m.group(2)), "workspace": ts_string(m.group(3))}
        else:
            key, _slug, name, scope, tier, summary = (ts_string(g) for g in m.groups())
            out.append({"key": key, "role": role, "name": name, "scope": scope, "tier": tier,
                        "summary": summary, "section": sec["name"], "workspace": sec["workspace"]})
    if len(out) < 100:
        raise SystemExit(f"parsed only {len(out)} features -- catalog.gen.ts layout has changed")
    return out


def mapped_keys() -> set[str]:
    """Keys the SPA maps to a screen: the same scan as catalog-keys.test.ts."""
    keys: set[str] = set()
    for p in FEATURES.rglob("*.ts"):
        if not (p.name.endswith("registry.ts") or p.name.endswith("-keys.ts")):
            continue
        src = p.read_text(encoding="utf-8")
        keys.update(re.findall(r"'([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)':\s*(?:screen|lazy)\(", src))
    return keys


def answer_for(f: dict) -> str:
    """What the screen does, where it is, and what it covers -- in that order."""
    where = " → ".join(dict.fromkeys([f["workspace"], f["section"], f["name"]]))
    parts = [f["summary"].rstrip(".") + "."]
    parts.append(f"You will find it in the sidebar under {where}.")
    if f["tier"] == "advanced":
        # Advanced screens are left off the sidebar (Shell.visibleFeatures) but
        # the search palette indexes every feature, so that is the way in.
        parts[-1] = f"It is not in the sidebar by default: search for \"{f['name']}\" (Ctrl+K). It lives under {where}."
    scope = SCOPE_TEXT.get(f["scope"])
    if scope:
        parts.append(f"It covers {scope}.")
    return " ".join(parts)


def main() -> None:
    live = mapped_keys()
    rows = []
    seen: set[tuple[str, str]] = set()
    for f in catalogue():
        # Optional features never appear in the sidebar (Shell.visibleFeatures).
        if f["key"] not in live or f["tier"] == "optional":
            continue
        if (f["role"], f["name"].lower()) in seen:
            continue
        seen.add((f["role"], f["name"].lower()))
        where_words = words(f["workspace"]) + words(f["section"])
        rows.append([
            f["role"], f["name"], f["workspace"], answer_for(f),
            sorted(set(words(f["name"]))),
            sorted(set(where_words)),
            sorted(set(words(f["name"]) + words(f["summary"]) + where_words)),
        ])
    rows.sort(key=lambda r: (r[0], r[1].lower()))
    out = [
        "// Generated by scripts/gen_answers.py from web/src/catalog.gen.ts and the SPA's screen registry. DO NOT EDIT.",
        "// [role, name, where, answer, nameWords, whereWords, terms]",
        "export type HelpAnswerRow = [string, string, string, string, string[], string[], string[]]",
        f"// {len(rows)} answers across {len(set(r[0] for r in rows))} roles.",
        "export const HELP_ANSWERS: HelpAnswerRow[] = " + json.dumps(rows, ensure_ascii=False),
        "",
    ]
    OUT.write_text("\n".join(out), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} — {len(rows)} answers")


if __name__ == "__main__":
    main()
