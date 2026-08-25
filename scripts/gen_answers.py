#!/usr/bin/env python3
"""Precompute the assistant's answers, so the common question costs nothing.

    python3 scripts/gen_answers.py       # writes internal/api/help_answers_gen.go

WHY THIS EXISTS. The assistant took 88 seconds to answer "how do I collect a
fee". Measured on the box: one vCPU processes a prompt at ~50 tokens per second
and generates at ~13, and a RAG prompt here is eight retrieved chunks plus six
turns of history -- around 2,400 tokens, which is a minute of arithmetic before
a single word comes out. No amount of tuning closes a 30x gap. Two seconds
means either different hardware or not calling a model at all.

So: not calling a model. Nearly every question a clerk actually asks is "how do
I X" or "where is X", and the catalogue already holds the answer to both for
all 267 screens that exist -- the sentence explaining what the screen is for,
the workspace and section it sits in, and the data it can reach. Assembling
that is a table lookup. It is also strictly MORE accurate than a 1.5B model
paraphrasing the same sentence, because a paraphrase can be wrong and this
cannot: it is the catalogue, quoted.

The model is still there for everything else. This handles the head of the
distribution and hands the tail to the slow path, which is the right division
of labour when the head is most of the traffic and the tail is a clerk asking
something genuinely novel.

GENERATED INTO GO, not into a database. It follows internal/catalog/
catalog_gen.go exactly: the catalogue moves, so anything derived from it is
regenerated rather than migrated, and a help answer that drifts from the
product is worse than none -- it sends somebody to a screen that is not there
and spends the trust they would have extended to the next answer.
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "FEATURES.csv"
OUT = ROOT / "internal" / "api" / "help_answers_gen.go"

# Same mapping as gen_help.py, and it has to stay the same: the role a session
# reports is the key, and the catalogue names roles as a person would say them.
ROLE_KEYS = {
    "Accounts & Finance": "finance",
    "Admissions & Front Office": "admissions",
    "Faculty / Teacher": "faculty",
    "HR & Payroll": "hr",
    "Institution Admin / Principal": "institution_admin",
    "Parent / Guardian": "parent",
    "Seller Admin": "seller_admin",
    "Student": "student",
    "Super Admin": "super_admin",
}

# Words that carry no signal in "how do I collect a fee". Kept short on
# purpose: an aggressive stop list throws away "fee" in "fee book" and the
# match quality falls off a cliff. These are only the words that appear in
# almost every question anybody types.
STOP = {
    "a", "an", "the", "i", "how", "do", "does", "can", "to", "of", "in", "on",
    "for", "is", "are", "it", "my", "me", "we", "you", "where", "what", "and",
    "with", "from", "at", "by", "or", "be", "as", "this", "that", "if", "when",
    "there", "here", "want", "need", "please", "would", "should", "could",
}


def stem(w: str) -> str:
    """The crudest stemmer that fixes the actual failures.

    "How do I collect a fee" against a screen filed under the workspace "Fees"
    matched nothing, because fee != fees. Full stemming is not wanted here --
    it would collapse "billing" and "bill", which are different screens -- so
    this only drops a trailing plural s, and only on words long enough that
    doing so leaves something. Mirrored by helpStem in help_answers.go.
    """
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def words(s: str) -> list[str]:
    return [stem(w) for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP]


def go_string(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def answer_for(row: dict) -> str:
    """The reply, assembled from the catalogue rather than generated.

    Three sentences at most, in the order somebody needs them: what the screen
    does, where it is, and what it can see. A clerk with a parent at the counter
    wants the second one most and is not helped by a preamble.
    """
    name = (row.get("Feature") or "").strip()
    does = (row.get("What it does") or "").strip().rstrip(".")
    ws = (row.get("Workspace") or "").strip()
    sec = (row.get("Section") or ws).strip()
    scope = (row.get("Data scope") or "").strip()

    where = f"{ws} → {sec} → {name}" if sec and sec != ws else f"{ws} → {name}"
    parts = [f"{does}."]
    parts.append(f"You will find it in the sidebar under {where}.")
    if scope:
        parts.append(f"It covers: {scope.rstrip('.')}.")
    return " ".join(parts)


def main() -> None:
    seen: dict[tuple[str, str], dict] = {}
    rows: list[dict] = []

    with SRC.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            role = (row.get("Role") or "").strip()
            name = (row.get("Feature") or "").strip()
            if not role or not name:
                continue
            key = ROLE_KEYS.get(role)
            if not key:
                continue
            # One entry per role and screen. The CSV carries a row per
            # verification run, so the same screen appears more than once.
            if (key, name.lower()) in seen:
                continue
            seen[(key, name.lower())] = row

            # The workspace and section are part of what a screen IS, and they
            # carry the words people ask with: "Collect payment" never says
            # "fee" in its own name or description, and it lives under the Fees
            # workspace. Leaving them out was why "how do I collect a fee"
            # found a fee-structure config screen instead.
            terms = (words(name)
                     + words(row.get("What it does") or "")
                     + words(row.get("Workspace") or "")
                     + words(row.get("Section") or ""))
            if not terms:
                continue
            rows.append({
                "role": key,
                "name": name,
                "where": (row.get("Workspace") or "").strip(),
                "answer": answer_for(row),
                # Three tiers, not two, and the split matters.
                #
                # "where do I mark attendance" was answered with "My students",
                # because that screen sits in a section called Attendance and
                # mentions marking, so it collected two mid-weight hits while
                # the screen actually CALLED Attendance collected one. The name
                # of a thing identifies it; the area it lives in only narrows
                # the search. They cannot be worth the same.
                "namew": sorted(set(words(name))),
                "wherew": sorted(set(words(row.get("Workspace") or "")
                                    + words(row.get("Section") or ""))),
                "terms": sorted(set(terms)),
            })

    rows.sort(key=lambda r: (r["role"], r["name"].lower()))

    out: list[str] = []
    out.append("// Code generated by scripts/gen_answers.py from docs/FEATURES.csv. DO NOT EDIT.")
    out.append("")
    out.append("package api")
    out.append("")
    out.append("// helpAnswer is one screen, phrased as a reply.")
    out.append("//")
    out.append("// Three word tiers, because they carry different amounts of signal.")
    out.append("// NameW is the screen's own name, which identifies it. WhereW is the")
    out.append("// workspace and section, which only narrow the search. Terms is")
    out.append("// everything including the description. See matchHelp.")
    out.append("type helpAnswer struct {")
    out.append("\tRole   string")
    out.append("\tName   string")
    out.append("\tWhere  string")
    out.append("\tAnswer string")
    out.append("\tNameW  []string")
    out.append("\tWhereW []string")
    out.append("\tTerms  []string")
    out.append("}")
    out.append("")
    out.append(f"// {len(rows)} answers across {len(set(r['role'] for r in rows))} roles.")
    out.append("var helpAnswers = []helpAnswer{")
    for r in rows:
        namew = ", ".join(go_string(w) for w in r["namew"])
        wherew = ", ".join(go_string(w) for w in r["wherew"])
        terms = ", ".join(go_string(w) for w in r["terms"])
        out.append("\t{")
        out.append(f"\t\tRole:   {go_string(r['role'])},")
        out.append(f"\t\tName:   {go_string(r['name'])},")
        out.append(f"\t\tWhere:  {go_string(r['where'])},")
        out.append(f"\t\tAnswer: {go_string(r['answer'])},")
        out.append(f"\t\tNameW:  []string{{{namew}}},")
        out.append(f"\t\tWhereW: []string{{{wherew}}},")
        out.append(f"\t\tTerms:  []string{{{terms}}},")
        out.append("\t},")
    out.append("}")
    out.append("")

    OUT.write_text("\n".join(out), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} — {len(rows)} answers")


if __name__ == "__main__":
    main()
