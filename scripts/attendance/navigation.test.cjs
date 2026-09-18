// Real local browser regression: navigation must commit without reloading the document.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(path.join(root, '.local/validation/node_modules/playwright'));
let browser;

(async () => {
  const credentials = JSON.parse(fs.readFileSync(path.join(root, '.local/test-login.json'), 'utf8'));
  const response = await fetch('http://127.0.0.1:54321/functions/v1/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
  });
  const session = await response.json();
  assert.ok(response.ok, session.error);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.addInitScript(token => localStorage.setItem('token', token), session.token);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  let renderLoopWarnings = 0;
  let userRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/maximum update depth|too many re-renders/i.test(message.text())) renderLoopWarnings++; });
  page.on('request', request => { if (/\/attendance\?user_id=/.test(request.url())) userRequests++; });
  await page.goto('http://127.0.0.1:3055/attendance');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Punch In/Out', exact: true }).waitFor();
  await page.evaluate(() => { window.navigationTestDocument = 'same-document'; });
  // Allow passive effects to settle so a repeated render cannot hide behind initial paint.
  await page.waitForTimeout(1000);
  assert.equal(renderLoopWarnings, 0, 'Attendance repeatedly updates state after every render');
  for (const [label, tab] of [['My History', 'myhistory'], ['Records', 'records'], ['Leaves', 'leaves'], ['By User', 'byuser']]) {
    await main.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(expected => new URL(location.href).searchParams.get('tab') === expected && [...document.querySelectorAll('main button')].some(b => b.textContent === ({myhistory:'My History',records:'Records',leaves:'Leaves',byuser:'By User'}[expected]) && b.classList.contains('btn-primary')), tab);
  }
  console.log('PASS attendance tab URL and selected content update together');
  const userChoice = main.getByPlaceholder('Type name, email, or department...').locator('..').getByRole('button').first();
  await Promise.all([
    page.waitForResponse(r => /\/attendance\?user_id=/.test(r.url()), { timeout: 30000 }),
    userChoice.click(),
  ]);
  await page.waitForTimeout(1000);
  assert.ok(userRequests <= 2, `By User refetched continuously (${userRequests} requests)`);
  console.log('PASS selected user data settles without a request loop');
  await page.locator('a[href="/employees"]').first().click();
  await main.getByRole('button', { name: 'Login-link help', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/employees');
  await page.goBack();
  await main.getByRole('button', { name: 'By User', exact: true }).waitFor();
  await page.goForward();
  await main.getByRole('button', { name: 'Login-link help', exact: true }).waitFor();
  for (const [search, href, heading] of [['Payroll', '/payroll', 'Payroll'], ['Roles & Permissions', '/admin/roles', 'Roles & Permissions']]) {
    await page.getByLabel('Search sidebar menu').fill(search);
    await page.locator(`a[href="${href}"]`).first().click();
    await main.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, href);
  }
  await page.getByLabel('Search sidebar menu').fill('Attendance');
  await page.locator('a[href="/attendance"]').first().click();
  await main.getByRole('button', { name: 'Punch In/Out', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.navigationTestDocument), 'same-document');
  assert.equal(renderLoopWarnings, 0);
  assert.deepEqual(errors, []);
  console.log('PASS sidebar, browser Back/Forward and Employees -> Payroll -> Roles -> Attendance work without a refresh');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
