import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { fixture, state, settle } from './helpers.mjs';
import { runMedia } from '../lib/media.mjs';
import { downloadRecording } from '../lib/cloud-import.mjs';

let bytes, releaseDownload, downloads=0, browser;
const gate=new Promise(r=>{releaseDownload=r;});
const f=await fixture({cloudDownload:async(url,dir)=>{
  downloads++;await gate;
  return downloadRecording(url,dir,{openResponse:async()=>Object.assign(Readable.from([bytes]),{statusCode:url.endsWith('private.mp4')?403:200,headers:{'content-disposition':'attachment; filename="cloud-meeting.mp4"'}})});
}});
try {
  if (!(await state(f.base)).local.available) throw new Error('Установите локальные модели для браузерного теста облака');
  const path=join(f.directory,'speech.mp4');
  await runMedia(f.config.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=black:s=64x64:r=1','-i',join(f.config.localModelDir,'test_wavs/example.wav'),'-shortest','-c:v','libx264','-c:a','aac',path]);
  bytes=await readFile(path);
  const executablePath=process.env.BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium'].find(existsSync);
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'ru-RU'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.base);await page.locator('#empty').waitFor({state:'visible'});
  await page.locator('#auto-transcribe').uncheck();await page.locator('#auto-summary').uncheck();
  await page.getByLabel('Ссылка на видеозапись',{exact:true}).fill('https://files.example/cloud.mp4');
  await page.getByRole('button',{name:'Добавить из облака',exact:true}).click();
  await page.locator('.badge.processing').filter({hasText:'Получение файла'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Добавить из облака',exact:true}).isDisabled(),true);
  const id=(await state(f.base)).meetings[0].id;
  await page.reload();await page.locator('.badge.processing').waitFor();
  releaseDownload();const item=await settle(f.base,id,30000);
  assert.equal(item.stages.transcription,'done');assert.equal(item.stages.summary,'error');
  assert.match(item.error,/Не настроен ключ/); // No paid calls in this browser check.
  await page.locator('.badge.error').waitFor();
  await page.locator('#cloud-url').fill('https://files.example/cloud.mp4#again');
  await page.locator('#cloud-add').click();
  await page.locator('#cloud-result').getByText('Эта ссылка уже добавлена.',{exact:false}).waitFor();
  await page.locator('#cloud-result a').click();
  assert.equal(downloads,1);assert.equal(await page.locator('.meeting').count(),1);
  assert.equal(await page.locator('.source-label').innerText(),'Из облака');
  await page.locator('.transcript > summary').click();
  assert.match((await page.locator('.transcript p').allInnerTexts()).join(' '),/лукоморья/i);
  await page.locator('#cloud-url').fill('https://files.example/private.mp4');await page.locator('#cloud-add').click();
  await page.locator('.error-box').filter({hasText:'Скачайте файл из облака самостоятельно'}).waitFor();
  await mkdir('test-output',{recursive:true});
  await page.screenshot({path:resolve('test-output/desktop-cloud.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve('test-output/mobile-cloud.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('Облако: фоновое получение, автозапуск, сохранение после обновления, повторная ссылка, ошибка доступа, 1440/390 px — пройдено.');
} finally {releaseDownload();await browser?.close();await f.cleanup();}
