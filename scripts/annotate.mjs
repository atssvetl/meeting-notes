import { configuration, createApplication } from '../server.mjs';

const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id || '')) {
  console.error('Использование: npm run annotate -- <идентификатор встречи>. Сначала остановите сервер (Ctrl+C).');
  process.exitCode = 1;
} else {
  let app;
  try {
    // This command always uses local recognition and never regenerates the summary.
    app = await createApplication({ ...configuration(), key: '' });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(`${base}/api/meetings/${id}/annotate`, { method: 'POST', headers: { 'X-Meeting-Upload': '1' } });
    if (!response.ok) throw new Error((await response.json()).error);
    console.log('Локальная обработка: определение голосов и распознавание реплик…');
    // close waits for the accepted background job and releases the directory lock.
    await app.close();
    const item = app.store.items.get(id);
    if (!item.transcriptSegments?.length || item.error) throw new Error(item.error || 'Разметка не создана.');
    console.log(`Готово: ${item.transcriptSegments.length} реплик; спикеров: ${new Set(item.transcriptSegments.map(s => s.speaker)).size}.`);
    console.log(`JSON и TXT обновлены в ${app.store.records}. Прежний текст сохранён в поле transcriptBeforeDiarization.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await app?.close(); }
}
