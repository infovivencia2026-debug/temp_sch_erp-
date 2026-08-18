#!/usr/bin/env python3
"""Build the feature -> screen -> endpoint map that the simulation drives.

Nothing here is hand-maintained. The catalogue is the CSV, what is built comes
from the client's own component registry, and the endpoints come from reading
the components' source. A hand-written map would be a fourth place for the
truth to live and the first one to go stale.

Output: docs/feature_map.json, consumed by scripts/simulate.py.
"""
import csv
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web" / "src"

# Reuse the generator's own slug and role map rather than restating them. The
# keys here have to be byte-identical to the ones the client and server agreed
# on; a second copy would be a second thing to keep in step.
sys.path.insert(0, str(ROOT / "scripts"))
from gen_catalog import ROLE_KEYS, SCOPE_MAP, slug  # noqa: E402


def load_catalog():
    """The 470 rows, keyed the same way the client and server key them."""
    out = []
    with (ROOT / "docs" / "edu_features.csv").open() as fh:
        for row in csv.DictReader(fh):
            role = ROLE_KEYS.get(row["Role"].strip())
            if role is None:
                raise SystemExit(f"unmapped role: {row['Role']!r}")
            section, feature = slug(row["Section"]), slug(row["Feature"])
            out.append({
                "key": f"{role}.{section}.{feature}",
                "role": role,
                "role_label": row["Role"].strip(),
                "section": row["Section"].strip(),
                "feature": row["Feature"].strip(),
                "description": row["What User Sees & Does"].strip(),
                "scope": row["Data Scope"].strip(),
                "scope_key": SCOPE_MAP.get(row["Data Scope"].strip(), "unknown"),
            })
    return out


def load_registry():
    """feature key -> component path, straight from the client's own registry.

    Domains built in parallel hand over a `*keys*.ts` fragment beside their
    screens instead of all editing registry.ts, so the fragments are read too.
    Reading only registry.ts found the spread and none of the keys inside it,
    and every screen delivered that way was then reported as unbuilt.
    """
    pat = re.compile(r"'([a-z0-9_.]+)':\s*lazy\(\s*\(\)\s*=>\s*import\('\./([^']+)'\)")
    out = {}
    src = (WEB / "features" / "registry.ts").read_text()
    for key, path in pat.findall(src):
        out[key] = path
    for frag in sorted((WEB / "features").rglob("*keys*.ts")):
        # A fragment's imports are relative to its own directory, not to
        # registry.ts, so the path is rebuilt from where the fragment lives.
        base = frag.parent.relative_to(WEB / "features")
        for key, path in pat.findall(frag.read_text()):
            out[key] = f"{base}/{path}"
    return out


# Endpoints appear as string or template literals inside api.get/post/put/del.
# Template holes become :param — a probe cannot guess an id, but it can be told
# which ones need one.
# The type argument may itself be generic — api.get<List<ModuleSetting>>(...) —
# or an inline object with semicolons in it. Excluding only parentheses is what
# survives both; stopping at the first '>' or ';' silently dropped the call and
# the endpoint then looked like an unprobed GET, reported as a 405.
CALL = re.compile(
    r"api\.(get|post|put|del)\s*(?:<[^()]*?>)?\s*\(\s*[`'\"]([^`'\"]+)[`'\"]", re.S)
CALL_SIMPLE = CALL
ANY_PATH = re.compile(r"[`'\"](/api/v1/[^`'\"]*)[`'\"]")
# A screen that calls fetch directly — the CSV import posts text/csv, which the
# JSON helper cannot carry. Its verb is in the options object, so read it there
# instead of assuming a GET and reporting the resulting 405 as a fault.
RAW_FETCH = re.compile(
    r"fetch\(\s*[`'\"]([^`'\"]+)[`'\"][^)]*?method:\s*'([A-Z]+)'", re.S)


# A screen's endpoints are not all in its own file: the wizard's forms live in
# panels.tsx and the role picker in RolePicker.tsx. Following relative imports
# one level keeps a helper's endpoints attributed to the screen that shows them.
# Hyphens and .ts as well as .tsx: a module named ledger-lib.ts matched
# neither, so ten screens' endpoints were invisible and they were reported as
# static pages that call nothing.
RELATIVE_IMPORT = re.compile(r"from\s+'\.\/([A-Za-z0-9_-]+)'")


