import {chromium} from '../frontend/node_modules/@playwright/test/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';

const address=process.argv[2]??'http://127.0.0.1:8090';
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(address);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(address).origin});
  await page.evaluate(()=>document.addEventListener('paste',event=>{
    const item=Array.from(event.clipboardData?.items??[]).find(item=>item.kind==='file'&&item.type.startsWith('image/'));
    if(item)window.pastedImage=item.getAsFile();
  },{capture:true}));
  const images=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;
    const context=canvas.getContext('2d');
    context.fillStyle='red';context.fillRect(0,0,24,24);
    const red=canvas.toDataURL('image/png').split(',')[1];
    context.fillStyle='blue';context.fillRect(0,0,24,24);
    return {red,blue:canvas.toDataURL('image/png').split(',')[1],jpeg:canvas.toDataURL('image/jpeg').split(',')[1]};
  });
  const empty={model:'clipboard transport fixture',ocr:'',text:'',lines:[],rows:[],warnings:[],metrics:{ocr_ms:0,model_ms:0,total_ms:0,prompt_tokens:0,generated_tokens:0,tokens_per_second:0}};
  const bodies=[];
  let blocked=false,release=null;
  await page.route('**/api/lab/analyze',async route=>{
    bodies.push(route.request().postDataBuffer());
    if(blocked)await new Promise(resolve=>{release=resolve;});
    await route.fulfill({json:empty});
  });
  const upload=async expected=>{
    const count=bodies.length;
    await page.getByRole('button',{name:'Распознать и классифицировать'}).click();
    await page.waitForFunction(()=>!document.getElementById('analyze').disabled);
    if(bodies.length!==count+1||!bodies.at(-1).includes(Buffer.from(expected,'base64')))throw Error('Wrong uploaded image bytes');
  };
  const pasteFile=async (data,type,name,size=0)=>page.evaluate(({data,type,name,size})=>{
    const clipboard=new DataTransfer();
    const bytes=size?new Uint8Array(size):Uint8Array.from(atob(data),char=>char.charCodeAt(0));
    clipboard.items.add(new File([bytes],name,{type}));
    document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
  },{data,type,name,size});
  await page.locator('#image').setInputFiles({name:'original.png',mimeType:'image/png',buffer:Buffer.from(images.red,'base64')});
  await page.evaluate(async data=>{
    const blob=await (await fetch('data:image/png;base64,'+data)).blob();
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  },images.blue);
  await page.locator('#text').focus();
  await page.keyboard.press('Control+V');
  await page.getByText('Скриншот вставлен из буфера обмена',{exact:true}).waitFor();
  if(await page.locator('#image').inputValue()!=='')throw Error('Old file selection retained');
  const clipboardImage=await page.evaluate(async()=>{
    const file=window.pastedImage;
    const bitmap=await createImageBitmap(file);
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
    const data=new Uint8Array(await file.arrayBuffer());
    return {data:btoa(String.fromCharCode(...data)),pixel:Array.from(context.getImageData(0,0,1,1).data),width:canvas.width,height:canvas.height};
  });
  if(clipboardImage.width!==24||clipboardImage.height!==24||clipboardImage.pixel.join(',')!=='0,0,255,255')throw Error('Clipboard changed image content');
  await upload(clipboardImage.data);
  const preview=await page.locator('#preview').getAttribute('src');
  await page.evaluate(()=>navigator.clipboard.writeText('Обычный текст операции'));
  await page.locator('#text').focus();await page.keyboard.press('Control+V');
  if(await page.locator('#text').inputValue()!=='Обычный текст операции'||await page.locator('#preview').getAttribute('src')!==preview)throw Error('Text paste was intercepted');
  await pasteFile(images.jpeg,'image/jpeg','pasted.jpg');await upload(images.jpeg);
  await page.locator('#image').setInputFiles({name:'chosen.png',mimeType:'image/png',buffer:Buffer.from(images.red,'base64')});await upload(images.red);
  const selected=await page.locator('#preview').getAttribute('src');
  await pasteFile(images.blue,'image/gif','unsupported.gif');
  await page.getByRole('alert').filter({hasText:'PNG/JPEG'}).waitFor();
  await pasteFile('','image/png','large.png',10*1024*1024+1);
  await page.getByRole('alert').filter({hasText:'10 МБ'}).waitFor();
  if(await page.locator('#preview').getAttribute('src')!==selected)throw Error('Invalid paste replaced valid image');
  blocked=true;
  await page.getByRole('button',{name:'Распознать и классифицировать'}).click();
  await page.waitForFunction(()=>document.getElementById('analyze').disabled);
  await pasteFile(images.blue,'image/png','during-test.png');
  await page.getByRole('alert').filter({hasText:'текущий тест'}).waitFor();
  if(await page.locator('#preview').getAttribute('src')!==selected)throw Error('Paste replaced image during processing');
  if(!release)throw Error('Expected pending upload');
  blocked=false;release();
  await page.waitForFunction(()=>!document.getElementById('analyze').disabled);
  if(!bodies.at(-1).includes(Buffer.from(images.red,'base64')))throw Error('Invalid paste changed processing input');
  await pasteFile(images.blue,'image/png','after-test.png');await upload(images.blue);
  if(errors.length)throw Error(errors.join('; '));
  await mkdir('.local/lab-check',{recursive:true});
  await writeFile('.local/lab-check/clipboard-verification.json',JSON.stringify({trusted_ctrl_v:true,text_paste:true,jpeg_paste:true,file_replacement:true,invalid_image_preserved:true,busy_preserved:true,uploaded_bytes_verified:true,errors},null,2));
  console.log('Clipboard verified: real Ctrl+V PNG/text, JPEG event, file replacement, MIME/size limits, busy guard and unchanged upload bytes. API processing mocked for transport checks.');
} finally {await browser.close();}
