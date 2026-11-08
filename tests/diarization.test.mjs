import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '../server.mjs';
import { localStatus, transcribeLocalDetailed, validateSegments } from '../lib/local-asr.mjs';
import { runMedia } from '../lib/media.mjs';
import { timecode, meetingText } from '../lib/text-export.mjs';

test('Разметка: границы времени, формат часа и безопасный TXT с несколькими спикерами', () => {
  const segments = [{ start: 59.999, end: 60.12, speaker: 1, text: 'Первая реплика.' }, { start: 3600, end: 3601, speaker: 2, text: 'Вторая реплика.' }];
  validateSegments(segments, 3601);
  assert.equal(timecode(59.999), '00:00:59.999');
  assert.equal(timecode(3600), '01:00:00.000');
  const text = meetingText({ filename: 'format.mp4', transcript: 'Первая реплика. Вторая реплика.', transcriptSegments: segments });
  assert.match(text, /\[00:00:59.999 – 00:01:00.120\] Спикер 1\r\nПервая реплика\./);
  assert.match(text, /\[01:00:00.000 – 01:00:01.000\] Спикер 2\r\nВторая реплика\./);
  for (const invalid of [{ start: -1 }, { end: 4000 }, { speaker: 0 }, { text: null }]) assert.throws(() => validateSegments([{ ...segments[0], ...invalid }], 3601));
  assert.throws(() => validateSegments([...segments].reverse(), 3601));
});

test('Настоящая диаризация: тишина и границы WAV не сдвигают таймкоды и не меняют спикера', async t => {
  const config = { ...configuration(), key: '' };
  if (!(await localStatus(config)).available) return t.skip('Нужны локальные модели');
  const directory = await mkdtemp(join(tmpdir(), 'meeting-diarization-'));
  try {
    const silence = join(directory, 'silence.wav');
    await runMedia(config.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', silence]);
    const speech = join(config.localModelDir, 'test_wavs/example.wav');
    const result = await transcribeLocalDetailed([silence, speech, silence, speech], config);
    assert.match(result.text.toLowerCase(), /лукоморья/);
    assert(Math.abs(result.audioSeconds - 28.58) < .001);
    assert(result.segments[0].start >= 2.9);
    assert(result.segments.some(s => s.start >= 17.2));
    assert.equal(new Set(result.segments.map(s => s.speaker)).size, 1);
    assert.equal(result.text, result.segments.map(s => s.text).join(' '));
    // Online preparation uses the same actual voice detector, no remote API call.
    const turnsDirectory = join(directory, 'turns');
    const online = await transcribeLocalDetailed([speech], config, turnsDirectory);
    assert(online.segments.length > 0);
    for (const segment of online.segments) {
      const wav = await readFile(join(turnsDirectory, segment.file));
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert(Math.abs((wav.length - 44) / 32000 - (segment.end - segment.start)) < .002);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
