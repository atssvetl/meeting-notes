const $ = id => document.getElementById(id);
const labels = { processing: 'Обрабатывается', ready: 'Готово', error: 'Ошибка', uploaded: 'Файл загружен', transcribed: 'Транскрибация готова', deleting: 'Удаление', duplicate: 'Результат уже есть' };
const processingLabels = { upload: 'Получение файла', transcription: 'Распознавание речи', summary: 'AI-анализ' };
const statusLabel = item => item.status === 'processing' ? processingLabels[item.activeStage] || labels.processing : labels[item.status];
let uploading = false, busy = true, connected = false, storageFailed = false;
let signature = '';
let localAvailable = false, modeInitialized = false;
let actionPending = false;
const mode = () => document.querySelector('input[name="transcription-mode"]:checked').value;
function modeInfo() {
  const isLocal = mode() === 'local';
  $('privacy').textContent = isLocal
    ? 'Локально: аудио не отправляется в OpenAI. При запуске конспекта туда передаётся только расшифровка. Исходное видео хранится до удаления; временное аудио удаляется после транскрибации.'
    : 'Онлайн: аудио и расшифровка отправляются в OpenAI при запуске соответствующих этапов. Исходное видео хранится на этом компьютере до удаления; временное аудио удаляется после транскрибации.';
  $('mode-status').textContent = isLocal ? 'GigaAM v3 · CPU · без платы за API распознавания' : 'OpenAI · платное распознавание';
  $('local-note').hidden = !isLocal || localAvailable;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function timecode(seconds) {
  const ms = Math.round(seconds * 1000);
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
}
function controls() {
  const disabled = uploading || busy || actionPending || !connected || storageFailed;
  $('mode-control').disabled = disabled;
  $('automation-control').disabled = disabled;
  $('choose').disabled = disabled; $('file').disabled = disabled;
  $('cloud-url').disabled = disabled; $('cloud-add').disabled = disabled;
  for (const control of document.querySelectorAll('[data-action-control]')) control.disabled = disabled || control.dataset.locked === 'true';
  $('dropzone').classList.toggle('disabled', disabled);
  $('activity').hidden = !(busy || uploading) || !connected;
  $('choose').textContent = uploading ? 'Файл загружается…' : busy && connected ? 'Дождитесь завершения' : 'Выбрать запись ↗';
}
async function meetingAction(item, action, method = 'POST', body) {
  if (actionPending || busy || uploading) return;
  actionPending = true; controls(); showError('');
  try {
    const response = await fetch(`/api/meetings/${item.id}${action ? '/' + action : ''}`, {
      method, headers: { 'X-Meeting-Upload': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие.');
    signature = '';
  } catch (error) { showError(error instanceof TypeError ? 'Нет связи с сервером. Обновите состояние перед повторной попыткой.' : error.message); }
  finally { actionPending = false; await refresh(); }
}
function actionButton(text, callback, locked = false, className = '') {
  const button = element('button', text, className); button.type = 'button';
  button.dataset.actionControl = '1'; button.dataset.locked = String(locked);
  button.addEventListener('click', callback); return button;
}
function stagesPanel(item) {
  const wrapper = element('div', undefined, 'stages');
  const stageLabels = { pending: 'Ожидает запуска', running: 'Выполняется', done: 'Готово', error: 'Ошибка' };
  const s = item.stages;
  for (const [key, title, action] of [['upload', '1. Загрузка файла', null], ['transcription', '2. Транскрибация', 'transcribe'], ['summary', '3. Конспект', 'summarize']]) {
    const row = element('div', undefined, `stage-row stage-${key}`);
    const info = element('div'); info.append(element('strong', title), element('p', key === 'upload' && s[key] === 'done' ? (item.sourceAvailable ? 'Файл загружен' : 'Исходный файл удалён или недоступен') : stageLabels[s[key]])); row.append(info);
    if (key !== 'upload') {
      const prop = key === 'transcription' ? 'autoTranscribe' : 'autoSummary';
      const label = element('label', undefined, 'auto-label');
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = item[prop];
      checkbox.dataset.actionControl = '1'; checkbox.dataset.locked = String(s[key] === 'done' || item.sourceType === 'cloud');
      checkbox.setAttribute('aria-label', `Автозапуск: ${title.slice(3)}`);
      checkbox.addEventListener('change', () => meetingAction(item, 'settings', 'POST', { transcriptionMode: item.transcriptionMode || 'online', autoTranscribe: item.autoTranscribe, autoSummary: item.autoSummary, [prop]: checkbox.checked }));
      label.append(checkbox, document.createTextNode('Авто')); row.append(label);
      const unavailable = key === 'transcription' ? !item.sourceAvailable || (item.transcriptionMode === 'local' && !localAvailable) : !item.transcript;
      row.append(actionButton(s[key] === 'error' ? 'Повторить' : 'Запустить', () => meetingAction(item, action), s[key] === 'done' || unavailable));
    }
    wrapper.append(row);
  }
  if (s.transcription !== 'done' && item.sourceAvailable) {
    const label = element('label', 'Способ транскрибации: ', 'record-mode'); const select = element('select');
    for (const [value, text] of [['local', 'Локально · GigaAM v3'], ['online', 'Онлайн · OpenAI']]) { const option = element('option', text); option.value = value; select.append(option); }
    select.value = item.transcriptionMode || 'online'; select.dataset.actionControl = '1'; select.setAttribute('aria-label', 'Способ транскрибации');
    select.addEventListener('change', () => meetingAction(item, 'settings', 'POST', { transcriptionMode: select.value, autoTranscribe: item.autoTranscribe, autoSummary: item.autoSummary }));
    label.append(select); wrapper.append(label);
  }
  const actions = element('div', undefined, 'record-actions');
  if (item.sourceType === 'cloud' && s.upload === 'error') actions.append(actionButton('Повторить получение', () => meetingAction(item, 'retry-import')));
  if (item.sourceAvailable) actions.append(actionButton('Удалить файл', () => {
    if (confirm('Удалить исходное видео с сервера? Расшифровка и конспект сохранятся.')) meetingAction(item, 'source', 'DELETE');
  }, false, 'secondary'));
  actions.append(actionButton('Удалить встречу', () => {
    if (confirm('Удалить встречу, исходное видео, расшифровку и конспект? История расходов останется.')) meetingAction(item, '', 'DELETE');
  }, false, 'danger'));
  wrapper.append(actions); return wrapper;
}
function showError(text) { $('message').textContent = text; $('message').hidden = !text; }
function openMeeting(id) {
  const card = [...document.querySelectorAll('.meeting')].find(node => node.dataset.key === id);
  if (!card) return;
  card.open = true; card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.querySelector(':scope > summary').focus();
}
function resultLink(id, text = 'Открыть существующую запись') {
  const link = element('a', text, 'download-text'); link.href = `#meeting-${id}`;
  link.addEventListener('click', event => { event.preventDefault(); openMeeting(id); }); return link;
}
function listSection(title, values) {
  const section = element('section', undefined, 'summary-section'); section.append(element('h4', title));
  if (!values.length) section.append(element('p', 'Не зафиксированы', 'muted'));
  else { const ul = element('ul'); for (const value of values) ul.append(element('li', value)); section.append(ul); }
  return section;
}
function render(meetings) {
  const next = JSON.stringify({ meetings, busy });
  if (next === signature) return;
  signature = next;
  const opened = new Set([...document.querySelectorAll('details[open]')].map(x => x.dataset.key));
  const fragment = document.createDocumentFragment();
  for (const item of meetings) {
    const card = element('details', undefined, 'meeting'); card.dataset.key = item.id; card.id = `meeting-${item.id}`; card.open = opened.has(item.id);
    const heading = element('summary');
    const icon = element('span', '▤', 'file-icon'); icon.setAttribute('aria-hidden', 'true');
    const info = element('div', undefined, 'meeting-info'); info.append(element('h3', item.filename), element('time', new Date(item.createdAt).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' })));
    info.append(element('span', item.sourceType === 'cloud' ? 'Из облака' : 'Загружено вручную', 'source-label'));
    if (item.summary?.overview) info.append(element('p', item.summary.overview, 'summary-preview'));
    const badge = element('span', statusLabel(item), `badge ${item.status}`);
    heading.append(icon, info, badge, element('span', '⌄', 'chevron')); card.append(heading);
    const body = element('div', undefined, 'meeting-body');
    if (item.duplicateOf) {
      body.append(element('p', 'Этот файл уже проанализирован. Повторный AI-анализ не запускался.'), resultLink(item.duplicateOf, 'Открыть готовый результат'));
      const actions = element('div', undefined, 'record-actions');
      actions.append(actionButton('Удалить ссылку', () => meetingAction(item, '', 'DELETE'), false, 'secondary'));
      body.append(actions);
    } else if (item.stages) body.append(stagesPanel(item));
    body.append(element('p', `Распознавание: ${item.transcriptionMode === 'local' ? 'локально · GigaAM v3' : 'онлайн · OpenAI'}`, 'muted'));
    if (item.status === 'processing') body.append(element('p', `${statusLabel(item)}. Можно обновить или закрыть страницу: задача продолжится на сервере.`, 'muted'));
    if (item.status === 'error') body.append(element('p', item.error, 'error-box'));
    if (item.summary) {
      const s = item.summary;
      const overview = element('section', undefined, 'overview'); overview.append(element('h4', 'Краткое содержание'), element('p', s.overview));
      body.append(overview, listSection('Решения', s.decisions));
      const tasks = element('section', undefined, 'summary-section'); tasks.append(element('h4', 'Задачи'));
      if (!s.tasks.length) tasks.append(element('p', 'Не зафиксированы', 'muted'));
      for (const task of s.tasks) {
        const row = element('div', undefined, 'task'); row.append(element('p', task.action), element('small', `Исполнитель: ${task.owner ?? 'не указан'} · Срок: ${task.deadline ?? 'не указан'}`)); tasks.append(row);
      }
      body.append(tasks, listSection('Открытые вопросы', s.questions));
    }
    if (item.transcript) {
      const download = element('a', 'Скачать текст встречи (.txt)', 'download-text');
      download.href = `/api/meetings/${item.id}/text`; download.download = `${item.id}.txt`;
      body.append(download);
      const transcript = element('details', undefined, 'transcript'); transcript.dataset.key = `${item.id}-text`; transcript.open = opened.has(transcript.dataset.key);
      transcript.append(element('summary', 'Полная расшифровка'));
      if (item.transcriptSegments?.length) {
        transcript.append(element('div', 'Таймкоды от начала записи. Спикеры определены автоматически по голосу; возможны ошибки.', 'muted transcript-note'));
        if (item.diarization?.localReprocessing && item.summary) transcript.append(element('div', 'Разметка обновлена локально. Конспект сохранён от предыдущей расшифровки.', 'muted transcript-note'));
        for (const segment of item.transcriptSegments) {
          const turn = element('div', undefined, 'transcript-turn');
          const meta = element('div', undefined, 'transcript-meta');
          meta.append(element('span', `${timecode(segment.start)} – ${timecode(segment.end)}`, 'timecode'), element('strong', `Спикер ${segment.speaker}`));
          turn.append(meta, element('p', segment.text)); transcript.append(turn);
        }
      } else {
        transcript.append(element('p', item.transcript));
        transcript.append(element('div', item.sourceAvailable ? 'Для старой расшифровки можно создать разметку повторным локальным распознаванием. Прежний текст сохранится в JSON; конспект останется без изменений.' : 'Для добавления таймкодов и спикеров загрузите исходную запись заново.', 'muted transcript-note'));
        if (item.sourceAvailable) transcript.append(actionButton('Добавить таймкоды и спикеров', () => meetingAction(item, 'annotate'), !localAvailable));
      }
      body.append(transcript);
    }
    card.append(body); fragment.append(card);
  }
  $('meetings').replaceChildren(fragment); $('empty').hidden = meetings.length > 0;
}
async function refreshUsage() {
  if (!$('usage-panel').open) return;
  try {
    const response = await fetch('/api/usage', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    const data = await response.json(), t = data.totals;
    $('usage-total').textContent = `Запросов API: ${t.requests}. Учтённых токенов: ${t.knownTokens}. Расчётная стоимость: $${t.estimatedCostUsd.toFixed(6)} USD. Без данных о токенах: ${t.requestsWithoutTokens}; с неизвестной стоимостью: ${t.requestsWithoutCost}.${data.invalidLines ? ' Есть повреждённые строки: итог неполный.' : ''}`;
    const table = element('table'); const head = element('tr');
    for (const title of ['Время / встреча', 'Этап / модель', 'Токены: вход / кеш / выход / всего', 'Расчёт, USD']) head.append(element('th', title));
    table.append(head);
    for (const e of data.entries.slice(-100).reverse()) {
      const row = element('tr');
      row.append(element('td', `${new Date(e.time).toLocaleString('ru-RU')}\n${e.meetingId}`), element('td', `${e.operation === 'summary' ? 'Конспект' : e.operation === 'diarization' ? 'Разделение голосов' : 'Транскрибация'}${e.provider === 'local' ? ' · локально' : ''}\n${e.model}`), element('td', e.provider === 'local' ? 'Не используются' : [e.inputTokens, e.cachedInputTokens, e.outputTokens, e.totalTokens].map(n => n ?? '?').join(' / ')), element('td', e.estimatedCostUsd === null ? 'Неизвестно' : '$' + e.estimatedCostUsd.toFixed(6)));
      table.append(row);
    }
    $('usage-entries').replaceChildren(data.entries.length ? table : element('p', 'Журнал пока пуст. Здесь появятся расходы новых запросов.'));
  } catch { $('usage-total').textContent = 'Не удалось прочитать журнал расходов. Проверьте связь с сервером.'; }
}
async function refresh() {
  try {
    const response = await fetch('/api/meetings', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    const data = await response.json(); busy = data.busy; connected = true; storageFailed = data.storageFailed;
    const active = data.meetings.find(item => item.status === 'processing');
    $('activity').querySelector('strong').textContent = active ? statusLabel(active) : 'Обрабатывается';
    localAvailable = Boolean(data.local?.available);
    if (!modeInitialized) {
      let selected;
      try { selected = localStorage.getItem('transcription-mode'); } catch {}
      if (!['local', 'online'].includes(selected)) selected = localAvailable ? 'local' : 'online';
      document.querySelector(`input[name="transcription-mode"][value="${selected}"]`).checked = true;
      modeInitialized = true;
      for (const id of ['auto-transcribe', 'auto-summary']) {
        try { const value = localStorage.getItem(id); if (value !== null) $(id).checked = value === 'true'; } catch {}
      }
    }
    modeInfo();
    $('config-note').hidden = data.configured;
    $('connection').hidden = !storageFailed;
    $('connection').textContent = storageFailed ? 'Не удалось сохранить данные. Проверьте свободное место и перезапустите сервер.' : '';
    render(data.meetings);
    await refreshUsage();
  } catch {
    connected = false; $('connection').hidden = false;
    $('connection').textContent = 'Нет связи с локальным сервером. Проверьте, что приложение запущено. Соединение восстановится автоматически.';
  } finally { controls(); }
}
async function upload(file) {
  if (!file || uploading || busy || actionPending || !connected || storageFailed) return;
  showError('');
  if (!/\.(mp4|webm)$/i.test(file.name)) return showError('Формат файла не поддерживается. Загрузите WebM или MP4.');
  if (!file.size) return showError('Файл пустой. Выберите другую запись.');
  if (file.size > 1024 ** 3) return showError('Файл больше 1 ГБ. Выберите более короткую запись.');
  uploading = true; controls();
  try {
    const response = await fetch('/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Meeting-Upload': '1', 'X-Transcription-Mode': mode(), 'X-Auto-Transcribe': String($('auto-transcribe').checked), 'X-Auto-Summary': String($('auto-summary').checked) }, body: file });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить запись. Попробуйте ещё раз.');
  } catch (error) { showError(error instanceof TypeError ? 'Соединение прервалось. Дождитесь обновления списка перед повторной загрузкой.' : error.message); }
  finally { uploading = false; $('file').value = ''; await refresh(); }
}
$('choose').addEventListener('click', () => $('file').click());
$('cloud-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (actionPending || busy || uploading || !connected || storageFailed) return;
  actionPending = true; controls(); showError('');
  const result = $('cloud-result'); result.hidden = false; result.textContent = 'Проверяем ссылку…';
  try {
    const response = await fetch('/api/meetings/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Meeting-Upload': '1' }, body: JSON.stringify({url:$('cloud-url').value, transcriptionMode:mode()}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось добавить запись.');
    await refresh();
    result.replaceChildren(document.createTextNode(data.duplicate ? 'Эта ссылка уже добавлена. Повторная обработка не запущена. ' : 'Получение файла запущено на сервере. '), resultLink(data.id, data.status === 'ready' ? 'Открыть готовый результат' : 'Открыть запись'));
    if (!data.duplicate) openMeeting(data.id);
  } catch(error) { result.textContent = error instanceof TypeError ? 'Нет связи с сервером. Проверьте список встреч перед повторной попыткой.' : error.message; }
  finally { actionPending = false; controls(); }
});
$('usage-panel').addEventListener('toggle', refreshUsage);
for (const id of ['auto-transcribe', 'auto-summary']) $(id).addEventListener('change', () => { try { localStorage.setItem(id, String($(id).checked)); } catch {} });
for (const radio of document.querySelectorAll('input[name="transcription-mode"]')) radio.addEventListener('change', () => {
  try { localStorage.setItem('transcription-mode', mode()); } catch {}
  modeInfo(); controls();
});
$('file').addEventListener('change', () => { const file = $('file').files[0]; $('file').value = ''; upload(file); });
for (const event of ['dragenter', 'dragover']) $('dropzone').addEventListener(event, e => { e.preventDefault(); if (!$('choose').disabled) $('dropzone').classList.add('dragover'); });
for (const event of ['dragleave', 'drop']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.remove('dragover'); });
$('dropzone').addEventListener('drop', e => { if (e.dataTransfer.files.length !== 1) return showError('Выберите одну запись за раз.'); upload(e.dataTransfer.files[0]); });
async function poll() { await refresh(); setTimeout(poll, 2000); }
poll();
