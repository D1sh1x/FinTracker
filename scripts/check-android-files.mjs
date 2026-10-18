import { _android } from '../frontend/node_modules/playwright/index.mjs';
import { expect } from '../frontend/node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';

const serial = process.env.ANDROID_TEST_SERIAL ?? 'emulator-5556';
const android = (await _android.devices()).find(device => device.serial() === serial);
if (!android || !serial.startsWith('emulator-')) throw new Error('This test requires the isolated Android emulator.');
const page = await (await android.webView({ pkg: 'app.fintrack.personal' })).page();
page.setDefaultTimeout(15000);
try {
  const config = await page.evaluate(() => window.Capacitor.Plugins.FintrackDevice.readConnection());
  if (config.url !== 'http://127.0.0.1:18091') throw new Error('Only the isolated API on 18091 may be tested.');
  const { profileId } = JSON.parse(await readFile('.local/android/test-profile.json', 'utf8'));
  await page.evaluate(id => { localStorage.setItem('fintrack-profile', id); location.hash = 'settings'; }, profileId);
  await page.reload();
  await android.shell('rm -f /sdcard/Download/fintrack-Android*.csv');
  await page.getByRole('button', { name: 'Экспортировать операции', exact: true }).click();
  await android.shell('uiautomator dump /sdcard/fintrack-window.xml');
  const windowXml = (await android.shell('cat /sdcard/fintrack-window.xml')).toString();
  const saveResource = windowXml.match(/resource-id="((?:android:id\/button1)|(?:[^"]*:id\/action_menu_save))"/);
  if (!saveResource) throw new Error('Android document save dialog not found: ' + windowXml.slice(0, 500));
  const saveNode = windowXml.match(new RegExp('<node[^>]*resource-id="' + saveResource[1] + '"[^>]*>'))[0];
  const [, left, top, right, bottom] = saveNode.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
  await android.shell(`input tap ${Math.floor((left + right) / 2)} ${Math.floor((top + bottom) / 2)}`);
  await expect.poll(async () => (await android.shell('cat /sdcard/Download/fintrack-Android*.csv')).toString()).toContain('Расход Android');
  const csv = (await android.shell('cat /sdcard/Download/fintrack-Android*.csv')).toString();
  if (!csv.includes('1250,50')) throw new Error('Native CSV save lost the exact amount');
  console.log('PASS: Android system save dialog wrote actual UTF-8 CSV to Downloads');
  await page.locator('.mobile-nav').getByRole('link', { name: 'Из скриншота', exact: true }).click();
  await page.getByRole('button', { name: 'Вставить из буфера', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(/буфер|изображен/);
  console.log('PASS: native empty-image clipboard returns an actionable error');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1400;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1080, 1400);
    context.fillStyle = '#252525'; context.font = 'bold 46px sans-serif'; context.fillText('История операций', 280, 135);
    context.font = 'bold 42px sans-serif'; context.fillText('Сегодня', 45, 280);
    context.font = '38px sans-serif'; context.fillText('Магнит', 190, 470); context.fillText('-250,00 ₽', 805, 470);
    context.font = '32px sans-serif'; context.fillStyle = '#888'; context.fillText('Продукты', 190, 525);
    context.fillStyle = '#252525'; context.font = '38px sans-serif'; context.fillText('Coffee Lab', 190, 720); context.fillText('-125,50 ₽', 805, 720);
    context.font = '32px sans-serif'; context.fillStyle = '#888'; context.fillText('Кафе', 190, 775);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile('.local/android/synthetic-bank.png', Buffer.from(png, 'base64'));
  await page.locator('input[type="file"]').setInputFiles({ name: 'android-bank.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByLabel('Дата съёмки скриншота').fill(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()));
  await page.getByRole('button', { name: 'Распознать скриншот', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Готов к проверке', exact: true })).toBeVisible({ timeout: 120000 });
  const imports = (await (await fetch(`http://127.0.0.1:18091/api/v1/profiles/${profileId}/imports`)).json()).items;
  const result = imports[0].result;
  if (result.rows.length !== 2 || !result.rows.some(row => row.amount_minor === '25000') || !result.rows.some(row => row.amount_minor === '12550')) throw new Error('Native screenshot upload/OCR did not preserve the synthetic transaction amounts');
  console.log('PASS: native multipart screenshot upload + OCR returned both exact expense amounts');
  await page.screenshot({ path: '.local/android/screenshots/import.png' });
  await android.screenshot({ path: '.local/android/screenshots/android-device.png' });
} finally {
  await android.close();
}
