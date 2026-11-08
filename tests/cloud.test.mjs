import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { normalizeCloudUrl, isPublicAddress, downloadRecording, resolveCloudDownload } from '../lib/cloud-import.mjs';
import { fixture, settle, state } from './helpers.mjs';
import { runMedia } from '../lib/media.mjs';
import { createApplication } from '../server.mjs';
import { localStatus } from '../lib/local-asr.mjs';

function response(bytes, statusCode = 200, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(bytes)]), { statusCode, headers });
}
const post = (base, path, body) => fetch(base + path, { method:'POST', headers:{'X-Meeting-Upload':'1','Content-Type':'application/json'}, body:JSON.stringify(body) });
const importUrl = (base,url) => post(base,'/api/meetings/import',{url,transcriptionMode:'local'});

test('Отдельное поле Яндекс Диска проверяет источник до создания задания', async () => {
  let downloads=0;
  const f=await fixture({cloudDownload:async()=>{downloads++;throw new Error('Unexpected download');}});
  try {
    const r=await post(f.base,'/api/meetings/import',{url:'https://drive.google.com/file/d/test/view',provider:'yandex'});
    assert.equal(r.status,400);assert.match((await r.json()).error,/публичную ссылку на файл Яндекс Диска/);
    assert.equal((await post(f.base,'/api/meetings/import',{url:'https://example.com/a',provider:'other'})).status,400);
    assert.equal(downloads,0);assert.equal(f.store.list().length,0);
  } finally {await f.cleanup();}
});

test('Яндекс Диск: публичная ссылка преобразуется через API, запреты и лимиты не обходятся', async () => {
  const source='https://disk.yandex.ru/i/public-test-file';
  let called=0;
  const target=await resolveCloudDownload(source,{openResponse:async(url,_signal,options)=>{
    called++; const api=new URL(url);
    assert.equal(api.origin,'https://cloud-api.yandex.net');
    assert.equal(api.searchParams.get('public_key'),source);assert.equal(options.accept,'application/json');
    return response(JSON.stringify({href:'https://downloader.disk.yandex.ru/file?token=test',method:'GET'}));
  }});
  assert.equal(target,'https://downloader.disk.yandex.ru/file?token=test');assert.equal(called,1);
  for (const [body,status,pattern] of [
    ['{}',429,/ограничил/],['{}',503,/временно недоступен/],['{}',403,/не разрешил/],
    ['{}',200,/не вернул/],[JSON.stringify({href:'https://127.0.0.1/a'}),200,/локальную сеть/],
    [JSON.stringify({href:'http://example.com/a'}),200,/незащищённую/],['x'.repeat(65537),200,/слишком большой/]
  ]) await assert.rejects(resolveCloudDownload(source,{openResponse:async()=>response(body,status)}),pattern);
  assert.equal(await resolveCloudDownload('https://disk.yandex.ru.evil.example/i/id'),'https://disk.yandex.ru.evil.example/i/id');
});

