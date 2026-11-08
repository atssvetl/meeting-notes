import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { fixture, upload, settle } from '../tests/helpers.mjs';
import { readUsage } from '../lib/usage.mjs';
const files = process.argv.slice(2);
if (!files.length) throw new Error('Укажите реальные MP4/WebM: npm run test:local -- путь.mp4 путь.webm');
const f = await fixture(); // Explicit empty API key: this check never calls OpenAI.
const report = [];
try {
  for (const file of files) {
    const start = Date.now();
    const res = await upload(f.base, basename(file), await readFile(resolve(file)), 'local');
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    const item = await settle(f.base, (await res.json()).id, 30 * 60_000);
    assert.equal(item.transcriptionMode, 'local');
    assert(item.transcript.length > 100, item.error);
    assert.match(item.transcript, /[а-яё]/i);
    assert.equal(item.summary, null);
    assert.match(item.error, /Не настроен ключ/);
    assert.deepEqual(await readdir(f.store.temp), []);
    const disk = JSON.parse(await readFile(join(f.store.records, `${item.id}.json`), 'utf8'));
    assert.equal(disk.transcript, item.transcript);
    report.push({ file: basename(file), elapsedSeconds: (Date.now() - start) / 1000,
      transcriptCharacters: item.transcript.length, mode: item.transcriptionMode, summary: 'Не запрашивался: тест без ключа', apiCostUsd: 0 });
    await mkdir(resolve('test-output'), { recursive: true });
    await writeFile(resolve('test-output', `${basename(file)}.local.txt`), item.transcript);
  }
  const usage = await readUsage(f.config.dataDir);
  assert.equal(usage.entries.length, files.length);
  assert(usage.entries.every(e => e.provider === 'local' && e.estimatedCostUsd === 0));
  await writeFile(resolve('test-output/local-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await f.cleanup(); }
