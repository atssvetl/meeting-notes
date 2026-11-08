import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, createApplication } from '../server.mjs';
import { runMedia } from '../lib/media.mjs';

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-notes-test-'));
  const config = { ...configuration(), dataDir: join(directory, 'data'), key: '' };
  const app = await createApplication(config);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { ...app, config, directory, base: `http://127.0.0.1:${app.server.address().port}`,
    async cleanup() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function upload(base, filename, body, mode = 'online', automation = { autoTranscribe: true, autoSummary: true }) {
  return fetch(`${base}/api/meetings`, { method: 'POST', headers: { 'X-Meeting-Upload': '1', 'X-File-Name': encodeURIComponent(filename), 'Content-Type': 'application/octet-stream', 'X-Transcription-Mode': mode, 'X-Auto-Transcribe': String(automation.autoTranscribe), 'X-Auto-Summary': String(automation.autoSummary) }, body });
}
export async function state(base) { return (await fetch(`${base}/api/meetings`)).json(); }
export async function settle(base, id, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const data = await state(base);
    const item = data.meetings.find(x => x.id === id);
    if (item && item.status !== 'processing' && !data.busy) return item;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Обработка не завершилась за отведённое время');
}
// Generated media exercises actual codecs and failure paths, never fake speech/results.
export async function media(directory, config, kind = 'silence', extension = 'mp4') {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${kind}.${extension}`);
  const args = ['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1'];
  if (kind !== 'no-audio') args.push('-f', 'lavfi', '-i', kind === 'silence' ? 'anullsrc=r=16000:cl=mono' : 'sine=frequency=440:sample_rate=16000');
  args.push('-t', '1', '-c:v', extension === 'webm' ? 'libvpx' : 'libx264');
  if (kind !== 'no-audio') args.push('-c:a', extension === 'webm' ? 'libopus' : 'aac');
  args.push(path);
  await runMedia(config.ffmpeg, args);
  return { path, bytes: await readFile(path) };
}
