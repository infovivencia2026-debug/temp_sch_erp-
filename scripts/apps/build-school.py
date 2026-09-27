#!/usr/bin/env python3
"""Build one school's own apps (Android, iPhone, Windows/Linux) from its address.

    python3 scripts/apps/build-school.py https://school.example.com/in/dps-noida
    python3 scripts/apps/build-school.py https://school.example.com/in/dps-noida --only android
    python3 scripts/apps/build-school.py https://... --only ios --team ABCDE12345

Nothing about a school lives in this repository. Everything comes from the
school's public <address>/app.json, which the seller edits in Tenants ->
Branding: name, store id, colours, logo, and the address the app opens. Change
it there and run this again; that is the whole update.

What needs a rebuild and what does not:
  * Screens, features, fixes: never. Every app shows the web portal, so a
    deploy reaches every installed app of every school.
  * Name, colours and logo inside the app: never. They come from the server.
  * Store name, launcher icon, store id: a rebuild with this script, then an
    upload. The store id must not change after the first upload.

Each shell is copied to dist/whitelabel/<slug>/<platform> and changed there,
so the tracked sources stay the WISEN app and no school is ever committed.
Icons are made with sips, so this runs on a Mac (the iPhone build needs one
anyway).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
ANDROID = ROOT / 'mobile/apps/parent'
IOS = ROOT / 'mobile/apps/parent-ios'
DESKTOP = ROOT / 'desktop'
SKIP = {'build', '.gradle', 'dist', 'node_modules', 'DerivedData', '.cxx', 'google-services.json'}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': 'wisen-build-school'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def copy(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=lambda _d, names: [n for n in names if n in SKIP])


PREPARE_ONLY = False


def run(cmd: list[str], cwd: Path, env: dict | None = None) -> None:
    print('  $', ' '.join(cmd))
    if PREPARE_ONLY:
        return
    subprocess.run(cmd, cwd=cwd, check=True, env={**os.environ, **(env or {})})


def icon(logo: Path | None, out: Path, size: int, pad: str, share: float) -> bool:
    """The school's logo centred on its main colour, share of the square wide. False without a logo."""
    if not logo:
        return False
    inner = max(1, round(size * share))
    tmp = out.with_suffix('.tmp.png')
    subprocess.run(['sips', '-s', 'format', 'png', '-Z', str(inner), str(logo), '--out', str(tmp)], check=True, capture_output=True)
    subprocess.run(['sips', '--padToHeightWidth', str(size), str(size), '--padColor', pad.lstrip('#'), str(tmp), '--out', str(out)],
                   check=True, capture_output=True)
    tmp.unlink()
    return True


def replace(path: Path, old: str, new: str) -> None:
    s = path.read_text()
    if old not in s:
        sys.exit(f'{path}: expected to find {old!r}; the shell changed, update build-school.py')
    path.write_text(s.replace(old, new, 1))


def android_env() -> dict:
    """JDK 17+ and the SDK, found where Homebrew and Android Studio put them when not set."""
    env = {}
    if not os.environ.get('JAVA_HOME'):
        for c in ['/opt/homebrew/opt/openjdk@17', '/opt/homebrew/opt/openjdk@21', '/opt/homebrew/opt/openjdk',
                  '/Applications/Android Studio.app/Contents/jbr']:
            home = Path(c) / 'libexec/openjdk.jdk/Contents/Home'
            home = home if home.exists() else Path(c) / 'Contents/Home'
            if (home / 'bin/java').exists():
                env['JAVA_HOME'] = str(home)
                break
    if not os.environ.get('ANDROID_HOME'):
        sdk = Path.home() / 'Library/Android/sdk'
        if sdk.exists():
            env['ANDROID_HOME'] = str(sdk)
    return env


def android(cfg: dict, work: Path, logo: Path | None, ver: tuple[int, str], args) -> None:
    app = work / 'android'
    copy(ANDROID, app)
    res = app / 'app/src/main/res'
    replace(res / 'values/strings.xml', '<string name="app_name">WISEN</string>',
            f'<string name="app_name">{escape(cfg["short_name"])}</string>')
    colors = res / 'values/colors.xml'
    s = colors.read_text()
    start = s.index('<color name="launcher_background">')
    end = s.index('</color>', start) + len('</color>')
    colors.write_text(s[:start] + f'<color name="launcher_background">{cfg["primary_color"]}</color>' + s[end:])
    # The foreground is 108dp with a 66dp safe circle; the logo fills 60% of it.
    for d, px in {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}.items():
        icon(logo, res / f'mipmap-{d}/ic_launcher_foreground.png', px, cfg['primary_color'], 0.6)
    if logo:
        icon(logo, res / 'mipmap-xxxhdpi/ic_launcher.png', 192, cfg['primary_color'], 0.8)
        # An opaque logo tile tinted by the wallpaper is a blank square, so no themed icon.
        adaptive = res / 'mipmap-anydpi-v26/ic_launcher.xml'
        adaptive.write_text('\n'.join(l for l in adaptive.read_text().splitlines() if '<monochrome' not in l) + '\n')
    if args.google_services:
        shutil.copy(args.google_services, app / 'app/google-services.json')
    props = [f'-PappId={cfg["app_id"]}', f'-PportalUrl={cfg["portal_url"]}', f'-PversionCode={ver[0]}', f'-PversionName={ver[1]}']
    if cfg.get('portal_aliases'):
        props.append('-PportalAliases=' + ','.join(cfg['portal_aliases']))
    run(['./gradlew', '--no-daemon', ':app:bundleRelease', ':app:assembleRelease', *props], app, android_env())
    out = work / 'out'
    for f in (app / 'app/build/outputs').rglob('*-release.a*'):
        shutil.copy(f, out / f'{cfg["app_id"]}-{ver[1]}{f.suffix}')


