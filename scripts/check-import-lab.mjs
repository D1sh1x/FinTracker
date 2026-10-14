import { chromium } from '../frontend/node_modules/@playwright/test/index.mjs';
import { mkdir,writeFile,readFile } from 'node:fs/promises';

const address=process.argv[2]??'http://127.0.0.1:8090';
const browser=await chromium.launch({headless:true});
const errors=[];
try {
  await mkdir('.local/lab-check',{recursive:true});
  const fixture=await browser.newPage({viewport:{width:780,height:680}});
  await fixture.setContent(`<main style="font:24px Arial;background:white;color:black;padding:30px"><h1 style="font-size:28px">Синтетический пример операций</h1><p>14 октября 2026</p><p>Пятёрочка продукты &nbsp; −1 250,50 ₽</p><p>Wildberries &nbsp; −2 400 ₽</p><p>Зарплата ООО Пример &nbsp; +45 000 ₽</p></main>`);
  await fixture.screenshot({path:'.local/lab-check/synthetic-screen.png'});
  await fixture.close();
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(address);
  await page.getByRole('heading',{name:'Проверим банковский скриншот'}).waitFor();
  await page.locator('#image').setInputFiles('.local/lab-check/synthetic-screen.png');
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(address).origin});
  await page.evaluate(async data=>{
    const blob=await (await fetch('data:image/png;base64,'+data)).blob();
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  },(await readFile('.local/lab-check/synthetic-screen.png')).toString('base64'));
  await page.locator('#text').focus();
  await page.keyboard.press('Control+V');
  await page.getByText('Скриншот вставлен из буфера обмена',{exact:true}).waitFor();
  if(await page.locator('#image').inputValue()!=='')throw Error('Pasted image did not replace file selection');
  await page.locator('#captured').fill('2026-10-14');
  await page.getByRole('button',{name:'Распознать и классифицировать'}).click();
  await page.locator('.row').first().waitFor({timeout:180000});
  await page.waitForFunction(()=>!document.getElementById('analyze').disabled,{timeout:180000});
  const rows=page.locator('.row');
  if(await rows.count()!==3)throw Error('OCR expected three operations: '+await page.locator('#text').inputValue());
  if(!await rows.nth(0).locator('.category').textContent().then(t=>t==='Продукты'))throw Error('Product category failed');
  if(await rows.nth(1).locator('.category').textContent()!=='Не определено')throw Error('Marketplace must remain unknown');
  if(await rows.nth(2).locator('.category').textContent()!=='Зарплата')throw Error('Income category failed');
  if(await rows.nth(0).locator('input').nth(1).inputValue()!=='1250,50')throw Error('OCR exact amount failed');
  await page.locator('.row').nth(1).locator('input').first().fill('Лечение зубов в стоматологии');
  await page.getByRole('button',{name:'Переклассифицировать после правок'}).click();
  await page.waitForFunction(()=>!document.getElementById('reclassify').disabled,{timeout:180000});
  if(await page.locator('.row').nth(1).locator('.category').textContent()!=='Здоровье')throw Error('Edited description was not reclassified');
  await page.getByRole('button',{name:'Добавить строку',exact:true}).click();
  await page.locator('.row').last().locator('input').first().fill('Неизвестный платёж абвгд');
  await page.getByRole('button',{name:'Переклассифицировать после правок'}).click();
  await page.waitForFunction(()=>!document.getElementById('reclassify').disabled,{timeout:180000});
  if(await page.locator('.row').last().locator('.category').textContent()!=='Не определено')throw Error('Unknown manual operation failed');
  for(const width of [360,390,1280]) {
    await page.setViewportSize({width,height:1000});
    if(!await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))throw Error('Overflow at '+width);
    await page.screenshot({path:`.local/lab-check/lab-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'Тёмная тема'}).click();
  await page.screenshot({path:'.local/lab-check/lab-dark.png',fullPage:true});
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Скачать результат JSON'}).click();
  const file=await download;await file.saveAs('.local/lab-check/result.json');
  const result=JSON.parse(await readFile('.local/lab-check/result.json','utf8'));
  if(result.rows.length!==4)throw Error('Download lost edited rows');
  await page.route('**/api/lab/text',async route=>{await new Promise(resolve=>setTimeout(resolve,1500));await route.abort();});
  await page.getByRole('button',{name:'Контрольный пример'}).click();
  await page.getByRole('button',{name:'Проверить текст',exact:true}).click();
  await page.getByRole('button',{name:'Отменить тест'}).click();
  await page.getByRole('alert').filter({hasText:'Тест отменён'}).waitFor();
  if(await page.locator('.row').count()!==4)throw Error('Cancellation lost previous result');
  if(errors.length)throw Error(errors.join('; '));
  await writeFile('.local/lab-check/verification.json',JSON.stringify({clipboard_paste:true,ocr_rows:3,edited_rows:4,widths:[360,390,1280],errors,model:result.model,metrics:result.metrics},null,2));
  console.log('Lab verified: Ctrl+V image + real OCR/Qwen categories, unknown fallback, correction, manual row, JSON download, cancellation, mobile/dark layout.');
} finally {await browser.close();}
