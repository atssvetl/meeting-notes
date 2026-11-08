import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '../server.mjs';
import { writeTextExport } from '../lib/text-export.mjs';
const directory = join(configuration().dataDir, 'meetings');
let count = 0, errors = 0;
// Read JSON only; do not initialize Store or interrupt any active processing.
for (const name of await readdir(directory)) {
  if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
  try {
    const item = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (`${item.id}.json` !== name) throw new Error('Invalid identifier');
    if (await writeTextExport(directory, item)) count++;
  } catch { errors++; }
}
console.log(`Создано TXT-файлов: ${count}. Ошибок: ${errors}. Каталог: ${directory}`);
if (errors) process.exitCode = 1;
