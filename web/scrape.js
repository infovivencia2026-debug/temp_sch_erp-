import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  console.log("Launching browser...");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  console.log("Navigating to localhost...");
  await page.goto('http://localhost:5174/');
  
  // Wait for the bento layout to render
  console.log("Waiting for bento cells...");
  await page.waitForSelector('.bento-cell', { timeout: 10000 }).catch(e => console.log("Timeout waiting for .bento-cell"));
  
  // Also wait a bit for any animations or data to load
  await page.waitForTimeout(2000);
  
  console.log("Getting HTML content...");
  const html = await page.content();
  
  // Write to artifact directory
  const artifactPath = '/home/qb/.gemini/antigravity/brain/5837127e-9bec-4000-9b07-84a59410a4fe/bento_home.html';
  fs.writeFileSync(artifactPath, html);
  console.log(`Saved to ${artifactPath}`);
  
  await browser.close();
})();
