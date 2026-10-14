import { chromium } from '../frontend/node_modules/@playwright/test/index.mjs'
import { mkdir } from 'node:fs/promises'

const address = process.argv[2] ?? 'http://127.0.0.1:8088'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  const external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(address).origin) external.push(request.url()) })
  const response = await page.goto(address)
  if (response.status() !== 200) throw new Error('Website is not ready')
  await page.locator('.welcome-content, .stat-value').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  const health = await page.request.get(address + '/health/ready')
  if (health.status() !== 200) throw new Error('API is not ready')
  const missing = await page.request.get(address + '/api/v1/missing')
  if (missing.status() !== 404 || !missing.headers()['content-type'].includes('application/json')) throw new Error('API fallback returned HTML')
  const contract = await page.request.get(address + '/openapi.json')
  if (contract.status() !== 200) throw new Error('OpenAPI is not served')
  if (errors.length || external.length) throw new Error(JSON.stringify({ errors, external }))
  await mkdir('.local/screenshots', { recursive: true })
  await page.screenshot({ path: '.local/screenshots/deployed-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw new Error('Mobile overflow')
  await page.screenshot({ path: '.local/screenshots/deployed-mobile.png', fullPage: true })
  console.log('Docker deployment verified: HTTP, API, OpenAPI, JSON 404, browser runtime, mobile layout, self-hosted assets')
} finally { await browser.close() }
