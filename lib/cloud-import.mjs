import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_BYTES, UserError } from './common.mjs';

export const CLOUD_FALLBACK = 'Скачайте файл из облака самостоятельно и загрузите его кнопкой «Выбрать запись».';
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip, prefix);
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16]]) blocked.addSubnet(ip,prefix,'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address) : family === 6 && global6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
export function normalizeCloudUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new UserError('Введите ссылку на видеозапись.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new UserError('Некорректная ссылка. Нужен адрес HTTP или HTTPS.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new UserError('Нужна ссылка HTTP/HTTPS без логина и пароля, со стандартным портом.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !isPublicAddress(host))) throw new UserError('Ссылка должна вести на общедоступный сервер, а не в локальную сеть.');
  url.hash = '';
  // Keep query values and ordering: signed download links may depend on both.
  return url.href;
}
export async function openCloudResponse(value, signal) {
  const url = new URL(normalizeCloudUrl(value));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await lookup(host,{all:true,verbatim:true});
  if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) throw new UserError('Ссылка ведёт на недоступный или внутренний адрес. ' + CLOUD_FALLBACK);
  const chosen = addresses[0];
  return new Promise((resolve,reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent:false, headers:{'User-Agent':'MeetingNotes/1.0','Accept':'video/mp4,video/webm,application/octet-stream','Accept-Encoding':'identity'},
      // Pin the validated address. TLS still validates the original hostname.
      lookup: (_host, options, callback) => options.all ? callback(null,[chosen]) : callback(null,chosen.address,chosen.family)
    }, response => {
      // An abort may arrive while the caller opens its output file, before iteration starts.
      response.on('error', () => {});
      resolve(response);
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Download idle timeout')));
    request.on('error',reject);
  });
}
function filename(headers, url, extension) {
  const disposition = headers['content-disposition'] || '';
  let value = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1] || new URL(url).pathname.split('/').at(-1);
  try { value = decodeURIComponent(value); } catch {}
  value = (value || 'Запись из облака').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').trim().slice(0,180);
  return (value || 'Запись из облака').replace(/\.(mp4|webm)$/i,'') + extension;
}
export async function downloadRecording(input, directory, { openResponse = openCloudResponse, maxBytes = MAX_BYTES, timeoutMs = 10 * 60_000 } = {}) {
  let url = normalizeCloudUrl(input), response, file;
  const partial = join(directory,'download.part');
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let hops=0; hops<=5; hops++) {
      response = await openResponse(url,signal);
      if ([301,302,303,307,308].includes(response.statusCode)) {
        const location = response.headers.location; response.destroy();
        if (!location || hops === 5) throw new UserError('Слишком много перенаправлений или ссылка повреждена. ' + CLOUD_FALLBACK);
        const next = normalizeCloudUrl(new URL(location,url).href);
        if (url.startsWith('https:') && next.startsWith('http:')) throw new UserError('Сервис перенаправляет на незащищённое соединение. ' + CLOUD_FALLBACK);
        url = next; continue;
      }
      break;
    }
    if (response.statusCode !== 200) throw new UserError('Сервис не разрешил скачать файл: ссылка недоступна, истекла или требует авторизации. ' + CLOUD_FALLBACK);
    if (/text\/|application\/(json|xhtml)/i.test(response.headers['content-type'] || '')) throw new UserError('По ссылке открывается страница, а не видеофайл. Возможно, требуется вход в облачный сервис. ' + CLOUD_FALLBACK);
    if (Number(response.headers['content-length']) > maxBytes) throw new UserError('Файл больше 1 ГБ. Выберите более короткую запись.');
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new UserError('Сервис вернул сжатый ответ вместо видеофайла. ' + CLOUD_FALLBACK);
    file = await open(partial,'wx');
    let size=0, prefix=Buffer.alloc(0); const hash=createHash('sha256');
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxBytes) throw new UserError('Файл больше 1 ГБ. Выберите более короткую запись.');
      if (prefix.length < 32) prefix=Buffer.concat([prefix,chunk.subarray(0,32-prefix.length)]);
      hash.update(chunk); await file.writeFile(chunk);
    }
    if (!size) throw new UserError('Облачный сервис вернул пустой файл. ' + CLOUD_FALLBACK);
    const extension = prefix.subarray(4,8).toString() === 'ftyp' ? '.mp4' : prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) ? '.webm' : null;
    if (!extension) throw new UserError('Ссылка не вернула видео MP4/WebM. ' + CLOUD_FALLBACK);
    await file.sync(); await file.close(); file=null;
    await rename(partial,join(directory,`source${extension}`));
    return {filename:filename(response.headers,url,extension),extension,sourceHash:hash.digest('hex'),sourceBytes:size};
  } catch(error) {
    if (error instanceof UserError) throw error;
    if (['ENOSPC','EACCES','EPERM','EIO'].includes(error.code)) throw error;
    throw new UserError('Не удалось получить файл: ошибка соединения или истекло время ожидания. ' + CLOUD_FALLBACK);
  } finally { response?.destroy(); await file?.close(); await rm(partial,{force:true}); }
}
