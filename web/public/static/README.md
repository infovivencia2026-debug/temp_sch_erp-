# A mirror of `internal/static`, not a second copy to edit

`app.css` and the two Inter files here are byte-for-byte copies of
`internal/static/app.css` and `internal/static/fonts/*.woff2`. They exist so
that the sign-in, pricing and sideload pages — which the Go server renders and
which name `/static/app.css` — are dressed by a file the Cloudflare edge already
holds, instead of waking a Cloud Run instance for a stylesheet and two fonts on
every cold visit. `/static/` is therefore not in `SERVER_PATHS` in
`web/functions/[[path]].ts`, and not in `_routes.json`.

**Edit `internal/static/`, then copy here in the same commit.** `make
static-mirror` does the copy; `make lint` fails if the two directories have
drifted.

Why that matters more than it looks: the templates link
`/static/app.css?v=<hash of the embedded file>`, and `_headers` caches
`/static/*` immutably for a year. If the Go side changes and this mirror does
not, browsers ask for the *new* hash, the edge answers with the *old*
stylesheet, and that wrong answer is then pinned in every cache for a year. The
version query cannot save you here, because it is computed from the file the
server embedded rather than the one the edge serves.

The fonts are a different story — their names are stable and their bytes never
change — but they live here for the same reason and are copied by the same
command.
