import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spec = JSON.parse(await readFile(path.join(root, 'api/openapi.json'), 'utf8'))
const folder = path.join(root, 'postman/collections/FinTrack API/Smoke')
const profile = '/api/v1/profiles/{p}'
const expense = { id: '{{expense_id}}', type: 'expense', amount_minor: '125050', category_id: '{{expense_category}}', occurred_on: '{{today}}', note: 'Продукты на неделю' }
const cases = [
  ['Create profile', 'POST', '/api/v1/profiles', 201, { id: '{{profile_id}}', name: 'Проверка API' }],
  ['Categories', 'GET', profile + '/categories', 200, undefined, `const categories = pm.response.json().items; pm.collectionVariables.set('expense_category', categories.find(c => c.name === 'Продукты').id); pm.collectionVariables.set('income_category', categories.find(c => c.name === 'Зарплата').id); pm.test('13 initial categories', () => pm.expect(categories).to.have.length(13));`],
  ['Opening balance', 'PATCH', profile + '/wallet', 200, { opening_balance_minor: '1000000', version: 1 }],
  ['Income', 'POST', profile + '/transactions', 201, { id: '{{income_id}}', type: 'income', amount_minor: '3000000', category_id: '{{income_category}}', occurred_on: '{{today}}', note: 'Зарплата' }],
  ['Expense', 'POST', profile + '/transactions', 201, expense],
  ['Repeat expense', 'POST', profile + '/transactions', 200, expense],
  ['Monthly budget', 'PUT', profile + '/budgets/{month}', 201, { limit_minor: '2000000' }],
  ['Category budget', 'PUT', profile + '/category-budgets/{month}/{id}', 201, { limit_minor: '100000' }, `pm.test('Initial category budget version', () => pm.expect(pm.response.json().version).to.equal(1));`],
  ['Category budget totals', 'GET', profile + '/category-budgets/{month}', 200, undefined, `const result=pm.response.json(); const item=result.items.find(c=>c.category_id===pm.collectionVariables.get('expense_category')); pm.test('Exact category overspending',()=>{pm.expect(item.spent_minor).to.equal('125050');pm.expect(item.remaining_minor).to.equal('-25050');pm.expect(item.overspent_minor).to.equal('25050');pm.expect(result.allocated_minor).to.equal('100000');});`],
  ['Summary', 'GET', profile + '/summary', 200, undefined, `const result = pm.response.json(); pm.test('Exact financial totals', () => { pm.expect(result.balance_minor).to.equal('3874950'); pm.expect(result.expense_minor).to.equal('125050'); pm.expect(result.income_minor).to.equal('3000000'); pm.expect(result.budget.remaining_minor).to.equal('1874950'); });`],
  ['Other profile', 'POST', '/api/v1/profiles', 201, { id: '{{other_profile}}', name: 'Другой профиль' }],
  ['Foreign category', 'POST', profile + '/transactions', 404, { ...expense, id: '{{other_expense}}' }, undefined, 'other_profile'],
  ['Edit expense', 'PATCH', profile + '/transactions/{id}', 200, { amount_minor: '100000', version: 1 }, `pm.test('Version incremented', () => pm.expect(pm.response.json().version).to.equal(2));`],
  ['Stale version', 'PATCH', profile + '/transactions/{id}', 409, { amount_minor: '100001', version: 1 }],
  ['Delete expense', 'DELETE', profile + '/transactions/{id}', 204],
  ['Final summary', 'GET', profile + '/summary', 200, undefined, `pm.test('Removed expense is excluded', () => { const result=pm.response.json(); pm.expect(result.balance_minor).to.equal('4000000'); pm.expect(result.expense_minor).to.equal('0'); pm.expect(result.budget.remaining_minor).to.equal('2000000'); });`],
  ['Deleted retry', 'POST', profile + '/transactions', 410, expense],
  ['Invalid money', 'POST', profile + '/transactions', 422, { ...expense, id: '{{invalid_id}}', amount_minor: 100 }],
  ['Category stale update', 'PUT', profile + '/category-budgets/{month}/{id}', 409, {limit_minor:'200000',version:2}],
  ['Delete category budget', 'DELETE', profile + '/category-budgets/{month}/{id}', 204],
  ['Recreate category budget', 'PUT', profile + '/category-budgets/{month}/{id}', 201, {limit_minor:'200000'}, `pm.test('Tombstone version continues',()=>pm.expect(pm.response.json().version).to.equal(3));`],
  ['Category stale delete', 'DELETE', profile + '/category-budgets/{month}/{id}', 409],
]
await mkdir(path.join(folder, '.resources'), { recursive: true })
await writeFile(path.join(folder, '.resources/definition.yaml'), JSON.stringify({ $kind: 'collection', name: 'Smoke', description: 'Financial lifecycle. Run against a dedicated test database; creates two profiles.', order: 0 }, null, 2) + '\n')
for (const [index, [name, method, route, status, body, assertions = '', profileVariable = 'profile_id']] of cases.entries()) {
  if (!spec.paths[route]?.[method.toLowerCase()]) throw new Error(`Missing contract operation: ${method} ${route}`)
  const url = '{{baseUrl}}' + route.replace('{p}', '{{' + profileVariable + '}}').replace('{month}', '{{month}}').replace('{id}', route.includes('category-budgets') ? '{{expense_category}}' : '{{expense_id}}') + (route.endsWith('/summary') ? '?month={{month}}' : method === 'DELETE' ? (route.includes('category-budgets') ? '?version=1' : '?version=2') : '')
  const scripts = [{ type: 'afterResponse', language: 'text/javascript', code: `pm.test('HTTP ${status}', () => pm.response.to.have.status(${status}));\n${status >= 400 ? "pm.test('Structured error', () => { const e=pm.response.json().error; pm.expect(e.code).to.be.a('string'); pm.expect(e.request_id).to.be.a('string'); });" : ''}\n${assertions}` }]
  if (index === 0) scripts.unshift({ type: 'beforeRequest', language: 'text/javascript', code: `['profile_id','income_id','expense_id','other_profile','other_expense','invalid_id'].forEach(key => pm.collectionVariables.set(key, pm.variables.replaceIn('{{$guid}}'))); const today = new Date(Date.now() + 3*60*60*1000).toISOString().slice(0,10); pm.collectionVariables.set('today', today); pm.collectionVariables.set('month', today.slice(0,7));` })
  const request = { $kind: 'http-request', order: (index + 1) * 1000, method, url, scripts, ...(body ? { headers: [{ key: 'Content-Type', value: 'application/json' }], body: { type: 'json', content: JSON.stringify(body, null, 2) } } : {}) }
  await writeFile(path.join(folder, name + '.request.yaml'), JSON.stringify(request, null, 2) + '\n')
}
await writeFile(path.join(root, 'postman/collections/FinTrack API/.resources/definition.yaml'), JSON.stringify({ $kind: 'collection', name: 'FinTrack API', variables: [{ key: 'baseUrl', value: 'http://127.0.0.1:8000' }] }, null, 2) + '\n')
console.log(`Generated ${cases.length} contract-based smoke requests`)
