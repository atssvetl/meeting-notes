import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { configuration } from '../server.mjs';
import { localStatus, transcribeLocal } from '../lib/local-asr.mjs';
import { totals } from '../lib/usage.mjs';
import { fixture, upload } from './helpers.mjs';

test('Некорректный режим не создаёт встречу', async () => {
  const f = await fixture();
  try {
    assert.equal((await upload(f.base, 'video.mp4', 'bytes', 'invalid')).status, 400);
    assert.equal(f.store.list().length, 0);
  } finally { await f.cleanup(); }
});
test('Отсутствующая локальная модель даёт ошибку, без перехода на онлайн', async () => {
  const config = { ...configuration(), localModelDir: 'missing-model-directory' };
  assert.equal((await localStatus(config)).available, false);
  await assert.rejects(transcribeLocal(['missing.wav'], config), /Облачное распознавание автоматически не запускается/);
});
test('Установленная модель действительно распознаёт русский WAV и не расходует токены API', async t => {
  const config = configuration();
  if (!(await localStatus(config)).available) return t.skip('Запустите npm run setup:local');
  const entries = [];
  const text = await transcribeLocal([join(config.localModelDir, 'test_wavs/example.wav')], { ...config, onUsage: async e => entries.push(e), meetingId: 'local-test' });
  assert.match(text.toLowerCase(), /лукоморья/);
  assert.equal(entries.length, 1); assert.equal(entries[0].estimatedCostUsd, 0);
  assert.equal(entries[0].provider, 'local'); assert.equal(entries[0].totalTokens, null);
  assert.equal(totals(entries).requests, 0); assert.equal(totals(entries).requestsWithoutTokens, 0);
});
