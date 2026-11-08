import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageEntry, totals, recordUsage, readUsage } from '../lib/usage.mjs';
import { summarize } from '../lib/ai.mjs';

const metadata = { meetingId: 'test-meeting', requestId: 'test-request', operation: 'summary', model: 'gpt-4.1-mini', status: 'received', httpStatus: 200 };
test('Стоимость токенов учитывает кеш без двойного подсчёта', () => {
  const entry = usageEntry({ ...metadata, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 200, total_tokens: 1200 } });
  assert.equal(entry.estimatedCostUsd, 0.0006);
  assert.equal(entry.totalTokens, 1200);
  assert.equal(entry.cachedInputTokens, 400);
  assert.equal(entry.costBasis, 'api_tokens');
});
test('Аудио оплачивается по секундам; неизвестные токены не превращаются в ноль', () => {
  const entry = usageEntry({ ...metadata, operation: 'transcription', model: 'gpt-transcribe', usage: { type: 'duration', seconds: 120 }, audioSeconds: 119.5 });
  assert.equal(entry.estimatedCostUsd, 0.009); assert.equal(entry.totalTokens, null);
  assert.equal(entry.costBasis, 'api_duration');
  const fallback = usageEntry({ ...metadata, operation: 'transcription', model: 'gpt-transcribe', audioSeconds: 60 });
  assert.equal(fallback.estimatedCostUsd, 0.0045); assert.equal(fallback.costBasis, 'local_audio_duration');
});
test('Отсутствие usage, неизвестная модель и неуспешный запрос сохраняют неизвестную стоимость', () => {
  for (const fields of [{}, { model: 'other-model', usage: { input_tokens: 10, output_tokens: 20 } }, { status: 'unknown', usage: { input_tokens: 10, output_tokens: 20 } }]) {
    assert.equal(usageEntry({ ...metadata, ...fields }).estimatedCostUsd, null);
  }
  const known = usageEntry({ ...metadata, usage: { input_tokens: 1000, output_tokens: 0 } });
  const unknown = usageEntry({ ...metadata, status: 'unknown' });
  assert.deepEqual(totals([known, unknown]), { requests: 2, knownTokens: 1000, requestsWithoutTokens: 1, estimatedCostUsd: 0.0004, requestsWithoutCost: 1 });
});
test('Журнал сохраняется, читается после перезапуска и сообщает о повреждённой строке', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
  try {
    assert.deepEqual(await readUsage(dir), { entries: [], invalidLines: 0 });
    const entry = usageEntry({ ...metadata, usage: { input_tokens: 1000, output_tokens: 100, secret: 'must-not-log' } });
    await recordUsage(dir, entry);
    assert.deepEqual((await readUsage(dir)).entries, [entry]);
    assert.equal((await readFile(join(dir, 'usage.jsonl'), 'utf8')).includes('must-not-log'), false);
    await appendFile(join(dir, 'usage.jsonl'), '{unfinished');
    const log = await readUsage(dir); assert.equal(log.invalidLines, 1); assert.equal(log.entries.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Расход записывается до проверки результата, ошибки сети не считаются бесплатными', async t => {
  const entries = [];
  const config = { key: 'test-only', summaryModel: 'gpt-4.1-mini', meetingId: 'test', onUsage: async e => { entries.push(e); } };
  // Only accounting metadata, no mock transcripts or generated meeting summaries.
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: 'incomplete', usage: { input_tokens: 1000, output_tokens: 100 } }), { status: 200 }));
  await assert.rejects(summarize('Проверка учёта', config), /не завершил/);
  assert.equal(entries[0].totalTokens, 1100); assert.equal(entries[0].estimatedCostUsd, 0.00056);
  mock.mock.mockImplementation(async () => { throw new Error('network'); });
  await assert.rejects(summarize('Проверка учёта', config), /не ответил/);
  assert.equal(entries[1].status, 'unknown'); assert.equal(entries[1].estimatedCostUsd, null);
  mock.mock.mockImplementation(async () => new Response('{}', { status: 429 }));
  await assert.rejects(summarize('Проверка учёта', config), /лимит/);
  assert.equal(entries[2].status, 'http_error'); assert.equal(entries[2].httpStatus, 429);
  await assert.rejects(summarize('Проверка учёта', { ...config, key: '' }), /Не настроен/);
  assert.equal(entries.length, 3);
});