test('Google Drive: ссылка просмотра, resourcekey и ручное подтверждение безопасности', async () => {
  assert.equal(await resolveCloudDownload('https://drive.google.com/file/d/public-test-id/view?usp=sharing&resourcekey=key'), 'https://drive.google.com/uc?export=download&id=public-test-id&resourcekey=key');
  assert.equal(await resolveCloudDownload('https://drive.google.com/open?id=public-test-id'), 'https://drive.google.com/uc?export=download&id=public-test-id');
  const dir=await mkdtemp(join(tmpdir(),'google-download-'));
  try {
    const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(20)]);
    const result=await downloadRecording('https://drive.google.com/file/d/public-test-id/view',dir,{openResponse:async(url)=>{
      assert.equal(new URL(url).pathname,'/uc');return response(bytes,200,{'content-disposition':'attachment; filename="public.mp4"'});
    }});
    assert.equal(result.filename,'public.mp4');await rm(join(dir,'source.mp4'));
    let requests=0;
    await assert.rejects(downloadRecording('https://drive.google.com/file/d/public-test-id/view',dir,{openResponse:async()=>{
      requests++;return response('<title>Google Drive - Virus scan warning</title><form action="https://example.com/confirm"></form>',200,{'content-type':'text/html'});
    }}),/ручного подтверждения/);
    assert.equal(requests,1);assert.deepEqual(await readdir(dir),[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Ссылки: нормализация без разрушения подписи, запрет локальных адресов и небезопасных схем', () => {
  assert.equal(normalizeCloudUrl(' HTTPS://EXAMPLE.COM:443/video.mp4?a=2&b=1#view '),'https://example.com/video.mp4?a=2&b=1');
  for (const value of ['file:///etc/passwd','ftp://example.com/a','https://user:pass@example.com/a','http://localhost/a','http://2130706433/a','http://[::1]/a','http://169.254.169.254/a','http://192.168.1.1/a','https://example.com:8080/a']) assert.throws(()=>normalizeCloudUrl(value));
  for (const value of ['127.0.0.1','10.1.2.3','172.16.0.1','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(value),false,value);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});

test('Загрузка: поток, хеш, имя из заголовка, редиректы, лимит и сообщения об авторизации', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cloud-download-'));
  // Container signature only: actual media validation is tested separately through FFmpeg.
  const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(60)]);
  try {
    let calls=0;
    const result=await downloadRecording('https://files.example/video',dir,{openResponse:async()=>++calls===1?response('',302,{location:'/download'}):response(bytes,200,{'content-disposition':"attachment; filename*=UTF-8''%D0%92%D1%81%D1%82%D1%80%D0%B5%D1%87%D0%B0.mp4"})});
    assert.equal(calls,2); assert.equal(result.filename,'Встреча.mp4');
    assert.equal(result.sourceHash,createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(join(dir,'source.mp4')),bytes);
    await rm(join(dir,'source.mp4'));
    for (const [make,expected,extra] of [
      [()=>response('',403),/авторизации/,{}],
      [()=>response('<html>login</html>',200,{'content-type':'text/html'}),/страница/,{}],
      [()=>response('<html>login</html>'),/не вернула видео/,{}],
      [()=>response(bytes),/больше 1 ГБ/,{maxBytes:10}],
      [()=>response(bytes,200,{'content-length':'999'}),/больше 1 ГБ/,{maxBytes:10}],
      [()=>response('',302,{location:'http://127.0.0.1/private'}),/локальную сеть/,{}],
      [()=>response('',302,{location:'/again'}),/перенаправлений/,{}],
      [()=>{throw new Error('network');},/соединения/,{}]
    ]) {
      await assert.rejects(downloadRecording('https://files.example/video',dir,{openResponse:async()=>make(),...extra}),expected);
      assert.deepEqual(await readdir(dir),[]);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Импорт — фоновая задача, автоанализ, дедупликация URL/хеша и сохранение после перезапуска', async t => {
  let bytes, downloads=0, releaseDownload, releaseSummary;
  const gate=new Promise(resolve=>{releaseDownload=resolve;});
  const f=await fixture({cloudDownload:async(url,dir)=>{downloads++; await gate; return downloadRecording(url,dir,{openResponse:async()=>response(bytes,200,{'content-disposition':'attachment; filename="meeting.mp4"'})});}});
  let restarted;
  try {
    if (!(await localStatus(f.config)).available) return t.skip('Нужны локальные модели');
    const path=join(f.directory,'speech.mp4');
    await runMedia(f.config.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=black:s=64x64:r=1','-i',join(f.config.localModelDir,'test_wavs/example.wav'),'-shortest','-c:v','libx264','-c:a','aac',path]);
    bytes=await readFile(path);
    const realFetch=globalThis.fetch; let summaries=0;
    const summaryGate=new Promise(resolve=>{releaseSummary=resolve;});
    // Explicit API contract fixture, never a product/demo result or a paid call.
    const expected={overview:'Тест контракта ответа API.',decisions:[],tasks:[],questions:[]};
    t.mock.method(globalThis,'fetch',async (url,options)=>{
      if(String(url)==='https://api.openai.com/v1/responses') {
        summaries++; await summaryGate;
        return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(expected)}]}]}));
      }
      if (String(url).startsWith('https://api.openai.com/')) throw new Error('Unexpected paid API call');
      return realFetch(url,options);
    });
    f.config.key='test-contract-only';
    const accepted=await importUrl(f.base,'https://files.example/video.mp4#one');
    assert.equal(accepted.status,202); const {id}=await accepted.json();
    const initial=(await state(f.base)).meetings.find(x=>x.id===id);
    assert.equal(initial.activeStage,'upload'); assert.equal(initial.sourceType,'cloud');
    assert(initial.autoTranscribe && initial.autoSummary);
    const duplicate=await importUrl(f.base,'https://files.example/video.mp4#two');
    assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).id,id);
    for(let i=0;i<100&&!downloads;i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(downloads,1);
    releaseDownload();
    let item;
    for(let i=0;i<300;i++) {item=(await state(f.base)).meetings.find(x=>x.id===id);if(item.activeStage==='summary')break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(item.activeStage,'summary');assert.match(item.transcript.toLowerCase(),/лукоморья/);
    releaseSummary();item=await settle(f.base,id);
    assert.equal(item.status,'ready');assert.deepEqual(item.summary,expected);assert.equal(summaries,1);
    assert.equal(item.filename,'meeting.mp4');assert(item.sourceHash);
    const second=await importUrl(f.base,'https://another.example/same.mp4');
    const alias=await settle(f.base,(await second.json()).id);
    assert.equal(alias.duplicateOf,id);assert.equal(alias.status,'duplicate');assert.equal(summaries,1);
    assert.equal((await importUrl(f.base,'https://another.example/same.mp4').then(r=>r.json())).id,id);
    await f.close(); restarted=await createApplication({...f.config,key:''});
    assert.deepEqual(restarted.store.items.get(id).summary,expected);
    assert.equal(restarted.store.items.get(id).sourceUrl,'https://files.example/video.mp4');
    await restarted.store.remove(restarted.store.items.get(id));
    assert.equal(restarted.store.items.has(alias.id),false);
  } finally {releaseDownload(); releaseSummary?.(); await restarted?.close();await f.cleanup();}
});

test('Недоступное облако: сохранённая ошибка, повтор получения без новой карточки', async () => {
  let attempts=0;
  const f=await fixture({cloudDownload:async(url,dir)=>{attempts++;return downloadRecording(url,dir,{openResponse:async()=>response('',403)});}});
  try {
    const first=await importUrl(f.base,'https://files.example/private.mp4');
    const {id}=await first.json();const item=await settle(f.base,id);
    assert.equal(item.status,'error');assert.equal(item.stages.upload,'error');assert.match(item.error,/Скачайте файл из облака самостоятельно/);
    assert.equal(item.sourceAvailable,false);assert.deepEqual(await readdir(f.store.sources),[]);
    assert.equal((await importUrl(f.base,item.sourceUrl).then(r=>r.json())).id,id);assert.equal(attempts,1);
    assert.equal((await post(f.base,`/api/meetings/${id}/retry-import`,{})).status,202);
    await settle(f.base,id); assert.equal(attempts,2);assert.equal(f.store.list().length,1);
  } finally {await f.cleanup();}
});
