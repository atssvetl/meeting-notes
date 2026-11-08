import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function wrap(text, width = 100) {
  const lines = []; let line = '';
  for (const word of String(text).trim().split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
function paragraphs(text) {
  const output = [];
  for (const paragraph of String(text).trim().split(/\n\s*\n/)) {
    let group = '';
    for (const { segment } of new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(paragraph)) {
      if (group && group.length + segment.length > 650) { output.push(wrap(group)); group = ''; }
      group += segment;
    }
    if (group.trim()) output.push(wrap(group));
  }
  return output.join('\n\n');
}
export function meetingText(item) {
  const date = new Date(item.createdAt);
  const added = Number.isNaN(date.getTime()) ? 'не указана' : date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'long', timeStyle: 'short' }) + ' (МСК)';
  const lines = ['ЗАПИСЬ ВСТРЕЧИ', '='.repeat(60), `Файл: ${String(item.filename).replace(/\s+/g, ' ')}`, `Добавлена: ${added}`,
    '', 'ПОЛНАЯ РАСШИФРОВКА', '-'.repeat(60),
    ...(item.transcriptSegments?.length ? [
      'Таймкоды от начала записи. Спикеры определены автоматически по голосу; возможны ошибки.',
      ...(item.diarization?.localReprocessing && item.summary ? ['Разметка обновлена локально. Конспект сохранён от предыдущей расшифровки.'] : []), '',
      item.transcriptSegments.map(s => `[${timecode(s.start)} – ${timecode(s.end)}] Спикер ${s.speaker}\n${paragraphs(s.text)}`).join('\n\n')
    ] : [paragraphs(item.transcript || 'Расшифровка ещё не создана.')]), '',
    'КОНСПЕКТ', '-'.repeat(60)];
  if (!item.summary) lines.push('Конспект ещё не создан.');
  else {
    const s = item.summary;
    const bullets = values => values.length ? values.map((value, i) => wrap(`${i + 1}. ${value}`)).join('\n\n') : 'Не зафиксированы';
    lines.push('Краткое содержание', paragraphs(s.overview), '', 'Решения', bullets(s.decisions), '', 'Задачи');
    if (!s.tasks.length) lines.push('Не зафиксированы');
    for (const [i, task] of s.tasks.entries()) lines.push(wrap(`${i + 1}. ${task.action}`), `   Исполнитель: ${task.owner ?? 'не указан'}`, `   Срок: ${task.deadline ?? 'не указан'}`, '');
    lines.push('', 'Открытые вопросы', bullets(s.questions));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd().replace(/\r?\n/g, '\r\n') + '\r\n';
}
export function timecode(seconds) {
  const ms = Math.round(seconds * 1000);
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
}
export async function writeTextExport(directory, item) {
  if (!/^[a-f0-9-]{36}$/.test(item.id)) throw new Error('Invalid identifier');
  if (!item.transcript?.trim() || item.status === 'deleting') return false;
  const target = join(directory, `${item.id}.txt`), staging = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(staging, 'wx', 0o600);
    await file.writeFile(meetingText(item), 'utf8'); await file.sync();
    await file.close(); file = null;
    await rename(staging, target);
    return true;
  } finally { await file?.close(); await rm(staging, { force: true }); }
}