# A path built from a shared constant — `${ledgerBase}/trial-balance` — reads
# as a template hole, not as a path, so a whole module's endpoints vanished and
# ten screens were reported as having nothing to probe. Substituting the
# constant is the difference between "we cannot see it" and "it is not there".
CONST_PATH = re.compile(r"(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*'(/api/v1/[^']*)'")


def endpoints_for(component: str):
    """Read a component and report every API path it touches, with the verb."""
    path = WEB / "features" / (component + ".tsx")
    if not path.exists():
        return []
    src = path.read_text()
    for sibling in RELATIVE_IMPORT.findall(src):
        for ext in (".tsx", ".ts"):
            helper = path.parent / (sibling + ext)
            if helper.exists() and helper != path:
                src += "\n" + helper.read_text()

    # Resolve base-path constants, following the alias a module may re-export
    # them under, before any path is read out of the source.
    consts = dict(CONST_PATH.findall(src))
    for alias, target in re.findall(r"(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)\s*$",
                                    src, re.M):
        if target in consts:
            consts[alias] = consts[target]
    for name, value in consts.items():
        src = src.replace("${" + name + "}", value)
    # The declaration itself is a string literal starting /api/v1, so leaving it
    # in makes the bare base look like a route. It is a prefix, not an endpoint,
    # and probing it yields a 404 that says nothing about the screen.
    src = CONST_PATH.sub("", src)

    found = {}
    for verb, url in CALL.findall(src):
        if True:
            if not url.startswith("/api/v1"):
                continue
            found.setdefault(clean(url), set()).add(
                {"get": "GET", "post": "POST", "put": "PUT", "del": "DELETE"}[verb])

    for url, verb in RAW_FETCH.findall(src):
        if url.startswith("/api/v1"):
            found.setdefault(clean(url), set()).add(verb)

    # Anchors and form actions — a path the screen references but does not
    # reach through the api helper. Only counted when no api.* call already
    # claimed it, or every POST-only route would be recorded as a GET too and
    # a probe would report the resulting 405 as a broken feature.
    for url in ANY_PATH.findall(src):
        path = clean(url)
        if path not in found:
            found[path] = {"GET"}

    gated = conditional_paths(src)
    return [
        {"path": p, "methods": sorted(m), "conditional": p in gated}
        for p, m in sorted(found.items())
    ]


# A useQuery carrying `enabled:` does not always run. The homework composer and
# the circular composer both fetch staff-only lists, gated on the viewer being
# able to publish — so a family never issues those requests, and a probe that
# assumes they do records a 403 the product never produces.
QUERY_BLOCK = re.compile(r"useQuery\(\{(.*?)\}\)", re.S)


def conditional_paths(src: str) -> set:
    """Paths fetched only by a query that carries an `enabled:` guard."""
    out = set()
    for block in QUERY_BLOCK.findall(src):
        if "enabled:" not in block:
            continue
        for _verb, url in CALL.findall(block):
            if url.startswith("/api/v1"):
                out.add(clean(url))
    return out


def clean(url: str) -> str:
    """Reduce a template literal to a probeable path.

    A simple ${id} becomes :param. A ternary inside the hole — the query-string
    idiom `?${x ? `a=${x}` : ''}` — cannot be resolved by a regex and does not
    need to be: everything from that point is optional query, so the path ends
    there. Truncating is right where guessing would produce a URL that 404s and
    looks like a broken feature.
    """
    url = re.sub(r"\$\{[^{}]*\}", ":param", url)
    for cut in ("${", " "):
        if cut in url:
            url = url[: url.index(cut)]
    return url.split("?")[0].rstrip("/&?") or url


def main():
    catalog = load_catalog()
    registry = load_registry()

    for feat in catalog:
        component = registry.get(feat["key"])
        feat["component"] = component or ""
        feat["built"] = bool(component)
        feat["endpoints"] = endpoints_for(component) if component else []

    built = [f for f in catalog if f["built"]]
    unmapped = [f for f in built if not f["endpoints"]]

    out = ROOT / "docs" / "feature_map.json"
    out.write_text(json.dumps(catalog, indent=1))
    print(f"features: {len(catalog)}  built: {len(built)}  "
          f"screens: {len(set(f['component'] for f in built))}  "
          f"endpoints: {len(set(e['path'] for f in built for e in f['endpoints']))}")
    if unmapped:
        print("built but no endpoint found (static screens):",
              ", ".join(f["component"] for f in unmapped))


if __name__ == "__main__":
    main()
