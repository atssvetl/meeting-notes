import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_SECONDS, UserError, logError } from './common.mjs';
const exec = promisify(execFile);
export async function runMedia(executable, args) {
  try { return await exec(executable, args, { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 ** 2 }); }
  catch (error) {
    logError('media-command', error);
    if (error.code === 'ENOENT') throw new UserError('Не найден FFmpeg или FFprobe. Установите их по инструкции в README.', 503);
    throw new UserError('Не удалось прочитать запись. Файл повреждён или его кодек не поддерживается.');
  }
}
export async function inspectMedia(video, config) {
  const probe = await runMedia(config.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', video]);
  const info = JSON.parse(probe.stdout);
  const formats = (info.format?.format_name || '').split(',');
  if (!formats.some(x => ['mov', 'mp4', 'webm', 'matroska'].includes(x))) throw new UserError('Формат файла не поддерживается. Загрузите WebM или MP4.');
  if (!info.streams?.some(x => x.codec_type === 'audio')) throw new UserError('В записи нет аудиодорожки.');
  if (!info.streams.some(x => x.codec_type === 'video')) throw new UserError('В файле нет видеодорожки. Загрузите видео WebM или MP4.');
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new UserError('Не удалось определить длительность записи. Проверьте файл.');
  if (duration > MAX_SECONDS) throw new UserError('Запись длиннее 30 минут. Выберите более короткий фрагмент.');
  return { duration };
}
export async function extractAudio(video, directory, config) {
  await inspectMedia(video, config);
  // Local protocols only; never follow a playlist or an external media URL.
  const args = ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', video,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-f', 'segment', '-segment_time', '300', '-reset_timestamps', '1', join(directory, 'audio-%03d.wav')];
  await runMedia(config.ffmpeg, args);
  const chunks = (await readdir(directory)).filter(x => /^audio-\d+\.wav$/.test(x)).sort().map(x => join(directory, x));
  if (!chunks.length) throw new UserError('Не удалось извлечь аудиодорожку.');
  return chunks;
}
export async function hasSound(wav, config) {
  const { stderr } = await runMedia(config.ffmpeg, ['-nostdin', '-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-']);
  const match = stderr.match(/max_volume: ([-\d.]+) dB/);
  return !match || Number(match[1]) > -55;
}
