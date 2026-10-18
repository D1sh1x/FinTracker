import { readFile } from 'node:fs/promises';
import { chromium } from '../frontend/node_modules/@playwright/test/index.mjs';
import tls from 'node:tls';

const secretFile = process.argv[2] ?? '.local/vps-access.txt';
const access = Object.fromEntries((await readFile(secretFile, 'utf8')).trim().split(/\r?\n/).map(line => {
  const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
}));
const endpoint = new URL(access.url);
await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: endpoint.hostname, port: Number(endpoint.port || 443), rejectUnauthorized: true }, () => {
    const cert = socket.getPeerCertificate();
    console.log(JSON.stringify({ tlsVerified: socket.authorized, issuer: cert.issuer.O, subjectAltName: cert.subjectaltname, validTo: cert.valid_to }));
    socket.end(); resolve();
  });
  socket.setTimeout(15000, () => socket.destroy(new Error('TLS timeout')));
  socket.on('error', reject);
});
const browser = await chromium.launch({ headless: true });
try {
  const anonymous = await browser.newContext();
  for (const path of ['/', '/api/v1/profiles', '/health/ready', '/openapi.json']) {
    const response = await anonymous.request.get(access.url + path);
    if (response.status() !== 401) throw new Error('Anonymous access was not rejected: ' + path);
  }
  const redirect = await anonymous.request.get('http://' + endpoint.hostname + '/test?keep=1', { maxRedirects: 0, timeout: 10000 }).catch(() => null);
  const redirectVerified = redirect?.status() === 308 && redirect.headers().location === access.url + '/test?keep=1';
  if (!redirectVerified) {
    if (redirect?.headers().server?.toLowerCase().includes('caddy')) throw new Error('Caddy HTTP redirect failed');
    console.log('HTTP probe did not reach Caddy from this network; validate redirect on VPS separately.');
  }
  await anonymous.close();
  const context = await browser.newContext({ httpCredentials: { username: access.username, password: access.password }, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto(access.url);
  if (response.status() !== 200) throw new Error('Authenticated website unavailable');
  await page.locator('.welcome-content, .stat-value').first().waitFor();
  for (const path of ['/health/ready', '/openapi.json', '/api/v1/profiles']) {
    if ((await context.request.get(access.url + path)).status() !== 200) throw new Error('Authenticated API unavailable: ' + path);
  }
  const missing = await context.request.get(access.url + '/api/v1/missing');
  if (missing.status() !== 404 || !missing.headers()['content-type'].includes('application/json')) throw new Error('API fallback failed');
  if (errors.length || !await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw new Error('Browser runtime or mobile layout failure');
  console.log('Public HTTPS verified: trusted IP certificate, anonymous 401, authenticated website/API, mobile layout. External HTTP redirect verified: ' + redirectVerified + '. No financial records created.');
} finally { await browser.close(); }
