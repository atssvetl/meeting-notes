import { mkdir, open, rename, readFile, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logError } from './common.mjs';
import { writeTextExport } from './text-export.mjs';

export class Store {
  constructor(root) { this.root = root; this.records = join(root, 'meetings'); this.temp = join(root, 'temp'); this.sources = join(root, 'sources'); this.items = new Map(); }
  sourceDirectory(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid identifier');
    return join(this.sources, id);
  }
  sourcePath(item) {
    if (!['.mp4', '.webm'].includes(item.extension)) throw new Error('Invalid source extension');
    return join(this.sourceDirectory(item.id), `source${item.extension}`);
  }
  async init() {
    await mkdir(this.records, { recursive: true });
    await mkdir(this.temp, { recursive: true });
    await mkdir(this.sources, { recursive: true });
    for (const name of await readdir(this.records)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const item = JSON.parse(await readFile(join(this.records, name), 'utf8'));
        if (`${item.id}.json` !== name) throw new Error('Invalid record');
        if (item.status === 'deleting') { await this.remove(item); continue; }
        const previous = JSON.stringify(item);
        item.stages ??= { upload: 'done', transcription: item.transcript ? 'done' : 'pending', summary: item.summary ? 'done' : 'pending' };
        item.autoTranscribe ??= true;
        item.autoSummary ??= true;
        item.sourceAvailable ??= false;
        item.sourceType ??= 'manual';
        if (item.sourceAvailable) {
          try { await access(this.sourcePath(item)); } catch { item.sourceAvailable = false; }
        }
        if (item.sourceDeleting) {
          await rm(this.sourceDirectory(item.id), { recursive: true, force: true });
          item.sourceAvailable = false; delete item.sourceDeleting;
        }
        if (item.status === 'processing') {
          const stage = item.activeStage || (item.transcript ? 'summary' : 'transcription');
          item.stages[stage] = 'error'; item.activeStage = null; item.status = 'error';
          item.error = 'Обработка была прервана перезапуском сервера. Запустите этап снова; если исходный файл отсутствует, загрузите его заново.';
        }
        if (item.stages.upload !== 'done') {
          await rm(this.sourceDirectory(item.id), { recursive: true, force: true }); item.sourceAvailable = false;
        }
        this.items.set(item.id, item);
        if (previous !== JSON.stringify(item)) await this.save(item);
        else await this.exportText(item);
      } catch (error) { logError(`read-record:${name}`, error); }
    }
    for (const item of [...this.items.values()]) if (item.duplicateOf && !this.items.has(item.duplicateOf)) await this.remove(item);
    // Only generated files under our dedicated temp directory are removed.
    for (const name of await readdir(this.temp)) {
      if (/^[a-f0-9-]{36}$/.test(name)) await rm(join(this.temp, name), { recursive: true, force: true });
    }
  }
  async deleteSource(item) {
    await this.save({ ...item, sourceDeleting: true });
    await rm(this.sourceDirectory(item.id), { recursive: true, force: true });
    item.sourceAvailable = false;
    delete item.sourceDeleting;
    await this.save(item);
  }
  async remove(item) {
    // A durable deletion marker lets startup finish cleanup after a crash.
    await this.save({ ...item, status: 'deleting' });
    await rm(this.sourceDirectory(item.id), { recursive: true, force: true });
    await rm(join(this.temp, item.id), { recursive: true, force: true });
    await rm(join(this.records, `${item.id}.txt`), { force: true });
    await rm(join(this.records, `${item.id}.json`), { force: true });
    this.items.delete(item.id);
    // A URL alias must not block importing again after its target was deleted.
    for (const alias of [...this.items.values()]) if (alias.duplicateOf === item.id) await this.remove(alias);
  }
  async save(item) {
    const target = join(this.records, `${item.id}.json`);
    const staging = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(staging, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(item, null, 2), 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await rename(staging, target);
      this.items.set(item.id, structuredClone(item));
    } finally { await handle?.close(); await rm(staging, { force: true }); }
    await this.exportText(item);
  }
  async exportText(item) {
    try { await writeTextExport(this.records, item); }
    catch (error) { logError('text-export', error); }
  }
  list() { return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
}
