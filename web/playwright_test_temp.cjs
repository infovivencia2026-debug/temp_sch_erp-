const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = '/home/qb/.gemini/antigravity/brain/ddea119d-db6e-48c5-bc83-d23668e5daa4/artifacts/browser_screenshots';
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

const BASE_URL = 'http://localhost:5173';
const rolesToTest = [
  { role: 'hod', email: 'hod@vivencia.test', pwd: '9' },
  { role: 'operations', email: 'operations@vivencia.test', pwd: '9' },
  { role: 'institution_admin', email: 'institution_admin@vivencia.test', pwd: '9' },
  { role: 'super_admin', email: 'super_admin@vivencia.test', pwd: '9' },
  { role: 'seller_admin', email: 'seller_admin@vivencia.test', pwd: '9' },
  { role: 'faculty', email: 'faculty@vivencia.test', pwd: '9' },
  { role: 'finance', email: 'finance@vivencia.test', pwd: '9' },
  { role: 'admissions', email: 'admissions@vivencia.test', pwd: '9' },
  { role: 'hr', email: 'hr@vivencia.test', pwd: '9' },
  { role: 'student', email: 'student@vivencia.test', pwd: '9' },
  { role: 'parent', email: 'parent@vivencia.test', pwd: '9' },
];

(async () => {
  console.log('=== Launching Playwright Chromium Browser ===');
  const browser = await chromium.launch({ headless: true });
  const report = [];

  for (const item of rolesToTest) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      console.log(`\nTesting Role: ${item.role} (${item.email})`);
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
      
      // Fill login form
      await page.fill('input[name="identifier"]', item.email);
      await page.fill('input[name="password"]', item.pwd);
      await page.click('button[type="submit"]');
      
      await page.waitForTimeout(2000);
      const url = page.url();
      const title = await page.title();
      
      if (url.includes('/login')) {
        console.log(`  [LOGIN FAIL] ${item.role}: Still on login page (HTTP 401 Unauthorized)`);
        report.push({ role: item.role, status: 'LOGIN_FAILED', url });
      } else {
        console.log(`  [LOGIN OK] ${item.role}: Logged in successfully -> ${url}`);
        const screenshotPath = path.join(screenshotDir, `${item.role}_dashboard.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`  Captured Dashboard Screenshot: ${screenshotPath}`);
        
        // Find visible sidebar navigation links
        const navLinks = await page.$$eval('a', els => els.map(e => ({ text: e.innerText.trim(), href: e.href })).filter(e => e.text && e.text.length < 50));
        console.log(`  Found ${navLinks.length} workspace navigation items.`);

        // Click first 4 navigation links and take screenshots
        let clicked = 0;
        for (const link of navLinks.slice(0, 4)) {
          if (link.href && link.href.startsWith(BASE_URL)) {
            try {
              await page.goto(link.href, { waitUntil: 'networkidle', timeout: 8000 });
              clicked++;
              const pageTitle = await page.title();
              const subShot = path.join(screenshotDir, `${item.role}_screen_${clicked}.png`);
              await page.screenshot({ path: subShot });
              console.log(`    -> Screen ${clicked}: "${link.text}" (${page.url()}) -> Saved ${subShot}`);
            } catch (err) {
              console.log(`    Nav error on ${link.text}: ${err.message}`);
            }
          }
        }

        report.push({ role: item.role, status: 'SUCCESS', url, title, navCount: navLinks.length, screensCaptured: clicked });
      }
    } catch (e) {
      console.log(`  [ERROR] ${item.role}: ${e.message}`);
      report.push({ role: item.role, status: 'ERROR', error: e.message });
    } finally {
      await context.close();
    }
  }

  await browser.close();
  console.log('\n=== PLAYWRIGHT BROWSER LIVE UI TEST COMPLETE ===');
  console.log(JSON.stringify(report, null, 2));
})();
