# Vivencia marketing site

The public front door: an industry picker ("one platform, five industries") with
a browsable prototype behind each vertical, built with Vite + React 18 +
react-router + Tailwind. Of the five verticals, education is the one that is a
shipped product — its card and the header both link to the live school ERP
sign-in at https://school-erp-cqj.pages.dev/login. The rest is prototype data
with no backend, and says so in its own footer.

## Why this is a separate build

This site does not share a bundle, a dependency tree or a deploy with `web/`
(the ERP application). It has its own `package.json` and its own lockfile on
purpose: the site carries recharts, lucide and a pile of webfonts that the
application has no reason to ship, and a copy change on the site must never
rebuild the app or grow the bundle that parents and teachers download on a
phone. Two Cloudflare Pages projects, two cost profiles, one repository.

## Build and preview

    cd site
    npm ci --no-audit --no-fund
    npm run build      # tsc -b && vite build -> site/dist
    npm run preview    # serves the built site on :4173
    npm run dev        # dev server on :5173

## Cloudflare Pages setup

The ERP app is the Pages project `school-erp`, built from `web/`. This is a
**new, second** project — do not point it at the existing one.

1. Cloudflare dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git.
2. Pick this same GitHub repository; production branch `main`.
3. Build settings:
   - Framework preset: none / Vite
   - Root directory: `site`
   - Build command: `npm ci --no-audit --no-fund && npm run build`
   - Output directory: `dist`
4. Environment variables (production and preview): `NODE_VERSION` = `22`.
5. Project name: `vivencia-site` (matches `site/wrangler.toml`).

`public/_headers` and `public/_redirects` are copied into `dist` by Vite and are
picked up by Pages automatically: caching plus the security headers, and the SPA
fallback that react-router needs.
