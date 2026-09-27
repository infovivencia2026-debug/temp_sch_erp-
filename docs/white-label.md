# White label: each school as its own product

One codebase, one server, one database layout. Each school gets its own
address, sign-in page, and Android, iPhone and desktop apps. No school is
written into the source: everything comes from Tenants → Branding.

## What the seller sets (Tenants → Branding)

| Setting | Where it shows |
|---|---|
| Name, colours, logo, headline, help contact | Sign-in page, inside the app, app icons |
| Country + web address | `https://<host>/<country>/<slug>` |
| Own domain (optional) | `/login` on that domain is the school's page |
| App id | Store id of the school's apps; set once, before the first upload |

## Updating: what needs what

| Change | What to do |
|---|---|
| Features, fixes, screens | Deploy the site. Every school's installed apps get it. |
| Name, colours, logo, words on the sign-in page | Save in Branding. Live at once, apps included. |
| Store name, launcher icon, app id | Run the build below, upload to the stores. |

## Building a school's apps

```
python3 scripts/apps/build-school.py https://<host>/in/<slug>            # all three
python3 scripts/apps/build-school.py https://<host>/in/<slug> --only android
python3 scripts/apps/build-school.py https://<host>/in/<slug> --only ios --team <APPLE_TEAM_ID>
python3 scripts/apps/build-school.py https://<host>/in/<slug> --prepare-only   # sources only
```

The script reads `<address>/app.json`, copies each shell to
`dist/whitelabel/<slug>/` (ignored by git), sets the name, id, address,
colour and icons there, and builds. Packages land in `dist/whitelabel/<slug>/out`.
The version code is the build hour, so it always goes up.

Needs: a Mac (icons use `sips`; the iPhone build needs Xcode), JDK 17 and the
Android SDK for Android, `desktop/node_modules` installed for desktop.

Push on Android needs the school's own `google-services.json` (Firebase keys
it to the app id): pass `--google-services <file>`. Without it the app builds
without push.

## Database changes (CONTROL D1)

`worker/db/changes/control_white_label.sql`, then `control_app_id.sql`.
