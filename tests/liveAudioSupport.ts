import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, probeAudio, runFfmpeg } from './fixtures.ts';
import { json, omni, request } from './liveSupport.ts';

export const verifyAudio = async (path: string) => {
  const { streams } = await probeAudio(path);
  assert.equal(streams.length, 1, 'Generated media must decode to an audio stream');
  assert.equal(Number(streams[0].sample_rate), 24_000);
  assert.equal(streams[0].channels, 1);
  const decoded = `${path}.f32`;
  await runFfmpeg(['-i', path, '-f', 'f32le', '-ac', '1', '-ar', '24000', decoded]);
  const pcm = await readFile(decoded);
  assert.ok(pcm.length > 24_000 * 4 * 0.2, 'Expected more than 200 ms of audio');
  let energy = 0;
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const sample = pcm.readFloatLE(offset);
    assert.ok(Number.isFinite(sample), 'Decoded samples must be finite');
    energy += sample * sample;
  }
  assert.ok(energy / (pcm.length / 4) > 0.000001, 'Generated audio must not be silent');
  return { sampleRate: 24_000, seconds: pcm.length / 4 / 24_000, energy };
};

export const synthesize = async (
  name: string,
  input: string,
  extra: Record<string, unknown> = {},
  path = '/v1/audio/speech',
) => {
  const response = await request(path, {
    model: omni,
    input,
    voice: 'female',
    response_format: 'wav',
    seed: 42,
    ...extra,
  });
  assert.match(response.headers.get('content-type') || '', /audio\/wav/);
  const output = join(artifacts, `${name}.wav`);
  const audio = Buffer.from(await response.arrayBuffer());
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  await writeFile(output, audio);
  return { path: output, audio, decoded: await verifyAudio(output) };
};

export const transcribe = async (path: string, language = 'en') => {
  const form = new FormData();
  form.set('model', omni);
  form.set('language', language);
  form.set('response_format', 'json');
  form.set('file', new Blob([await readFile(path)], { type: 'audio/wav' }), 'recording.wav');
  const result = await json('/v1/audio/transcriptions', form);
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text!.length > 0, 'Transcription must contain recognized text');
  return result.text!;
};
