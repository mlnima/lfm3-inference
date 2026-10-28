import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { artifacts, fixtures, runFfmpeg } from './fixtures.ts';
import { synthesize, transcribe, verifyAudio } from './liveAudioSupport.ts';
import { evidence, omni, request, timeout } from './liveSupport.ts';

before(
  async () => {
    await fixtures();
  },
  { timeout },
);

test('multipart transcription recognizes the real JFK recording', { timeout }, async () => {
  const transcript = await transcribe((await fixtures()).audio);
  assert.match(transcript, /ask/i);
  assert.match(transcript, /country/i);
  assert.match(transcript, /you/i);
  await evidence('asr-recorded', { transcript });
});

test('OpenAI speech produces audible English that the model transcribes', { timeout }, async () => {
  const result = await synthesize('speech-female', 'The red square is on the white background.');
  const transcript = await transcribe(result.path);
  assert.match(transcript, /red/i);
  assert.match(transcript, /square/i);
  assert.match(transcript, /white/i);
  await evidence('speech-female', { decoded: result.decoded, transcript });
});

test(
  'native speech produces the male voice and a multilingual utterance',
  { timeout },
  async () => {
    const result = await synthesize(
      'speech-male-german',
      'Guten Morgen. Das ist ein rotes Quadrat.',
      { lang: 'de', voice: 'male' },
      '/tts',
    );
    const transcript = await transcribe(result.path, 'de');
    assert.match(transcript, /Guten|Morgen/i);
    assert.match(transcript, /rot|Quadrat/i);
    await evidence('speech-male-german', { decoded: result.decoded, transcript });
  },
);

test('native speech streams decodable WAV audio', { timeout }, async () => {
  const result = await synthesize(
    'speech-stream',
    'Hello. The answer is four.',
    { stream: true, lang: 'en' },
    '/tts',
  );
  const transcript = await transcribe(result.path);
  assert.match(transcript, /four|4/i);
  await evidence('speech-stream', { decoded: result.decoded, transcript });
});

test('native speech returns float32 PCM with a truthful content type', { timeout }, async () => {
  const response = await request('/tts', {
    model: omni,
    input: 'Hello. The answer is four.',
    voice: 'female',
    lang: 'en',
    seed: 42,
    response_format: 'pcm',
  });
  const contentType = response.headers.get('content-type') || '';
  assert.match(contentType, /audio\/pcm/);
  assert.match(contentType, /rate=24000/);
  assert.match(contentType, /encoding=float/);
  assert.match(contentType, /bits=32/);
  const output = join(artifacts, 'speech-native.pcm');
  const wave = join(artifacts, 'speech-native-pcm.wav');
  const pcm = Buffer.from(await response.arrayBuffer());
  assert.equal(pcm.length % 4, 0);
  assert.ok(pcm.length > 19_200);
  await writeFile(output, pcm);
  await runFfmpeg(['-f', 'f32le', '-ar', '24000', '-ac', '1', '-i', output, wave]);
  const decoded = await verifyAudio(wave);
  const transcript = await transcribe(wave);
  assert.match(transcript, /four|4/i);
  await evidence('speech-native-pcm', { decoded, transcript, contentType });
});

test(
  'OpenAI speech returns signed 16-bit PCM that preserves spoken content',
  { timeout },
  async () => {
    const response = await request('/v1/audio/speech', {
      model: omni,
      input: 'Hello. The answer is four.',
      voice: 'female',
      language: 'en',
      seed: 42,
      response_format: 'pcm',
    });
    const contentType = response.headers.get('content-type') || '';
    assert.match(contentType, /audio\/pcm/);
    assert.match(contentType, /rate=24000/);
    assert.match(contentType, /encoding=signed-integer/);
    assert.match(contentType, /bits=16/);
    const output = join(artifacts, 'speech-openai.pcm');
    const wave = join(artifacts, 'speech-openai-pcm.wav');
    const pcm = Buffer.from(await response.arrayBuffer());
    assert.equal(pcm.length % 2, 0);
    assert.ok(pcm.length > 9_600);
    await writeFile(output, pcm);
    await runFfmpeg(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', output, wave]);
    const decoded = await verifyAudio(wave);
    const transcript = await transcribe(wave);
    assert.match(transcript, /four|4/i);
    await evidence('speech-openai-pcm', { decoded, transcript, contentType });
  },
);
