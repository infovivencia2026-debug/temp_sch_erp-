const { chromium } = require('playwright');

const BASE_URL = 'https://temperp.187-127-178-100.sslip.io';

(async () => {
  console.log('===========================================================');
  console.log('  STARTING VISUAL LIVE DESKTOP UI TEST (WATCH YOUR SCREEN)');
  console.log('===========================================================');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 800, // 800ms slow motion so user can visually see every click and type!
    args: ['--start-maximized']
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // --- TOUR 1: HOD ACADEMIC WORKSPACE ---
  console.log('\n[1/2] Logging into HOD Academic Workspace...');
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(1000);

  await page.fill('input[name="identifier"]', 'hod@vivencia.test');
  await page.fill('input[name="password"]', '9');
  await page.waitForTimeout(800);
  await page.click('button[type="submit"]');

  await page.waitForTimeout(2000);
  console.log(' -> Landed on HOD Executive KPIs Dashboard!');

  const hodRoutes = [
    '/institution_admin/home/executive_kpis',
    '/institution_admin/home/needs_attention',
    '/institution_admin/home/today',
    '/institution_admin/home/department_kpis',
    '/institution_admin/home/academic_kpis',
    '/institution_admin/approvals/approvals_center',
    '/institution_admin/approvals/approvals'
  ];

  for (const route of hodRoutes) {
    console.log(`    -> Navigating to HOD Feature: ${route}`);
    await page.goto(`${BASE_URL}${route}`);
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
    await page.waitForTimeout(1500);
  }

  // --- TOUR 2: OPERATIONS WORKSPACE ---
  console.log('\n[2/2] Logging into Operations Manager Workspace...');
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[name="identifier"]', 'operations@vivencia.test');
  await page.fill('input[name="password"]', '9');
  await page.waitForTimeout(800);
  await page.click('button[type="submit"]');

  await page.waitForTimeout(2000);
  console.log(' -> Landed on Operations Transport Master Registry!');

  const opsRoutes = [
    '/institution_admin/transport/vehicle_master_registry',
    '/institution_admin/transport/driver_attendant_profiles',
    '/institution_admin/transport/route_pickup_stop_mapping',
    '/institution_admin/transport/student_route_assignment',
    '/institution_admin/transport/real_time_vehicle_tracking_vts',
    '/institution_admin/hostel/hostel_building_room_setup',
    '/institution_admin/hostel/room_allocation_engine',
    '/institution_admin/hostel/mess_menu_meal_management',
    '/institution_admin/library/book_cataloging_accession_register',
    '/institution_admin/library/book_issue_return_terminal',
    '/institution_admin/infirmary/student_health_master_file',
    '/institution_admin/stores/item_category_store_setup',
    '/institution_admin/stores/purchase_order_workflow'
  ];

  for (const route of opsRoutes) {
    console.log(`    -> Navigating to Operations Feature: ${route}`);
    await page.goto(`${BASE_URL}${route}`);
    await page.evaluate(() => window.scrollBy({ top: 350, behavior: 'smooth' }));
    await page.waitForTimeout(1800);
  }

  console.log('\n===========================================================');
  console.log('  VISUAL LIVE DESKTOP UI TOUR COMPLETED SUCCESSFULLY!');
  console.log('===========================================================');
  
  await page.waitForTimeout(5000);
  await browser.close();
})();
