# Build the signed release bundle for Google Play (Windows PowerShell 5.1+).
#
#   powershell -ExecutionPolicy Bypass -File playstore\build\build-aab.ps1
#   $env:PORTAL_URL = "https://staging.example.com"; ...   # optional override
#
# Needs: JDK 17 on PATH (or JAVA_HOME), Android SDK (ANDROID_HOME or
# mobile\apps\parent\local.properties), and
#   mobile\apps\parent\keystore.properties        (see KEYSTORE.md)
#   mobile\apps\parent\app\google-services.json   (Firebase; optional but wanted)
# Output: playstore\out\app-release.aab
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$App  = Join-Path $Root "mobile\apps\parent"
$Out  = Join-Path $Root "playstore\out"
$Portal = if ($env:PORTAL_URL) { $env:PORTAL_URL } else { "https://school-erp-cqj.pages.dev" }

if (-not (Test-Path (Join-Path $App "keystore.properties"))) {
  throw "missing $App\keystore.properties -- see playstore\build\KEYSTORE.md"
}
if (-not (Test-Path (Join-Path $App "app\google-services.json"))) {
  Write-Warning "no google-services.json -- the bundle will build but push notifications will not work"
}
if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw "java not found: install JDK 17" }

$gradle = Get-Content (Join-Path $App "app\build.gradle.kts") -Raw
$vc = [regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value
$vn = [regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
Write-Host "=== WISEN parent app  versionName=$vn versionCode=$vc  portal=$Portal ==="

Push-Location $App
try {
  & .\gradlew.bat --no-daemon clean bundleRelease "-PportalUrl=$Portal"
  if ($LASTEXITCODE -ne 0) { throw "gradle failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item (Join-Path $App "app\build\outputs\bundle\release\app-release.aab") (Join-Path $Out "app-release.aab") -Force
$size = (Get-Item (Join-Path $Out "app-release.aab")).Length / 1MB
Write-Host ("AAB: {0}\app-release.aab ({1:N2} MB)" -f $Out, $size)
Write-Host ""
Write-Host "Next: Play Console -> Testing -> Closed testing -> upload $Out\app-release.aab"
Write-Host "Then bump versionCode in app\build.gradle.kts before the next upload."
