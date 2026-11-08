import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingText } from '../lib/text-export.mjs';

test('Читаемый экспорт сохраняет слова, оформляет разделы и явно отмечает неизвестные поля', () => {
  const transcript = 'Первая фраза. Вторая фраза! Третья фраза? '.repeat(40).trim();
  const item = { filename: 'пример.mp4', createdAt: '2026-11-08T12:00:00Z', transcript,
    summary: { overview: 'Проверка форматирования.', decisions: [], tasks: [{ action: 'Проверить формат.', owner: null, deadline: null }], questions: [] } };
  const before = JSON.stringify(item), output = meetingText(item);
  assert.equal(JSON.stringify(item), before);
  assert(output.replace(/\s+/g, ' ').includes(transcript));
  for (const title of ['Краткое содержание', 'Решения', 'Задачи', 'Открытые вопросы']) assert(output.includes(title));
  assert(output.includes('Исполнитель: не указан')); assert(output.includes('Срок: не указан'));
  assert(output.includes('Не зафиксированы'));
  assert(output.split('\r\n').every(line => line.length <= 100));
});
