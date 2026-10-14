import { mkdir,writeFile } from 'node:fs/promises';
const root='postman/collections/FinTrack Import Lab';
const folder=root+'/Smoke';
const cases=[
 ['Status','GET','/api/lab/status',200,undefined,`pm.test('Real Qwen is ready',()=>pm.expect(pm.response.json().ready).to.equal(true));`],
 ['Classify text','POST','/api/lab/text',200,{text:'14.10.2026\nПятёрочка продукты −1 250,50 ₽\nWildberries −2 400 ₽',capture_date:'2026-10-14'},`const r=pm.response.json();pm.test('Real generation and exact sums',()=>{pm.expect(r.warnings).to.have.length(0);pm.expect(r.rows).to.have.length(2);pm.expect(r.metrics.generated_tokens).to.be.above(0);pm.expect(r.rows[0].amount_minor).to.equal('125050');pm.expect(r.rows[0].category_id).to.equal('products');pm.expect(r.rows[1].category_name).to.equal('Не определено');});`],
 ['Unknown direction','POST','/api/lab/text',200,{text:'Магазин 500 ₽'},`const r=pm.response.json();pm.test('Missing facts are not invented',()=>{pm.expect(r.rows[0].type).to.equal('unknown');pm.expect(r.rows[0].date).to.equal(null);pm.expect(r.rows[0].category_name).to.equal('Не определено');pm.expect(r.metrics.generated_tokens).to.equal(0);});`],
 ['Invalid capture date','POST','/api/lab/text',422,{text:'Покупка -500 ₽',capture_date:'invalid'},`pm.test('Structured input error',()=>pm.expect(pm.response.json().error.code).to.equal('invalid_input'));`],
];
await mkdir(folder+'/.resources',{recursive:true});
await writeFile(folder+'/.resources/definition.yaml',JSON.stringify({$kind:'collection',name:'Smoke',description:'Synthetic local test. Does not write to finance database.',order:0},null,2)+'\n');
await writeFile(root+'/.resources/definition.yaml',JSON.stringify({$kind:'collection',name:'FinTrack Import Lab',variables:[{key:'baseUrl',value:'http://127.0.0.1:8090'}]},null,2)+'\n');
for(const [index,[name,method,url,status,body,assertions]] of cases.entries()) {
 const request={$kind:'http-request',order:(index+1)*1000,method,url:'{{baseUrl}}'+url,scripts:[{type:'afterResponse',language:'text/javascript',code:`pm.test('HTTP ${status}',()=>pm.response.to.have.status(${status}));\n${assertions}`}],...(body?{headers:[{key:'Content-Type',value:'application/json'}],body:{type:'json',content:JSON.stringify(body,null,2)}}:{})};
 await writeFile(folder+'/'+name+'.request.yaml',JSON.stringify(request,null,2)+'\n');
}
console.log('Generated 4 import lab smoke requests');