def ios(cfg: dict, work: Path, logo: Path | None, ver: tuple[int, str], args) -> None:
    app = work / 'ios'
    copy(IOS, app)
    host = cfg['portal_url'].split('://', 1)[1].split('/', 1)
    path = '/' + host[1] if len(host) > 1 else ''
    xc = app / 'Config/Portal.xcconfig'
    xc.write_text(xc.read_text() + f'''
// ---- {cfg["name"]}: written by scripts/apps/build-school.py ----
PORTAL_HOST = {host[0]}
PORTAL_URL = https:/$()/$(PORTAL_HOST){path}
PORTAL_ALIASES = {",".join(cfg.get("portal_aliases") or [])}
PRODUCT_BUNDLE_IDENTIFIER = {cfg["app_id"]}
MARKETING_VERSION = {ver[1]}
CURRENT_PROJECT_VERSION = {ver[0]}
DEVELOPMENT_TEAM = {args.team or ""}
''')
    replace(app / 'Config/Info.plist', '<key>CFBundleDisplayName</key>\n\t<string>WISEN</string>',
            f'<key>CFBundleDisplayName</key>\n\t<string>{escape(cfg["short_name"])}</string>')
    ios_icon = app / 'ParentApp/Assets.xcassets/AppIcon.appiconset/icon-1024.png'
    if icon(logo, ios_icon, 1024, cfg['primary_color'], 0.7):
        # The App Store refuses an icon with an alpha channel; a JPEG round trip drops it.
        jpg = ios_icon.with_suffix('.jpg')
        subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '100', str(ios_icon), '--out', str(jpg)], check=True, capture_output=True)
        subprocess.run(['sips', '-s', 'format', 'png', str(jpg), '--out', str(ios_icon)], check=True, capture_output=True)
        jpg.unlink()
    if not args.team and not PREPARE_ONLY:
        print('  iPhone: sources ready; pass --team <Apple team id> to archive and export as well')
        return
    archive = work / 'ios.xcarchive'
    proj = next(app.glob('*.xcodeproj'))
    run(['xcodebuild', '-project', proj.name, '-scheme', proj.stem, '-configuration', 'Release',
         '-destination', 'generic/platform=iOS', '-archivePath', str(archive), 'archive'], app)
    run(['xcodebuild', '-exportArchive', '-archivePath', str(archive), '-exportPath', str(work / 'out'),
         '-exportOptionsPlist', 'Config/ExportOptions.plist'], app)


def desktop(cfg: dict, work: Path, logo: Path | None, ver: tuple[int, str], args) -> None:
    app = work / 'desktop'
    copy(DESKTOP, app)
    (app / 'node_modules').symlink_to(DESKTOP / 'node_modules')
    shutil.copytree(DESKTOP / 'build', app / 'build')  # buildResources: the icon, not an output
    pkg = json.loads((app / 'package.json').read_text())
    pkg.update(productName=cfg['name'], author=cfg['name'], version=ver[1],
               portal=cfg['portal_url'], portalHosts=cfg.get('portal_aliases') or [])
    b = pkg['build']
    b.update(appId=cfg['app_id'], productName=cfg['name'], copyright=cfg['name'])
    b['directories']['output'] = str(work / 'out/desktop')
    if 'linux' in b:
        b['linux'].setdefault('desktop', {}).setdefault('entry', {})['StartupWMClass'] = cfg['name']
    (app / 'package.json').write_text(json.dumps(pkg, indent=2) + '\n')
    icon(logo, app / 'build/icon.png', 512, cfg['primary_color'], 0.75)
    run(['npx', 'electron-builder', '--linux', '--win'], app)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('address', help="the school's page, e.g. https://school.example.com/in/dps-noida")
    p.add_argument('--only', default='android,ios,desktop', help='comma-separated: android, ios, desktop')
    p.add_argument('--version-name', help='shown in the store; default is today, like 2026.9.27')
    p.add_argument('--team', help='Apple team id, for the iPhone archive')
    p.add_argument('--google-services', help="the school's google-services.json, for push on Android")
    p.add_argument('--prepare-only', action='store_true', help='write the per-school sources and icons, build nothing')
    args = p.parse_args()
    global PREPARE_ONLY
    PREPARE_ONLY = args.prepare_only

    base = args.address.rstrip('/')
    cfg = json.loads(fetch(base + '/app.json'))
    slug = base.rsplit('/', 1)[1]
    work = ROOT / 'dist/whitelabel' / slug
    (work / 'out').mkdir(parents=True, exist_ok=True)
    (work / 'app.json').write_text(json.dumps(cfg, indent=2))
    # versionCode only has to grow; the hour it was built always does.
    ver = (int(time.strftime('%y%m%d%H')), args.version_name or time.strftime('%Y.%-m.%-d'))
    print(f'{cfg["name"]}  ·  {cfg["app_id"]}  ·  {cfg["portal_url"]}  ·  {ver[1]} ({ver[0]})')

    logo = None
    if cfg.get('logo_url'):
        logo = work / 'logo'
        logo.write_bytes(fetch(cfg['logo_url']))
    else:
        print('  no logo set in Branding: the apps keep the WISEN icon')

    for name in [s.strip() for s in args.only.split(',') if s.strip()]:
        print(f'\n== {name}')
        {'android': android, 'ios': ios, 'desktop': desktop}[name](cfg, work, logo, ver, args)
    print(f'\nDone. Packages are in {work / "out"}')


if __name__ == '__main__':
    main()
