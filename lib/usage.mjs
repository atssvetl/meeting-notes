import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import prices from '../pricing.json' with { type: 'json' };

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const rounded = value => Math.round(value * 1e10) / 1e10;
export function usageEntry({ meetingId, requestId, operation, model, usage, audioSeconds, status, httpStatus }) {
  const input = tokens(usage?.input_tokens), output = tokens(usage?.output_tokens);
  const cached = tokens(usage?.input_tokens_details?.cached_tokens);
  const seconds = number(usage?.seconds) ?? number(audioSeconds);
  const rate = prices.models[model];
  let estimatedCostUsd = null, costBasis = 'unknown';
  if (status === 'received' && rate) {
    if (number(rate.perMinute) !== null && seconds !== null) {
      estimatedCostUsd = seconds / 60 * rate.perMinute;
      costBasis = number(usage?.seconds) !== null ? 'api_duration' : 'local_audio_duration';
    } else if (input !== null && output !== null && number(rate.inputPerMillion) !== null && number(rate.outputPerMillion) !== null) {
      // Missing cache detail is priced at the normal rate; explicitly mark that estimate.
      const cachedCount = cached !== null && cached <= input ? cached : 0;
      const cachedRate = number(rate.cachedInputPerMillion) ?? rate.inputPerMillion;
      estimatedCostUsd = ((input - cachedCount) * rate.inputPerMillion + cachedCount * cachedRate + output * rate.outputPerMillion) / 1e6;
      costBasis = cached === null ? 'api_tokens_without_cache_detail' : 'api_tokens';
    }
  }
  return { time: new Date().toISOString(), meetingId, requestId, operation, model, status, httpStatus: httpStatus ?? null,
    inputTokens: input, cachedInputTokens: cached, outputTokens: output,
    totalTokens: tokens(usage?.total_tokens) ?? (input !== null && output !== null ? input + output : null),
    audioSeconds: operation === 'transcription' ? seconds : null,
    audioSecondsSource: operation === 'transcription' && seconds !== null ? (number(usage?.seconds) !== null ? 'api' : 'local') : null,
    estimatedCostUsd: estimatedCostUsd === null ? null : rounded(estimatedCostUsd), currency: 'USD', costBasis,
    pricingCheckedAt: prices.checkedAt, rates: rate ?? null };
}
export function totals(entries) {
  entries = entries.filter(e => e.provider !== 'local');
  return { requests: entries.length,
    knownTokens: entries.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0),
    requestsWithoutTokens: entries.filter(e => e.totalTokens === null).length,
    estimatedCostUsd: rounded(entries.reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0)),
    requestsWithoutCost: entries.filter(e => e.estimatedCostUsd === null).length };
}
export function formatTotals(entries) {
  const t = totals(entries);
  return `запросов API: ${t.requests}; локальных операций: ${entries.filter(e => e.provider === 'local').length}; учтённых токенов: ${t.knownTokens}; расчётная стоимость: $${t.estimatedCostUsd.toFixed(6)} USD; без данных о токенах: ${t.requestsWithoutTokens}; с неизвестной стоимостью: ${t.requestsWithoutCost}`;
}
export async function recordUsage(directory, entry) {
  await appendFile(join(directory, 'usage.jsonl'), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  const description = entry.provider === 'local'
    ? `${entry.operation === 'diarization' ? 'Локальное разделение голосов' : 'Локальная транскрибация'}; аудио: ${entry.audioSeconds} с; стоимость API: $0 USD`
    : `${entry.operation === 'transcription' ? 'Транскрибация' : 'Конспект'}; вход: ${entry.inputTokens ?? 'неизвестно'}; кеш: ${entry.cachedInputTokens ?? 'неизвестно'}; выход: ${entry.outputTokens ?? 'неизвестно'}; всего токенов: ${entry.totalTokens ?? 'неизвестно'}; расчёт: ${entry.estimatedCostUsd === null ? 'неизвестно' : '$' + entry.estimatedCostUsd.toFixed(6) + ' USD'}`;
  await appendFile(join(directory, 'usage.log'), `${entry.time} | встреча ${entry.meetingId} | ${entry.model} | ${description} | ${entry.status}\n`, { encoding: 'utf8', mode: 0o600 });

}
export async function readUsage(directory) {
  let text;
  try { text = await readFile(join(directory, 'usage.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { entries: [], invalidLines: 0 }; throw error; }
  const entries = []; let invalidLines = 0;
  for (const line of text.split('\n').filter(x => x.trim())) {
    try {
      const value = JSON.parse(line);
      if (!value.requestId || !value.meetingId || !('estimatedCostUsd' in value)) throw new Error('Invalid usage entry');
      entries.push(value);
    } catch { invalidLines++; }
  }
  return { entries, invalidLines };
}
