import { readFile, writeFile, mkdir } from 'node:fs/promises';
const spec = JSON.parse(await readFile('api/openapi.json', 'utf8'));
const folder = 'postman/collections/FinTrack API/Notification smoke';
await mkdir(folder + '/.resources', { recursive: true });
await writeFile(folder + '/.resources/definition.yaml', JSON.stringify({ $kind: 'collection', name: 'Notification smoke', description: 'Writes synthetic WB purchases; run only against an isolated test database.' }, null, 2) + '\n');
const base = '/api/v1/profiles/{p}';
const purchase = { id: '{{push_id}}', wallet_id: '{{push_wallet}}', package_name: 'ru.wildberries.bank', posted_at: '{{push_time}}', text: 'Покупка 43 ₽ по карте *7055 Транспорт Краснодара. Доступно 933,48 ₽' };
const cases = [
 ['Create push profile', 'POST', '/api/v1/profiles', { id: '{{push_profile}}', name: 'WB notification smoke' }, 201, ''],
 ['Read push account', 'GET', base + '/wallet', null, 200, "pm.collectionVariables.set('push_wallet',pm.response.json().id);"],
 ['Import purchase', 'POST', base + '/notification-imports', purchase, 201, "pm.collectionVariables.set('push_transaction',pm.response.json().transaction_id);pm.test('Receipt',()=>pm.expect(pm.response.json().status).to.eql('imported'));"],
 ['Replay purchase', 'POST', base + '/notification-imports', purchase, 200, "pm.test('Stable receipt',()=>pm.expect(pm.response.json().transaction_id).to.eql(pm.collectionVariables.get('push_transaction')));"],
 ['Read exact expense', 'GET', base + '/transactions/{id}', null, 200, "pm.test('Exact amount, source and merchant',()=>{const t=pm.response.json();pm.expect(t.amount_minor).to.eql('4300');pm.expect(t.source).to.eql('notification');pm.expect(t.note).to.eql('Транспорт Краснодара');});"],
 ['Changed payload conflicts', 'POST', base + '/notification-imports', { ...purchase, text: 'Покупка 44 ₽ по карте *7055 Магнит' }, 409, ''],
 ['Reject balance only', 'POST', base + '/notification-imports', { ...purchase, id: '{{$guid}}', text: 'Доступно 933,48 ₽' }, 422, ''],
 ['Reject Mir Pay', 'POST', base + '/notification-imports', { ...purchase, id: '{{$guid}}', package_name: 'ru.nspk.mirpay' }, 422, ''],
];
for (const [index, [name, method, route, body, status, assertion]] of cases.entries()) {
 if (!spec.paths[route]?.[method.toLowerCase()]) throw new Error('Missing contract ' + route);
 const scripts = [{ type: 'afterResponse', language: 'text/javascript', code: `pm.test('HTTP ${status}',()=>pm.response.to.have.status(${status}));\n${assertion}` }];
 if (index === 0) scripts.unshift({ type: 'beforeRequest', language: 'text/javascript', code: "['push_profile','push_id'].forEach(k=>pm.collectionVariables.set(k,pm.variables.replaceIn('{{$guid}}')));pm.collectionVariables.set('push_time',new Date().toISOString());" });
 const request = { $kind: 'http-request', name, order: (index + 1) * 1000, method, url: '{{baseUrl}}' + route.replace('{p}', '{{push_profile}}').replace('{id}', '{{push_transaction}}'), scripts,
  ...(body ? { headers: { 'Content-Type': 'application/json' }, body: { type: 'json', content: JSON.stringify(body, null, 2) } } : {}) };
 await writeFile(folder + '/' + name + '.request.yaml', JSON.stringify(request, null, 2) + '\n');
}
console.log('Notification smoke saved: 8 requests');
