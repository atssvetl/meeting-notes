import http from 'node:http';
import { readFile, mkdir, open, rm } from 'node:fs/promises';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { meetingText } from './lib/text-export.mjs';
import { MAX_BYTES, MAX_SECONDS, UserError, logError } from './lib/common.mjs';
import { extractAudio, hasSound, inspectMedia } from './lib/media.mjs';
import { transcribe, summarize } from './lib/ai.mjs';
import { recordUsage, readUsage, totals } from './lib/usage.mjs';
import { LOCAL_MODEL, localStatus, transcribeLocalDetailed } from './lib/local-asr.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export function configuration() {
  return { dataDir: resolve(root, process.env.DATA_DIR || 'data'), key: process.env.OPENAI_API_KEY || '',
    localPython: process.env.LOCAL_PYTHON || resolve(root, '.venv-local', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    localModelDir: resolve(root, process.env.LOCAL_MODEL_DIR || `models/${LOCAL_MODEL}`),
    diarizationModelDir: resolve(root, process.env.DIARIZATION_MODEL_DIR || 'models/diarization'),
    localThreads: Math.max(1, Math.min(16, Number(process.env.LOCAL_THREADS) || 2)),
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
    transcribeModel: process.env.TRANSCRIBE_MODEL || 'gpt-transcribe', summaryModel: process.env.SUMMARY_MODEL || 'gpt-4.1-mini' };
}
async function lockDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid)); await handle.sync(); await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Не удалось прочитать server.lock. Убедитесь, что сервер остановлен, и удалите этот файл.');
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Этот каталог данных уже использует другой процесс. Остановите его перед запуском.');
      await rm(path, { force: true });
    }
  }
  throw new Error('Не удалось заблокировать каталог данных.');
}

