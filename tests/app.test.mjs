import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, upload, state, settle, media } from './helpers.mjs';
import { Store } from '../lib/store.mjs';
import { createApplication } from '../server.mjs';
import { validateSummary, summarize } from '../lib/ai.mjs';

test('Сервер отклоняет пустые/неподдерживаемые файлы, чужой Origin и скрытые пути', async () => {
  const f = await fixture();
  try {
    assert.equal((await upload(f.base, 'file.txt', 'text')).status, 400);
    const empty = await upload(f.base, 'empty.mp4', ''); assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /пустой/);
    assert.equal((await state(f.base)).busy, false);
    const evil = await fetch(f.base + '/api/meetings', { method: 'POST', headers: { Origin: 'https://example.com', 'X-Meeting-Upload': '1' } });
    assert.equal(evil.status, 403);
    assert.equal((await fetch(f.base + '/.env')).status, 404);
    assert.equal((await fetch(f.base + '/data/meetings')).status, 404);
    const hostStatus = await new Promise((done, reject) => {
      http.get(f.base, { headers: { Host: 'evil.example' } }, res => { res.resume(); done(res.statusCode); }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
  } finally { await f.cleanup(); }
});

test('Настоящий FFmpeg: повреждение, отсутствие аудио, тишина MP4 и WebM, отсутствующий ключ', async () => {
  const f = await fixture();
  try {
    const corrupt = await upload(f.base, '../../повреждённый.mp4', 'this is not media');
    const corruptItem = await settle(f.base, (await corrupt.json()).id);
    assert.equal(corruptItem.status, 'error'); assert.match(corruptItem.error, /повреждён/);
    for (const [kind, ext, expected] of [['no-audio', 'mp4', /нет аудиодорожки/], ['silence', 'mp4', /распознать речь/], ['silence', 'webm', /распознать речь/], ['tone', 'mp4', /Не настроен ключ/]]) {
      const file = await media(f.directory, f.config, kind, ext);
      const res = await upload(f.base, `${kind}.${ext}`, file.bytes); assert.equal(res.status, 202);
      const result = await settle(f.base, (await res.json()).id);
      assert.equal(result.status, 'error'); assert.match(result.error, expected);
      assert.equal(result.summary, null); assert.equal(result.transcript, '');
      assert.deepEqual(await readdir(f.store.temp), []);
      assert.equal((await state(f.base)).busy, false);
    }
    const snapshot = await state(f.base);
    assert.equal(snapshot.meetings.length, 5);
    const reloadStore = new Store(f.config.dataDir); await reloadStore.init();
    assert.deepEqual(reloadStore.list(), snapshot.meetings);
    const persisted = JSON.parse(await readFile(join(f.store.records, `${corruptItem.id}.json`), 'utf8'));
    assert.equal(persisted.filename, '../../повреждённый.mp4');
  } finally { await f.cleanup(); }
});

test('Одна задача: вторая загрузка отклоняется, GET не создаёт дубликатов, разрыв освобождает блокировку', async () => {
  const f = await fixture();
  let req;
  try {
    req = http.request(f.base + '/api/meetings', { method: 'POST', headers: { 'X-Meeting-Upload': '1', 'X-File-Name': 'slow.mp4', 'Content-Type': 'application/octet-stream' } });
    req.on('error', () => {}); req.write(Buffer.from('pending'));
    for (let i = 0; i < 100 && !(await state(f.base)).busy; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal((await state(f.base)).busy, true);
    assert.equal((await upload(f.base, 'another.mp4', 'x')).status, 409);
    for (let i = 0; i < 100 && !(await state(f.base)).meetings.length; i++) await new Promise(r => setTimeout(r, 20));
    for (let i = 0; i < 3; i++) assert.equal((await state(f.base)).meetings.length, 1);
    const id = (await state(f.base)).meetings[0].id;
    req.destroy();
    const result = await settle(f.base, id);
    assert.equal(result.status, 'error'); assert.match(result.error, /Загрузка прервалась/);
    assert.deepEqual(await readdir(f.store.temp), []);
  } finally { req?.destroy(); await f.cleanup(); }
});

test('Перезапуск: восстановление прерванной задачи и удаление оставшихся медиа', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.store.save({ id, filename: 'interrupted.mp4', createdAt: new Date().toISOString(), status: 'processing', transcript: '', summary: null, error: null });
    await mkdir(join(f.store.temp, id)); await writeFile(join(f.store.temp, id, 'source.mp4'), 'leftover');
    await f.close();
    const restarted = await createApplication(f.config);
    try {
      assert.equal(restarted.store.list()[0].status, 'error'); assert.match(restarted.store.list()[0].error, /прервана/);
      assert.deepEqual(await readdir(restarted.store.temp), []);
      await assert.rejects(createApplication(f.config), /другой процесс/);
    } finally { await restarted.close(); }
  } finally { await f.cleanup(); }
});

test('Проверка структуры конспекта: обязательные поля, типы, отсутствие лишних полей', async () => {
  const valid = { overview: 'Текст для проверки схемы', decisions: [], tasks: [{ action: 'Проверка схемы', owner: null, deadline: null }], questions: [] };
  assert.deepEqual(validateSummary(valid), valid);
  for (const invalid of [null, {}, { ...valid, overview: '' }, { ...valid, decisions: 'x' }, { ...valid, extra: true }, { ...valid, tasks: [{ action: 'x', owner: 1, deadline: null }] }]) assert.throws(() => validateSummary(invalid), /корректный конспект/);
  await assert.rejects(summarize('', { key: '' }), /распознать речь/);
});
