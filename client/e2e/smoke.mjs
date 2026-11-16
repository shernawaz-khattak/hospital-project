// Browser smoke test: signs in through the UI as every role, opens every page that role can
// use, and fails on JavaScript errors, server errors or unexpected 4xx API responses.
// Usage: BASE_URL=http://localhost:4000 node e2e/smoke.mjs [--shots dir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@1234';
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const year = new Date().getFullYear();

const PLAN = {
  admin: ['/dashboard', '/admin/users', '/admin/roles', '/admin/doctors', '/admin/departments', '/admin/staffing', '/admin/staff', '/nursing/roster', '/admin/cancellations', '/reports/operational', '/reports/financial', '/billing/bills', '/wards', '/wards/board', '/system/audit', '/notifications'],
  reception: ['/dashboard', '/patients', '/patients/new', '/patients/1', '/appointments', '/appointments/book', '/waitlist', '/wards/board', '/admissions', '/admissions/new', '/wards'],
  'dr.sara': ['/dashboard', '/doctor/schedule', '/doctor/patients', '/doctor/patients/3', '/doctor/flagged', '/wards/board'],
  'dr.ahmed': ['/dashboard', '/doctor/patients/1'],
  labtech: ['/dashboard', '/lab/requests', '/lab/reports', '/lab/tests'],
  pharmacist: ['/dashboard', '/pharmacy/prescriptions', '/pharmacy/inventory', '/pharmacy/expiry', '/pharmacy/alerts'],
  accountant: ['/dashboard', '/billing', '/billing/bills', '/billing/insurance', '/reports/financial', '/billing/patients/3'],
  sysadmin: ['/dashboard', '/system/health', '/system/backups', '/system/notifications', '/system/audit'],
  [`P-${year}-000001`]: ['/portal', '/portal/appointments', '/portal/lab-reports', '/portal/bills', '/portal/records'],
};
// Deliberately forbidden pages must show the permission message, not data.
const FORBIDDEN = { reception: ['/admin/users', '/system/backups'], [`P-${year}-000001`]: ['/patients', '/billing/bills'] };

const problems = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

for (const [username, pages] of Object.entries(PLAN)) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let current = '';
  page.on('pageerror', (e) => problems.push(`[${username}] ${current}: JS error ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`[${username}] ${current}: console ${m.text()}`));
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    const forbiddenPage = (FORBIDDEN[username] ?? []).includes(current);
    if (r.status() >= 500 || (r.status() >= 400 && !forbiddenPage && !(r.status() === 403 && u.includes('/clinical/patients/')) && !u.includes('/auth/me'))) problems.push(`[${username}] ${current}: ${r.status()} ${r.request().method()} ${u.replace(BASE, '')}`);
  });

  current = '/login';
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10_000 }).catch(() => problems.push(`[${username}] login did not redirect`));

  for (const p of pages) {
    current = p;
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(300);
    const text = await page.locator('main').innerText().catch(() => '');
    if (/permission to view this page|Page not found|could not be loaded/i.test(text)) problems.push(`[${username}] ${p}: page shows an error state`);
    if (p === '/nursing/roster') {
      try {
        await page.getByRole('heading', { name: 'Nurse roster', exact: true }).waitFor({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Save roster', exact: true }).waitFor({ timeout: 10_000 });
      } catch {
        problems.push(`[${username}] ${p}: Nurse roster heading or save control was not visible`);
      }
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${username.replace(/[^\w.-]/g, '_')}${p.replace(/\//g, '_') || '_root'}.png`), fullPage: false });
  }
  for (const p of FORBIDDEN[username] ?? []) {
    current = p;
    await page.goto(`${BASE}${p}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    const text = await page.locator('main').innerText().catch(() => '');
    if (!/permission to view this page/i.test(text)) problems.push(`[${username}] ${p}: expected a permission message`);
  }
  await ctx.close();
}
await browser.close();

if (problems.length) {
  console.error(`Smoke test found ${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`Smoke test passed: ${Object.values(PLAN).flat().length} pages across ${Object.keys(PLAN).length} accounts, no errors.`);
