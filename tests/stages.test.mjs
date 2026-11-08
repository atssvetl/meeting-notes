import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { fixture, upload, settle, media } from './helpers.mjs';
import { runMedia } from '../lib/media.mjs';
import { readUsage } from '../lib/usage.mjs';
import { localStatus } from '../lib/local-asr.mjs';

async function action(base, id, name, method = 'POST', body) {
  return fetch(`${base}/api/meetings/${id}${name ? '/' + name : ''}`, {
    method, headers: { 'X-Meeting-Upload': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
}
async function spokenVideo(f) {
  const path = join(f.directory, 'speech.mp4');
  await runMedia(f.config.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1',
    '-i', join(f.config.localModelDir, 'test_wavs/example.wav'), '-shortest', '-c:v', 'libx264', '-c:a', 'aac', path]);
  return readFile(path);
}

test('Ручные этапы: загрузка → настоящая транскрибация → повтор конспекта, удаление и сохранение журнала', async t => {
  const f = await fixture();
  try {
    if (!(await localStatus(f.config)).available) return t.skip('Требуется установленная локальная модель');
    const res = await upload(f.base, 'speech.mp4', await spokenVideo(f), 'local', { autoTranscribe: false, autoSummary: false });
    assert.equal(res.status, 202); const { id } = await res.json();
    const uploaded = await settle(f.base, id);
    assert.equal(uploaded.status, 'uploaded'); assert.equal(uploaded.sourceAvailable, true);
    assert.deepEqual(uploaded.stages, { upload: 'done', transcription: 'pending', summary: 'pending' });
    await access(f.store.sourcePath(uploaded)); assert.equal((await readUsage(f.config.dataDir)).entries.length, 0);
    assert.equal((await action(f.base, id, 'summarize')).status, 409);
    const starts = await Promise.all([action(f.base, id, 'transcribe'), action(f.base, id, 'transcribe')]);
    assert.deepEqual(starts.map(x => x.status).sort(), [202, 409]);
    const transcribed = await settle(f.base, id);
    assert.equal(transcribed.status, 'transcribed'); assert.match(transcribed.transcript.toLowerCase(), /лукоморья/);
    const txtPath = join(f.store.records, `${id}.txt`);
    const readable = await readFile(txtPath, 'utf8');
    assert.match(readable, /ПОЛНАЯ РАСШИФРОВКА/);
    assert(transcribed.transcriptSegments.length > 0);
    assert.equal(transcribed.transcriptSegments.map(s => s.text).join(' '), transcribed.transcript);
    for (const segment of transcribed.transcriptSegments) assert(readable.replace(/\s+/g, ' ').includes(segment.text.replace(/\s+/g, ' ')));
    assert.match(readable, /\[00:00:\d{2}\.\d{3} – 00:00:\d{2}\.\d{3}\] Спикер 1/);
    const download = await fetch(`${f.base}/api/meetings/${id}/text`);
    assert.match(download.headers.get('content-type'), /text\/plain/);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(await download.text(), readable);
    assert.equal(transcribed.stages.summary, 'pending'); assert.equal(transcribed.error, null);
    assert.equal((await action(f.base, id, 'transcribe')).status, 409);
    assert.equal((await action(f.base, id, 'summarize')).status, 202);
    const failed = await settle(f.base, id);
    assert.equal(failed.stages.summary, 'error'); assert.equal(failed.stages.transcription, 'done');
    assert.equal(failed.transcript, transcribed.transcript);
    assert.deepEqual(await readdir(f.store.temp), []);
    const foreign = await fetch(`${f.base}/api/meetings/${id}`, { method: 'DELETE', headers: { 'X-Meeting-Upload': '1', Origin: 'https://example.com' } });
    assert.equal(foreign.status, 403); assert(f.store.items.has(id));
    assert.equal((await action(f.base, id, 'source', 'DELETE')).status, 200);
    await assert.rejects(access(f.store.sourcePath(uploaded)));
    assert.equal(f.store.items.get(id).transcript, transcribed.transcript);
    assert.equal((await action(f.base, id, 'summarize')).status, 202);
    await settle(f.base, id);
    const log = await readUsage(f.config.dataDir);
    assert.equal(log.entries.length, 1); assert.equal(log.entries[0].provider, 'local');
    assert.match(await readFile(join(f.config.dataDir, 'usage.log'), 'utf8'), /Локальная транскрибация/);
    const logApi = await (await fetch(f.base + '/api/usage')).json(); assert.equal(logApi.entries.length, 1);
    assert.equal((await fetch(f.base + '/api/usage/download')).status, 200);
    assert.equal((await action(f.base, id, '', 'DELETE')).status, 200);
    assert.equal(f.store.items.has(id), false);
    await assert.rejects(access(join(f.store.records, `${id}.json`)));
    await assert.rejects(access(txtPath));
    assert.equal((await fetch(`${f.base}/api/meetings/${id}/text`)).status, 404);
    assert.equal((await readUsage(f.config.dataDir)).entries.length, 1);
    assert.equal((await action(f.base, id, '', 'DELETE')).status, 404);
  } finally { await f.cleanup(); }
});

test('Автотранскрибация останавливается перед ручным конспектом; включение авто продолжает следующий этап', async t => {
  const f = await fixture();
  try {
    if (!(await localStatus(f.config)).available) return t.skip('Требуется установленная локальная модель');
    const response = await upload(f.base, 'auto.mp4', await spokenVideo(f), 'local', { autoTranscribe: true, autoSummary: false });
    const { id } = await response.json();
    const item = await settle(f.base, id);
    assert.equal(item.status, 'transcribed'); assert.equal(item.stages.summary, 'pending');
    const settings = { transcriptionMode: 'local', autoTranscribe: true, autoSummary: true };
    assert.equal((await action(f.base, id, 'settings', 'POST', settings)).status, 202);
    const failed = await settle(f.base, id);
    assert.equal(failed.stages.summary, 'error');
    // Updating settings never silently retries a failed paid step.
    assert.equal((await action(f.base, id, 'settings', 'POST', settings)).status, 200);
    assert.equal(f.store.items.get(id).stages.summary, 'error');
  } finally { await f.cleanup(); }
});

test('Разметка старой встречи сохраняет прежний текст и конспект без платных запросов', async t => {
  const f = await fixture();
  try {
    if (!(await localStatus(f.config)).available) return t.skip('Требуются локальные модели');
    const response = await upload(f.base, 'legacy.mp4', await spokenVideo(f), 'local', { autoTranscribe: true, autoSummary: false });
    const { id } = await response.json();
    const item = await settle(f.base, id);
    const previous = item.transcript;
    // Recreate the legacy on-disk shape using a real recognized transcript.
    delete item.transcriptSegments; delete item.diarization;
    item.summary = { overview: previous, decisions: [], tasks: [], questions: [] };
    item.stages.summary = 'done'; item.autoSummary = true; item.status = 'ready';
    await f.store.save(item);
    assert.equal((await action(f.base, id, 'annotate')).status, 202);
    const updated = await settle(f.base, id);
    assert.equal(updated.status, 'ready'); assert.equal(updated.error, null);
    assert.deepEqual(updated.summary, item.summary);
    assert.equal(updated.transcriptBeforeDiarization, previous);
    assert(updated.transcriptSegments.length > 0);
    assert.equal((await action(f.base, id, 'annotate')).status, 409);
    assert((await readUsage(f.config.dataDir)).entries.every(e => e.provider === 'local' && e.estimatedCostUsd === 0));
    assert.deepEqual(await readdir(f.store.temp), []);
  } finally { await f.cleanup(); }
});

test('Ожидающий файл переживает перезапуск; удаление файла запрещает транскрибацию; удаление встречи завершается после сбоя', async () => {
  const f = await fixture(); let restarted;
  try {
    const file = await media(f.directory, f.config, 'tone');
    const response = await upload(f.base, 'later.mp4', file.bytes, 'online', { autoTranscribe: false, autoSummary: false });
    const { id } = await response.json(); await settle(f.base, id);
    await f.close(); restarted = await createApplication(f.config);
    await new Promise(r => restarted.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${restarted.server.address().port}`;
    const item = restarted.store.items.get(id);
    assert.equal(item.status, 'uploaded'); await access(restarted.store.sourcePath(item));
    assert.equal((await action(base, id, 'source', 'DELETE')).status, 200);
    assert.equal((await action(base, id, 'transcribe')).status, 409);
    await restarted.store.save({ ...item, status: 'deleting' }); await restarted.close();
    restarted = await createApplication(f.config);
    assert.equal(restarted.store.items.has(id), false);
    await assert.rejects(access(join(restarted.store.records, `${id}.json`)));
  } finally { await restarted?.close(); await f.cleanup(); }
});
