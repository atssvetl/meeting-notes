import { configuration } from '../server.mjs';
import { readUsage, formatTotals } from '../lib/usage.mjs';
const { entries, invalidLines } = await readUsage(configuration().dataDir);
if (!entries.length) console.log('Журнал расхода пока пуст. Учёт начинается с новых запросов к API.');
else {
  for (const id of new Set(entries.map(e => e.meetingId))) console.log(`Встреча ${id}: ${formatTotals(entries.filter(e => e.meetingId === id))}`);
  console.log(`\nИТОГО за всё время: ${formatTotals(entries)}`);
}
if (invalidLines) console.warn(`Не удалось прочитать строк: ${invalidLines}. Итог неполный.`);
console.log('Стоимость — оценка по pricing.json на момент запроса. Точное списание проверяйте в биллинге OpenAI.');
