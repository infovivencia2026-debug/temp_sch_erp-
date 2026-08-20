const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = path.join('C:', 'Users', 'sony', '.gemini', 'antigravity-ide', 'brain', '628779e7-3818-41a8-9bfe-0a8e1da23683', 'browser_screenshots');
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

const BASE_URL = 'https://temperp.187-127-178-100.sslip.io';
const personas = [
  { role: 'hod', email: 'hod@vivencia.test', pwd: '9' },
  { role: 'operations', email: 'operations@vivencia.test', pwd: '9' },
];

(async () => {
  console.log('=== Launching Google Chrome (Headed Mode) for Live User Testing ===');
  
  let browser;
  try {
    // Try launching installed Google Chrome browser directly
    browser = await chromium.launch({ 
      headless: false,
      channel: 'chrome',
      slowMo: 600 // Slow down actions by 600ms so user can watch Chrome in real-time
    });
    console.log('Successfully launched installed Google Chrome browser!');
  } catch (err) {
    console.log('Google Chrome channel unavailable, falling back to bundled Chromium browser...');
    browser = await chromium.launch({ 
      headless: false,
      slowMo: 600
    });
  }

  for (const item of personas) {
    console.log(`\n==================================================`);
    console.log(`Visually Testing Role in Google Chrome: ${item.role} (${item.email})`);
    
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 12000 });
      console.log(`  [Chrome] Opened Login Page: ${page.url()}`);
      
      await page.fill('input[name="identifier"]', item.email);
      await page.fill('input[name="password"]', item.pwd);
      await page.waitForTimeout(1000);
      await page.click('button[type="submit"]');
      
      await page.waitForTimeout(2500);
      const currentUrl = page.url();

      if (currentUrl.includes('/login')) {
        console.log(`  [LOGIN FAIL] ${item.role} could not log in.`);
        continue;
      }

      console.log(`  [LOGIN SUCCESS] ${item.role} -> ${currentUrl}`);
      await page.waitForTimeout(2000);

      // Extract workspace navigation sidebar links
      const navLinks = await page.$$eval('a', els => 
        els.map(e => ({ text: e.innerText.trim(), href: e.href }))
           .filter(e => e.text && e.text.length > 0 && e.text.length < 80 && e.href.startsWith('https://temperp.187-127-178-100.sslip.io') && !e.href.includes('/logout'))
      );

      const uniqueMap = new Map();
      navLinks.forEach(l => { if (!uniqueMap.has(l.href)) uniqueMap.set(l.href, l); });
      const uniqueLinks = Array.from(uniqueMap.values());

      console.log(`  Visually walking through ${uniqueLinks.length} workspace feature screens in Google Chrome...`);

      let count = 0;
      for (const link of uniqueLinks) {
        count++;
        try {
          await page.goto(link.href, { waitUntil: 'networkidle', timeout: 9000 });
          console.log(`    [Chrome Screen ${count}/${uniqueLinks.length}] "${link.text}" -> ${page.url()}`);
          await page.waitForTimeout(2000); // 2-second visual pause on every screen
        } catch (err) {
          console.log(`    [Nav Error] ${link.text}: ${err.message}`);
        }
      }

    } catch (err) {
      console.log(`  [ERROR] ${item.role}: ${err.message}`);
    } finally {
      await context.close();
    }
  }

  await browser.close();
  console.log('\n=== GOOGLE CHROME LIVE BROWSER AUDIT COMPLETE ===');
})();