export async function createApplication(config = configuration()) {
  const unlock = await lockDirectory(config.dataDir);
  const store = new Store(config.dataDir);
  try { await store.init(); } catch (error) { await unlock(); throw error; }
  const local = await localStatus(config);
  let busy = false;
  let job = null;
  let storageFailed = false;
  let handlers = 0;
  let handlersDone;
  let closing;
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  async function processMeeting(item, firstStage) {
    const directory = join(store.temp, item.id);
    let stage = firstStage;
    const aiConfig = { ...config, meetingId: item.id, onUsage: entry => recordUsage(config.dataDir, entry) };
    const begin = async name => {
      stage = name; item.activeStage = name; item.status = 'processing'; item.stages[name] = 'running'; item.error = null;
      await store.save(item);
    };
    try {
      if (firstStage === 'upload') {
        await begin('upload');
        await inspectMedia(store.sourcePath(item), config);
        item.sourceAvailable = true; item.stages.upload = 'done'; item.activeStage = null; item.status = 'uploaded';
        await store.save(item);
      }
      if (['transcription', 'annotate'].includes(firstStage) || (firstStage === 'upload' && item.autoTranscribe)) {
        await begin('transcription');
        if (item.transcriptionMode === 'local' && !local.available) throw new UserError('Локальная модель не установлена. Выполните npm run setup:local и перезапустите сервер.', 503);
        await mkdir(directory, { recursive: true });
        const chunks = await extractAudio(store.sourcePath(item), directory, config);
        let audible = false;
        for (const chunk of chunks) if (await hasSound(chunk, config)) { audible = true; break; }
        if (!audible) throw new UserError('Не удалось распознать речь. Возможно, запись содержит только тишину.');
        let result;
        if (item.transcriptionMode === 'local' || firstStage === 'annotate') {
          result = await transcribeLocalDetailed(chunks, aiConfig);
        } else {
          if (!config.key) throw new UserError('Не настроен ключ OpenAI. Добавьте OPENAI_API_KEY в .env и перезапустите сервер.', 503);
          const turnsDirectory = join(directory, 'turns');
          result = await transcribeLocalDetailed(chunks, aiConfig, turnsDirectory);
          for (const segment of result.segments) {
            segment.text = await transcribe(join(turnsDirectory, segment.file), aiConfig);
            delete segment.file;
          }
          result.segments = result.segments.filter(s => s.text.trim());
          result.text = result.segments.map(s => s.text).join(' ');
        }
        if (!result.text.trim()) throw new UserError('Не удалось распознать речь. Возможно, запись содержит только тишину.');
        if (firstStage === 'annotate') item.transcriptBeforeDiarization ??= item.transcript;
        item.transcript = result.text.trim();
        item.transcriptSegments = result.segments;
        item.diarization = { model: 'pyannote-3.0 + wespeaker-resnet34', createdAt: new Date().toISOString(), localReprocessing: firstStage === 'annotate' };
        item.stages.transcription = 'done'; item.activeStage = null; item.status = 'transcribed';
        if (firstStage === 'annotate' && item.stages.summary === 'done') item.status = 'ready';
        await store.save(item);
        await rm(directory, { recursive: true, force: true });
      }
      if (firstStage !== 'annotate' && (firstStage === 'summary' || (item.stages.transcription === 'done' && item.autoSummary))) {
        await begin('summary');
        item.summary = await summarize(item.transcript, aiConfig);
        item.stages.summary = 'done'; item.activeStage = null; item.status = 'ready';
      }
    } catch (error) {
      logError(`meeting:${item.id}`, error);
      item.status = 'error'; item.stages[stage] = 'error'; item.activeStage = null;
      item.error = error instanceof UserError ? error.message : 'Не удалось выполнить этап. Проверьте файл и повторите попытку.';
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
        if (item.stages.upload !== 'done') await rm(store.sourceDirectory(item.id), { recursive: true, force: true });
      } catch (error) { storageFailed = true; logError('cleanup', error); }
      try { await store.save(item); }
      catch (error) { storageFailed = true; logError('save-result', error); }
      busy = false;
    }
  }
  const server = http.createServer(async (req, res) => {
    handlers++;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) throw new UserError('Недопустимый адрес сервера.', 403);
      const url = new URL(req.url, 'http://localhost');
      if (['POST', 'DELETE', 'PATCH'].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new UserError('Запрос с другого сайта запрещён.', 403);
        if (req.headers['x-meeting-upload'] !== '1') throw new UserError('Некорректный запрос.', 400);
        if (storageFailed) throw new UserError('Не удалось сохранить данные. Проверьте свободное место и перезапустите сервер.', 503);
        if (busy) throw new UserError('Уже обрабатывается запись. Дождитесь её завершения.', 409);
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const log = await readUsage(config.dataDir);
        return json(res, 200, { ...log, totals: totals(log.entries) });
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/download') {
        const log = await readUsage(config.dataDir);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="usage.jsonl"' });
        return res.end(log.entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      }
      if (req.method === 'GET' && url.pathname === '/api/meetings') {
        return json(res, 200, { meetings: store.list(), busy, storageFailed, configured: Boolean(config.key), local, maxBytes: MAX_BYTES, maxSeconds: MAX_SECONDS });
      }
      if (req.method === 'POST' && url.pathname === '/api/meetings') {
        const transcriptionMode = req.headers['x-transcription-mode'] || 'online';
        if (!['local', 'online'].includes(transcriptionMode)) throw new UserError('Выберите локальную или онлайн-расшифровку.');
        for (const key of ['x-auto-transcribe', 'x-auto-summary']) if (req.headers[key] !== undefined && !['true', 'false'].includes(req.headers[key])) throw new UserError('Некорректный режим автозапуска.');
        let filename;
        try { filename = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw new UserError('Не удалось прочитать имя файла.'); }
        if (!filename || filename.length > 500) throw new UserError('Имя файла отсутствует или слишком длинное.');
        const extension = extname(filename).toLowerCase();
        if (!['.mp4', '.webm'].includes(extension)) throw new UserError('Формат файла не поддерживается. Загрузите WebM или MP4.');
        if (Number(req.headers['content-length']) > MAX_BYTES) throw new UserError('Файл больше 1 ГБ. Выберите более короткую запись.', 413);
        busy = true;
        const item = { id: randomUUID(), filename, extension, transcriptionMode, createdAt: new Date().toISOString(), status: 'processing', transcript: '', summary: null, error: null,
          sourceAvailable: false, autoTranscribe: req.headers['x-auto-transcribe'] !== 'false', autoSummary: req.headers['x-auto-summary'] !== 'false',
          activeStage: 'upload', stages: { upload: 'running', transcription: 'pending', summary: 'pending' } };
        const directory = store.sourceDirectory(item.id);
        let handle;
        try {
          await mkdir(directory);
          await store.save(item);
          const video = join(directory, `source${extension}`);
          handle = await open(video, 'wx');
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BYTES) throw new UserError('Файл больше 1 ГБ. Выберите более короткую запись.', 413);
            await handle.writeFile(chunk);
          }
          await handle.close(); handle = null;
          if (!size) throw new UserError('Файл пустой. Выберите другую запись.');
          job = processMeeting(item, 'upload');
          return json(res, 202, { id: item.id });
        } catch (error) {
          try {
            await handle?.close();
            await rm(directory, { recursive: true, force: true });
            item.status = 'error'; item.error = error instanceof UserError ? error.message : 'Загрузка прервалась. Выберите файл ещё раз.';
            item.stages.upload = 'error'; item.activeStage = null;
            await store.save(item);
          } catch (e) { storageFailed = true; logError('save-upload-error', e); }
          finally { busy = false; }
          throw error;
        }
      }
      const actionRoute = url.pathname.match(/^\/api\/meetings\/([a-f0-9-]{36})(?:\/(source|transcribe|summarize|annotate|settings|text))?$/);
      if (actionRoute) {
        const [, id, action] = actionRoute;
        const existing = store.items.get(id);
        if (!existing) throw new UserError('Встреча не найдена.', 404);
        const item = structuredClone(existing);
        if (req.method === 'GET' && action === 'text') {
          if (!item.transcript?.trim()) throw new UserError('Расшифровка ещё не создана.', 409);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="meeting-${id}.txt"` });
          return res.end(meetingText(item));
        }
        if (req.method === 'DELETE' && (!action || action === 'source')) {
          busy = true;
          try {
            if (action === 'source') await store.deleteSource(item); else await store.remove(item);
            return json(res, 200, { ok: true });
          } finally { busy = false; }
        }
        if (req.method === 'POST' && action === 'settings') {
          busy = true;
          try {
            let body = '';
            for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new UserError('Слишком большой запрос.', 413); }
            let settings;
            try { settings = JSON.parse(body); } catch { throw new UserError('Некорректные настройки.'); }
            if (!settings || !['local', 'online'].includes(settings.transcriptionMode) || typeof settings.autoTranscribe !== 'boolean' || typeof settings.autoSummary !== 'boolean') throw new UserError('Некорректные настройки.');
            if (item.stages.transcription === 'done' && settings.transcriptionMode !== item.transcriptionMode) throw new UserError('Расшифровка уже выполнена; её режим нельзя изменить.');
            Object.assign(item, { transcriptionMode: settings.transcriptionMode, autoTranscribe: settings.autoTranscribe, autoSummary: settings.autoSummary });
            await store.save(item);
            // Enabling auto advances only a pending step, never silently retries a paid failure.
            if (item.stages.transcription === 'pending' && item.sourceAvailable && item.autoTranscribe) {
              job = processMeeting(item, 'transcription'); return json(res, 202, { id });
            }
            if (item.stages.transcription === 'done' && item.stages.summary === 'pending' && item.autoSummary) {
              job = processMeeting(item, 'summary'); return json(res, 202, { id });
            }
            busy = false;
            return json(res, 200, { ok: true });
          } catch (error) { busy = false; throw error; }
        }
        if (req.method === 'POST' && action === 'annotate') {
          if (!item.transcript || item.transcriptSegments?.length) throw new UserError('Разметка уже есть или расшифровка ещё не создана.', 409);
          if (!item.sourceAvailable) throw new UserError('Для разметки нужен исходный файл. Загрузите запись заново.', 409);
          if (!local.available) throw new UserError('Установите локальные модели: npm run setup:local. Затем перезапустите сервер.', 503);
          busy = true; job = processMeeting(item, 'annotate');
          return json(res, 202, { id });
        }
        if (req.method === 'POST' && ['transcribe', 'summarize'].includes(action)) {
          const stage = action === 'transcribe' ? 'transcription' : 'summary';
          if (item.stages[stage] === 'done') throw new UserError('Этот этап уже выполнен.', 409);
          if (stage === 'transcription' && !item.sourceAvailable) throw new UserError('Исходный файл отсутствует. Загрузите запись заново.', 409);
          if (stage === 'summary' && !item.transcript?.trim()) throw new UserError('Сначала выполните транскрибацию.', 409);
          busy = true; job = processMeeting(item, stage);
          return json(res, 202, { id });
        }
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        const body = await readFile(join(root, 'public', name));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(body);
      }
      throw new UserError('Страница не найдена.', 404);
    } catch (error) {
      logError('http-request', error);
      if (!res.headersSent && !res.destroyed) json(res, error instanceof UserError ? error.status : 500, { error: error instanceof UserError ? error.message : 'Ошибка сервера. Проверьте свободное место и повторите попытку.' });
    } finally { handlers--; if (!handlers) handlersDone?.(); }
  });
  server.requestTimeout = 10 * 60_000;
  return { server, store, close() {
    closing ??= (async () => {
      await new Promise((done, reject) => server.close(e => e && e.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(e) : done()));
      if (handlers) await new Promise(done => { handlersDone = done; });
      await job; await unlock();
    })();
    return closing;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await createApplication();
    const port = Number(process.env.PORT || 3030);
    app.server.on('error', async error => { logError('listen', error); await app.close(); process.exitCode = 1; });
    app.server.listen(port, '127.0.0.1', () => console.log(`Конспект встреч: http://127.0.0.1:${app.server.address().port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
