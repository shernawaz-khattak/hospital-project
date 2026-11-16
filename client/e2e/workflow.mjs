// End-to-end UI workflow: one patient's journey through every department, driven entirely
// through the browser as the real users would do it. Run against a seeded demo database.
// Usage: BASE_URL=http://localhost:4000 node e2e/workflow.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@1234';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const step = (msg) => console.log(`✓ ${msg}`);
const suffix = Date.now().toString().slice(-5);
const PATIENT = { first: 'Workflow', last: `Tester${suffix}` };

async function as(username, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Karachi' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (e) => errors.push(`${username}: ${e.message}`));
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 500 && errors.push(`${username}: ${r.status()} ${r.url()}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  try {
    await fn(page);
  } catch (err) {
    const shot = path.join(os.tmpdir(), `workflow-failure-${username}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`Failed as ${username} on ${page.url()} — screenshot: ${shot}`);
    throw err;
  } finally {
    await ctx.close();
  }
}

let patientCode;
let slotFound = false;

// 1. Reception registers the patient and books a same-day appointment with Dr. Fatima (works daily 09:00-17:00).
await as('reception', async (page) => {
  await page.goto(`${BASE}/patients/new`);
  await page.getByLabel('First name').fill(PATIENT.first);
  await page.getByLabel('Last name').fill(PATIENT.last);
  await page.getByLabel('Date of birth').fill('1990-05-17');
  await page.getByLabel('Gender').selectOption('female');
  await page.getByLabel('Phone', { exact: true }).fill(`0345-55${suffix}`);
  await page.getByLabel('Allergies').fill('None known');
  await page.getByRole('button', { name: 'Register patient' }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Patient registered' });
  await dialog.waitFor();
  patientCode = (await dialog.locator('.font-sign.text-3xl').innerText()).trim();
  step(`Registered patient ${patientCode}`);
  await dialog.getByRole('button', { name: 'Book appointment' }).click();
  await page.waitForURL(/appointments\/book/);
  await page.getByText(PATIENT.last).first().waitFor();
  await page.getByLabel('Doctor').selectOption({ label: 'Dr. Fatima Noor — Emergency Physician' });
  const free = page.locator('[role="radiogroup"] button[aria-checked="false"]:not([disabled])');
  await page.waitForTimeout(800);
  if ((await free.count()) > 0) {
    slotFound = true;
    await free.first().click();
    await page.getByLabel('Reason for visit').fill('Fever and sore throat');
    await page.getByRole('button', { name: 'Confirm booking' }).click();
    await page.getByText('Appointment confirmed').waitFor();
    step('Booked a same-day appointment and received a token number');
  } else {
    console.log('! No free slot left today with Dr. Fatima — the clinical part of the journey is skipped.');
  }
});

if (slotFound) {
  // 2. Doctor consults: vitals, diagnosis, prescription, lab request.
  await as('dr.fatima', async (page) => {
    await page.goto(`${BASE}/doctor/schedule`);
    const row = page.locator('tr', { hasText: PATIENT.last });
    await row.getByRole('button', { name: 'Start consultation' }).click();
    await page.getByRole('button', { name: 'Start consultation' }).click();
    await page.waitForURL(/doctor\/visits\//);
    step('Doctor started the consultation');
    await page.getByLabel('Temp (°C)').fill('38.4');
    await page.getByLabel('Pulse (bpm)').fill('96');
    await page.getByLabel('BP systolic').fill('118');
    await page.getByLabel('BP diastolic').fill('76');
    await page.getByLabel('Symptoms').fill('Sore throat, fever for 2 days');
    await page.getByRole('button', { name: 'Record observations' }).click();
    await page.getByText('T 38.4°C').waitFor();
    step('Observations recorded');
    await page.getByLabel('Condition').fill('Acute pharyngitis');
    await page.getByLabel('Severity').selectOption('mild');
    await page.getByLabel('Notes', { exact: true }).fill('Inflamed pharynx, no exudate');
    await page.getByRole('button', { name: 'Add diagnosis' }).click();
    await page.getByText('Acute pharyngitis').waitFor();
    step('Diagnosis recorded');
    const panadol = await page.locator('select[aria-label="Medicine"] option', { hasText: 'Panadol 500 mg' }).first().getAttribute('value');
    await page.getByLabel('Medicine', { exact: true }).selectOption(panadol);
    await page.getByLabel('Dosage').fill('1 tablet');
    await page.getByLabel('Frequency').fill('Three times daily');
    await page.getByLabel('Days').fill('3');
    await page.getByLabel('Quantity').fill('9');
    await page.getByRole('button', { name: 'Send to pharmacy' }).click();
    await page.locator('text=/RX-\\d{4}-\\d{6}/').first().waitFor();
    step('Prescription sent to the pharmacy');
    await page.getByRole('button', { name: 'Request test' }).click();
    const dlg = page.getByRole('dialog', { name: 'Request lab test' });
    await dlg.getByLabel('Test').selectOption({ label: 'Complete Blood Count' });
    await dlg.getByLabel('Urgency').selectOption('urgent');
    await dlg.getByLabel('Clinical notes').fill('Fever, check WBC');
    await dlg.getByRole('button', { name: 'Send request' }).click();
    await page.getByText('Complete Blood Count').first().waitFor();
    step('Lab test requested');
    await page.getByRole('button', { name: 'Finish visit' }).click();
    await page.waitForURL(/doctor\/schedule/);
    step('Visit finished; appointment marked completed');
  });

  // 3. Pharmacist verifies and dispenses.
  await as('pharmacist', async (page) => {
    await page.goto(`${BASE}/pharmacy/prescriptions`);
    await page.locator('tr', { hasText: PATIENT.last }).first().click();
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.getByRole('button', { name: 'Issue medicines' }).click();
    await page.locator('header').getByText('Dispensed').waitFor();
    step('Pharmacist verified and issued the medicines; stock updated');
  });

  // 4. Lab processes and uploads a PDF report.
  await as('labtech', async (page) => {
    await page.goto(`${BASE}/lab/requests`);
    await page.locator('tr', { hasText: PATIENT.last }).first().click();
    await page.getByRole('button', { name: 'Start processing' }).click();
    await page.getByRole('button', { name: 'Mark test completed' }).click();
    await page.getByText('Upload report').first().waitFor();
    await page.getByLabel('WBC result').fill('13.2');
    await page.getByLabel('WBC flag').selectOption('high');
    const pdf = path.join(os.tmpdir(), `cbc-${suffix}.pdf`);
    fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    await page.locator('input[type=file]').setInputFiles(pdf);
    await page.getByRole('button', { name: 'Upload and notify' }).click();
    await page.locator('header').getByText('Reported').waitFor();
    step('Lab uploaded the report; doctor and patient notified');
  });

  // 5. Accountant bills and takes payment with a receipt.
  await as('accountant', async (page) => {
    await page.goto(`${BASE}/billing`);
    await page.getByLabel('Search patients').fill(PATIENT.last);
    await page.locator('tr', { hasText: PATIENT.last }).first().click();
    await page.getByText('Consultation fees').waitFor();
    await page.getByText('Laboratory charges').waitFor();
    await page.getByText('Medicine costs').waitFor();
    await page.getByRole('button', { name: 'Generate itemized bill' }).click();
    await page.waitForURL(/billing\/bills\//);
    step('Itemized bill generated with consultation, lab and medicine charges');
    await page.getByRole('button', { name: 'Record payment' }).click();
    const dlg = page.getByRole('dialog', { name: 'Record payment' });
    await dlg.getByRole('button', { name: 'Record payment' }).click();
    const receipt = page.getByRole('dialog', { name: /Receipt RCP-/ });
    await receipt.waitFor();
    await receipt.getByText('Remaining balance').waitFor();
    step('Payment recorded and receipt issued');
  });
}

// 6. Ward journey: admit -> doctor approves discharge -> blocked while unpaid -> bill & pay -> discharge.
let admissionUrl;
await as('reception', async (page) => {
  await page.goto(`${BASE}/admissions/new`);
  await page.getByLabel('Patient', { exact: true }).fill(PATIENT.last);
  await page.getByRole('option', { name: new RegExp(PATIENT.last) }).first().click();
  await page.getByLabel('Ward').selectOption({ label: (await page.locator('select option', { hasText: 'General Ward B (Female)' }).first().innerText()).trim() });
  await page.locator('[role="radiogroup"][aria-label="Bed"] button:not([disabled])').first().click();
  await page.getByLabel('Attending doctor').selectOption({ label: 'Dr. Fatima Noor — Emergency Physician' });
  await page.getByLabel('Reason for admission').fill('Observation for high fever');
  await page.getByRole('button', { name: 'Admit and assign bed' }).click();
  await page.waitForURL(/admissions\/\d+$/);
  admissionUrl = page.url();
  step('Patient admitted; bed assigned');
});
await as('dr.fatima', async (page) => {
  await page.goto(admissionUrl);
  await page.getByRole('button', { name: 'Approve discharge' }).click();
  await page.getByText(/Discharge approved by/).waitFor();
  step('Doctor approved the discharge');
});
await as('reception', async (page) => {
  await page.goto(admissionUrl);
  await page.getByRole('button', { name: 'Discharge', exact: true }).click();
  await page.getByText('Discharge is blocked: payment pending').waitFor();
  step('Discharge blocked while room charges are unbilled');
});
await as('accountant', async (page) => {
  await page.goto(`${BASE}/billing`);
  await page.getByLabel('Search patients').fill(PATIENT.last);
  await page.locator('tr', { hasText: PATIENT.last }).first().click();
  await page.getByText('Room charges').first().waitFor();
  await page.getByRole('button', { name: 'Generate itemized bill' }).click();
  const warn = page.getByRole('dialog', { name: 'Verify before generating' });
  if (await warn.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) await warn.getByRole('button', { name: 'Generate anyway' }).click();
  await page.waitForURL(/billing\/bills\//);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('dialog', { name: 'Record payment' }).getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('dialog', { name: /Receipt RCP-/ }).waitFor();
  step('Room charges billed and paid');
});
await as('reception', async (page) => {
  await page.goto(admissionUrl);
  await page.getByRole('button', { name: 'Discharge', exact: true }).click();
  await page.getByText('All bills are cleared').waitFor();
  await page.getByLabel('Condition at discharge').fill('Afebrile, stable');
  await page.getByLabel('Follow-up instructions').fill('Review in OPD in one week');
  await page.getByRole('dialog').getByRole('button', { name: 'Discharge patient' }).click();
  await page.getByRole('dialog', { name: 'Discharge summary' }).getByText('Afebrile, stable').waitFor();
  step('Patient discharged; discharge summary generated; bed freed');
});

// 7. Patient books through the portal.
await as(`P-${new Date().getFullYear()}-000002`, async (page) => {
  await page.goto(`${BASE}/portal/appointments`);
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await page.getByLabel('Doctor').selectOption({ label: 'Dr. Bilal Hussain — Pediatrician' });
  for (let i = 1; i <= 7; i++) {
    await page.getByRole('button', { name: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.now() + i * 86400000).getDay()], exact: true }).click();
    await page.waitForTimeout(600);
    if (await page.locator('[role="radiogroup"] button:not([disabled])').count()) break;
  }
  await page.locator('[role="radiogroup"] button:not([disabled])').first().click();
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await page.getByText('Appointment confirmed').waitFor();
  step('Patient booked an appointment through the portal');
});

// 8. Admin creates a staff account; the temporary password is shown once.
await as('admin', async (page) => {
  await page.goto(`${BASE}/admin/users`);
  await page.getByRole('button', { name: 'Add user' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add user' });
  await dlg.getByLabel('Username').fill(`acct${suffix}`);
  await dlg.getByLabel('Full name').fill('Test Accountant');
  await dlg.getByLabel('Email').fill(`acct${suffix}@hms.example`);
  await dlg.getByLabel('Role').selectOption('accountant');
  await dlg.getByRole('button', { name: 'Create user' }).click();
  await page.getByRole('dialog', { name: 'Temporary password' }).waitFor();
  step('Admin created a user and received a one-time temporary password');
});

await browser.close();
if (errors.length) {
  console.error(`Errors during the workflow:\n${errors.join('\n')}`);
  process.exit(1);
}
console.log('Workflow test passed.');
