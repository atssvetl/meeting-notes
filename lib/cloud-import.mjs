import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_BYTES, UserError, logError } from './common.mjs';
import { googleFileId, googleConfirmation } from './google-drive.mjs';

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
export async function openCloudResponse(value, signal, { accept = 'video/mp4,video/webm,application/octet-stream', headers = {} } = {}) {
  const url = new URL(normalizeCloudUrl(value));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await lookup(host,{all:true,verbatim:true});
  if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) throw new UserError('Ссылка ведёт на недоступный или внутренний адрес. ' + CLOUD_FALLBACK);
  const validated = [...addresses].sort((a,b) => a.family - b.family);
  return new Promise((resolve,reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent:false, autoSelectFamily:true, autoSelectFamilyAttemptTimeout:300,
      headers:{'User-Agent':'MeetingNotes/1.0','Accept':accept,'Accept-Encoding':'identity',...headers},
      // Try the validated public addresses, rather than pinning one unreachable
      // IPv4/IPv6 address. TLS still validates the original hostname.
      lookup: (_host, options, callback) => options.all ? callback(null,validated) : callback(null,validated[0].address,validated[0].family)
    }, response => {
      clearTimeout(headerTimer);
      // An abort may arrive while the caller opens its output file, before iteration starts.
      response.on('error', () => {});
      resolve(response);
    });
    const headerTimer = setTimeout(() => request.destroy(Object.assign(new Error('Download headers timeout'), {code:'ETIMEDOUT'})),30_000);
    headerTimer.unref();
    request.setTimeout(60_000, () => request.destroy(Object.assign(new Error('Download idle timeout'), {code:'ETIMEDOUT'})));
    request.on('error',error => { clearTimeout(headerTimer); reject(error); });
    request.on('close',() => clearTimeout(headerTimer));
  });
}
async function smallResponse(response) {
  let size = 0; const chunks = [];
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 64 * 1024) throw new UserError('Сервис вернул слишком большой ответ вместо ссылки скачивания. ' + CLOUD_FALLBACK);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function isYandexShareUrl(input) {
  const url = new URL(normalizeCloudUrl(input));
  const yandexHosts = ['disk.yandex.ru', 'disk.yandex.com', 'disk.yandex.com.tr', 'disk.360.yandex.ru', 'yadi.sk'];
  return yandexHosts.includes(url.hostname) && /^\/(i|d)\/[^/]+(?:\/.*)?$/.test(url.pathname);
}
export async function resolveCloudDownload(input, { openResponse = openCloudResponse, signal, wait = delay } = {}) {
  const url = new URL(normalizeCloudUrl(input));
  if (isYandexShareUrl(url.href)) {
    const api = new URL('https://cloud-api.yandex.net/v1/disk/public/resources/download');
    // A link to a file inside a shared folder contains the public key and
    // a separate path relative to that folder. Do not send the whole page URL.
    const [, kind, key, path] = url.pathname.match(/^\/(i|d)\/([^/]+)(\/.*)?$/);
    api.searchParams.set('public_key', `${url.origin}/${kind}/${key}`);
    if (path && path !== '/') {
      try { api.searchParams.set('path', decodeURIComponent(path)); }
      catch { throw new UserError('Некорректный путь к файлу в ссылке Яндекс Диска.'); }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await openResponse(api.href, signal, { accept:'application/json' });
      try {
        if (response.statusCode === 429) {
          let details;
          try { details = JSON.parse(await smallResponse(response)); } catch (error) {
            if (signal?.aborted) throw error;
          }
          if (details?.error === 'DiskResourceDownloadLimitExceededError') throw new UserError('Яндекс Диск: исчерпан лимит скачивания этого файла. Дождитесь снятия ограничения или сохраните файл на свой Диск и скачайте его вручную. ' + CLOUD_FALLBACK);
          const retryAfter = response.headers['retry-after'];
          const seconds = retryAfter === undefined ? 2 ** attempt : /^\d+$/.test(retryAfter) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000;
          if (attempt < 2 && Number.isFinite(seconds) && seconds <= 5) {
            response.destroy();
            await wait(Math.max(1, seconds) * 1000, undefined, { signal });
            continue;
          }
          throw new UserError('Яндекс Диск ограничил частоту запросов (HTTP 429). Повторите получение позже. ' + CLOUD_FALLBACK);
        }
        if (response.statusCode >= 500) throw new UserError('Сервис скачивания Яндекс Диска временно недоступен. Повторите получение позже. ' + CLOUD_FALLBACK);
        if (response.statusCode !== 200) throw new UserError('Яндекс Диск не разрешил скачать файл: проверьте публичный доступ и разрешение скачивания. ' + CLOUD_FALLBACK);
        let data;
        try { data = JSON.parse(await smallResponse(response)); } catch (error) {
          if (error instanceof UserError) throw error;
          throw new UserError('Яндекс Диск не вернул ссылку скачивания. ' + CLOUD_FALLBACK);
        }
        if (typeof data.href !== 'string' || (data.method && data.method !== 'GET')) throw new UserError('Яндекс Диск не вернул ссылку скачивания. ' + CLOUD_FALLBACK);
        const href = normalizeCloudUrl(data.href);
        if (!href.startsWith('https:')) throw new UserError('Яндекс Диск вернул незащищённую ссылку. ' + CLOUD_FALLBACK);
        return href;
      } finally { response.destroy(); }
    }
  }
  if (url.hostname === 'drive.google.com') {
    if (/^\/drive\/(?:u\/\d+\/)?folders\//.test(url.pathname)) throw new UserError('Выберите ссылку на отдельную видеозапись Google Drive, а не на папку.');
    const id = googleFileId(url);
    if (id && /^[a-zA-Z0-9_-]+$/.test(id)) {
      const download = new URL('https://drive.google.com/uc');
      download.searchParams.set('export','download'); download.searchParams.set('id',id);
      if (url.searchParams.has('resourcekey')) download.searchParams.set('resourcekey',url.searchParams.get('resourcekey'));
      return download.href;
    }
  }
  return url.href;
}
function filename(headers, url, extension) {
  const disposition = headers['content-disposition'] || '';
  let value = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1] || new URL(url).pathname.split('/').at(-1);
  try { value = decodeURIComponent(value); } catch {}
  value = (value || 'Запись из облака').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').trim().slice(0,180);
  return (value || 'Запись из облака').replace(/\.(mp4|webm)$/i,'') + extension;
}
export async function downloadRecording(input, directory, { openResponse = openCloudResponse, maxBytes = MAX_BYTES, timeoutMs = 10 * 60_000, wait = delay, onProgress = () => {} } = {}) {
  let url = normalizeCloudUrl(input), response, file;
  const partial = join(directory,'download.part');
  const signal = AbortSignal.timeout(timeoutMs);
  let size = 0, prefix = Buffer.alloc(0), hash = createHash('sha256');
  let validator, expectedTotal, downloadHeaders;
  let phase = 'подключение', attempt = 0;
  try {
    for (; attempt < 3; attempt++) {
      try {
        phase = 'получение ссылки';
        onProgress({ received:size, total:expectedTotal || null, retries:attempt });
        url = normalizeCloudUrl(input);
        url = await resolveCloudDownload(url, { openResponse, signal });
        for (let hops=0; hops<=5; hops++) {
          phase = 'подключение к файлу';
          response = await openResponse(url,signal, {headers:size && validator ? {Range:`bytes=${size}-`, 'If-Range':validator} : {}});
          if ([301,302,303,307,308].includes(response.statusCode)) {
            const location = response.headers.location; response.destroy();
            if (!location || hops === 5) throw new UserError('Слишком много перенаправлений или ссылка повреждена. ' + CLOUD_FALLBACK);
            const next = normalizeCloudUrl(new URL(location,url).href);
            if (url.startsWith('https:') && next.startsWith('http:')) throw new UserError('Сервис перенаправляет на незащищённое соединение. ' + CLOUD_FALLBACK);
            url = await resolveCloudDownload(next, { openResponse, signal }); continue;
          }
          if (response.statusCode === 200 && /text\/html|application\/xhtml/i.test(response.headers['content-type'] || '') && googleFileId(new URL(url))) {
            const html = await smallResponse(response);
            const next = googleConfirmation(html, url);
            response.destroy();
            if (!next) {
              if (/quota|too many users|download limit|превышен.{0,40}лимит/i.test(html)) throw new UserError('Google Drive: превышен лимит скачивания файла. Повторите позже. ' + CLOUD_FALLBACK);
              throw new UserError('Google Drive не разрешил скачать файл. Откройте доступ «Все, у кого есть ссылка» и разрешите скачивание. ' + CLOUD_FALLBACK);
            }
            if (hops === 5) throw new UserError('Google Drive повторяет подтверждение скачивания. ' + CLOUD_FALLBACK);
            url = normalizeCloudUrl(next); continue;
          }
          break;
        }
        if (response.statusCode === 429) throw new UserError('Облачный сервис ограничил частоту запросов или скачиваний. Повторите получение позже. ' + CLOUD_FALLBACK);
        if (![200,206].includes(response.statusCode)) throw new UserError('Сервис не разрешил скачать файл: ссылка недоступна, истекла или требует авторизации. ' + CLOUD_FALLBACK);
        if (/text\/|application\/(json|xhtml)/i.test(response.headers['content-type'] || '')) {
          if (['drive.google.com','drive.usercontent.google.com'].includes(new URL(url).hostname)) {
            await smallResponse(response);
            throw new UserError('Google Drive вернул страницу вместо файла: требуется вход, подтверждение или разрешение владельца на скачивание. ' + CLOUD_FALLBACK);
          }
          throw new UserError('По ссылке открывается страница, а не видеофайл. Возможно, требуется вход в облачный сервис. ' + CLOUD_FALLBACK);
        }
        const contentLength = Number(response.headers['content-length']);
        if (response.statusCode === 206) {
          const range = response.headers['content-range']?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          const currentValidator = response.headers.etag || response.headers['last-modified'];
          if (!size || !validator || !range || Number(range[1]) !== size || Number(range[2]) < size || Number(range[2]) >= Number(range[3]) || (expectedTotal && Number(range[3]) !== expectedTotal) || (currentValidator && currentValidator !== validator)) throw new UserError('Облачный сервис вернул некорректный диапазон при докачке. ' + CLOUD_FALLBACK);
          expectedTotal = Number(range[3]);
        } else {
          // A server may ignore Range or return a changed file. Restart cleanly;
          // appending this response would silently corrupt the recording.
          if (file) await file.truncate(0);
          size = 0; prefix = Buffer.alloc(0); hash = createHash('sha256');
          expectedTotal = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
          const etag = response.headers.etag;
          validator = etag && !etag.startsWith('W/') ? etag : response.headers['last-modified'];
          downloadHeaders = response.headers;
        }
        if (contentLength > maxBytes || expectedTotal > maxBytes) throw new UserError('Файл больше 1 ГБ. Выберите более короткую запись.');
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new UserError('Сервис вернул сжатый ответ вместо видеофайла. ' + CLOUD_FALLBACK);
        file ||= await open(partial,'wx');
        phase = 'скачивание файла';
        const startSize = size;
        onProgress({received:size,total:expectedTotal,retries:attempt});
        for await (const chunk of response) {
          if (size + chunk.length > maxBytes) throw new UserError('Файл больше 1 ГБ. Выберите более короткую запись.');
          let written = 0;
          while (written < chunk.length) {
            const result = await file.write(chunk, written, chunk.length-written, size+written);
            if (!result.bytesWritten) throw Object.assign(new Error('No bytes written'),{code:'EIO'});
            written += result.bytesWritten;
          }
          size += chunk.length;
          if (prefix.length < 32) prefix=Buffer.concat([prefix,chunk.subarray(0,32-prefix.length)]);
          hash.update(chunk);
          onProgress({received:size,total:expectedTotal,retries:attempt});
        }
        if ((Number.isSafeInteger(contentLength) && contentLength > 0 && size-startSize !== contentLength) || (expectedTotal && size !== expectedTotal)) throw Object.assign(new Error('Incomplete download'), {code:'ECONNRESET'});
        if (!size) throw new UserError('Облачный сервис вернул пустой файл. ' + CLOUD_FALLBACK);
        const extension = prefix.subarray(4,8).toString() === 'ftyp' ? '.mp4' : prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) ? '.webm' : null;
        if (!extension) throw new UserError('Ссылка не вернула видео MP4/WebM. ' + CLOUD_FALLBACK);
        await file.sync(); await file.close(); file=null;
        await rename(partial,join(directory,`source${extension}`));
        return {filename:filename(downloadHeaders || response.headers,url,extension),extension,sourceHash:hash.digest('hex'),sourceBytes:size};
      } catch (error) {
        response?.destroy(); response = null;
        const codes = [error.code, error.cause?.code, ...(error.errors || []).map(e => e.code)];
        const transient = codes.some(code => ['ECONNRESET','ETIMEDOUT','EPIPE','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ERR_STREAM_PREMATURE_CLOSE'].includes(code));
        if (error instanceof UserError || signal.aborted || !transient || attempt === 2) throw error;
        logError(`cloud-download:retry:${phase}:${size}`,error);
        if (!validator) {
          size=0; expectedTotal=null; prefix=Buffer.alloc(0); hash=createHash('sha256');
          if (file) await file.truncate(0);
        }
        onProgress({received:size,total:expectedTotal,retries:attempt+1});
        await wait(1000 * (attempt+1), undefined, {signal});
      }
    }
  } catch(error) {
    if (error instanceof UserError) throw error;
    if (['ENOSPC','EACCES','EPERM','EIO'].includes(error.code)) throw error;
    logError(`cloud-download:failed:${phase}:${size}`,error);
    const code = error.code || error.cause?.code;
    const reason = signal.aborted ? 'истекло общее время ожидания' : code === 'ETIMEDOUT' ? 'сервер слишком долго не передавал данные' : 'соединение прервалось';
    throw new UserError(`Не удалось получить файл: ${reason}. Получено ${(size/1024/1024).toFixed(1)} МБ${expectedTotal ? ` из ${(expectedTotal/1024/1024).toFixed(1)} МБ` : ''}. Этап: ${phase}${code ? `; код ${code}` : ''}. Нажмите «Повторить получение». ` + CLOUD_FALLBACK);
  } finally { response?.destroy(); await file?.close(); await rm(partial,{force:true}); }
}
