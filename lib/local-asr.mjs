import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { UserError, logError } from './common.mjs';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/transcribe-local.py', import.meta.url));
export const LOCAL_MODEL = 'sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16';
async function invoke(config, args, timeout) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  delete env.OPENAI_API_KEY;
  const result = await exec(config.localPython, ['-X', 'utf8', script, '--model-dir', config.localModelDir,
    '--diarization-dir', config.diarizationModelDir || resolve(config.localModelDir, '../diarization'),
    '--threads', String(config.localThreads), ...args], { windowsHide: true, timeout, maxBuffer: 4 * 1024 ** 2, encoding: 'utf8', env });
  return JSON.parse(result.stdout);
}
export async function localStatus(config) {
  try { const result = await invoke(config, ['--check'], 30_000); return { available: result.available === true, model: LOCAL_MODEL }; }
  catch { return { available: false, model: LOCAL_MODEL }; }
}
export function validateSegments(segments, duration, withText = true) {
  if (!Array.isArray(segments)) throw new Error('Missing transcript segments');
  let previous = -1;
  for (const s of segments) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < previous || s.start < 0 || s.end <= s.start || s.end > duration + 0.01 || !Number.isInteger(s.speaker) || s.speaker < 1 || (withText && typeof s.text !== 'string')) throw new Error('Invalid transcript segment');
    previous = s.start;
  }
  return segments;
}
export async function transcribeLocalDetailed(files, config, outputDir) {
  const start = Date.now();
  let result;
  try {
    result = await invoke(config, [...(outputDir ? ['--output-dir', outputDir] : []), ...files], 30 * 60_000);
    if (typeof result.text !== 'string' || !Number.isFinite(result.audioSeconds)) throw new Error('Invalid local response');
    validateSegments(result.segments, result.audioSeconds, !outputDir);
    if (outputDir && result.segments.some(s => !/^turn-\d{5}\.wav$/.test(s.file))) throw new Error('Invalid speaker audio path');
  } catch (error) {
    logError('local-transcription', error);
    throw new UserError('Не удалось выполнить локальную расшифровку. Проверьте установку модели, свободную память и настройки LOCAL_PYTHON в README. Облачное распознавание автоматически не запускается.', 503);
  }
  if (config.onUsage) {
    try {
      await config.onUsage({ time: new Date().toISOString(), meetingId: config.meetingId, requestId: randomUUID(),
        operation: outputDir ? 'diarization' : 'transcription', provider: 'local', model: outputDir ? 'pyannote-3.0 + wespeaker-resnet34' : `${LOCAL_MODEL} + pyannote-3.0 + wespeaker-resnet34`, status: 'received', httpStatus: null,
        inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null,
        audioSeconds: result.audioSeconds, audioSecondsSource: 'local', elapsedSeconds: (Date.now() - start) / 1000,
        estimatedCostUsd: 0, currency: 'USD', costBasis: 'local_no_api_charge', pricingCheckedAt: null, rates: null });
    } catch (error) { logError('usage-local-write', error); }
  }
  return result;
}
export async function transcribeLocal(files, config) { return (await transcribeLocalDetailed(files, config)).text.trim(); }
