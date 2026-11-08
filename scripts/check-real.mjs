import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration, createApplication } from '../server.mjs';
import { validateSummary } from '../lib/ai.mjs';
import { upload, state, settle } from '../tests/helpers.mjs';
import { runMedia } from '../lib/media.mjs';

const paths = process.argv.slice(2).map(x => resolve(x));
if (!paths.length) {
  console.error('Укажите реальные записи: npm run test:real -- путь/встреча.mp4 путь/встреча.webm');
  process.exit(1);
}
const directory = await mkdtemp(join(tmpdir(), 'meeting-real-'));
const config = { ...configuration(), dataDir: join(directory, 'data') };
let app;
const report = { date: new Date().toISOString(), aiConfigured: Boolean(config.key), results: [] };
try {
  app = await createApplication(config);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of paths) {
    const info = JSON.parse((await runMedia(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path])).stdout);
    const duration = Number(info.format.duration);
    assert(duration >= 120 && duration <= 301, 'Для приёмки используйте запись длительностью 2–5 минут');
    const res = await upload(base, basename(path), await readFile(path));
    assert.equal(res.status, 202);
    const result = await settle(base, (await res.json()).id, 20 * 60_000);
    if (config.key) {
      assert.equal(result.status, 'ready', result.error);
      assert(result.transcript.trim()); validateSummary(result.summary);
    } else {
      assert.equal(result.status, 'error');
      assert.match(result.error, /Не настроен ключ/, 'Реальное аудио должно дойти до вызова распознавания');
      assert.equal(result.transcript, ''); assert.equal(result.summary, null);
    }
    assert.deepEqual(await readdir(app.store.temp), []);
    report.results.push({ file: basename(path), duration, status: result.status,
      checked: config.key ? 'Загрузка, распознавание, структурированный конспект, очистка' : 'Загрузка, проверка контейнера, извлечение аудио, отсутствие ключа, очистка',
      transcriptCharacters: result.transcript.length });
  }
  const before = (await state(base)).meetings;
  await app.close();
  app = await createApplication(config);
  assert.deepEqual(app.store.list(), before);
  report.persistence = 'Подтверждено после перезапуска приложения';
  await mkdir(resolve('test-output'), { recursive: true });
  await writeFile(resolve('test-output/real-check.json'), JSON.stringify(report, null, 2));
  // Actual successful results only, for manual factual review; never substitute generated fixtures.
  if (config.key) await writeFile(resolve('test-output/real-results.json'), JSON.stringify(before, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!config.key) console.log('Распознавание и генерация НЕ проверены: отсутствует OPENAI_API_KEY.');
} finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
