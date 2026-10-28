import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { verifyAudio } from './liveAudioSupport.ts';
import {
  decisionPort,
  directory,
  infer,
  launch,
  listening,
  proxyPort,
  runtimePids,
} from './lifecycleSupport.ts';

test('CPU mode loads the decision model on demand and returns a real decision', async (t) => {
  const { baseline, output } = await launch(t, {
    device: 'cpu',
    role: 'decision',
    args: ['--verbosity', '5'],
  });
  assert.equal(await listening(decisionPort), false);
  assert.deepEqual(await runtimePids(), baseline);
  const response = await infer('d1-omni-2b');
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    answers: { route: { choice: string } };
    usage: { output_tokens: number };
  };
  assert.equal(result.answers.route.choice, 'billing');
  assert.equal(result.usage.output_tokens, 0);
  const log = output();
  await writeFile(resolve(directory, 'cpu-runtime.log'), log);
  await writeFile(resolve(directory, 'cpu-response.json'), JSON.stringify(result, null, 2));
  assert.match(log, /CPU(?:_Mapped)? .*model buffer|model buffer.*CPU/i);
  assert.match(log, /offloaded 0\/[0-9]+ layers to GPU/i);
  assert.equal((log.match(/CLIP using CPU backend/g) || []).length, 2);
  assert.doesNotMatch(log, /offloaded [1-9][0-9]*\/[0-9]+ layers to GPU/i);
  assert.doesNotMatch(log, /CUDA[0-9]+ .*model buffer|model buffer.*CUDA[0-9]+/i);
});

test('CPU Omni speech uses CPU model and multimodal components', async (t) => {
  const { output, baseline } = await launch(t, {
    device: 'cpu',
    args: ['--verbosity', '5'],
  });
  assert.deepEqual(await runtimePids(), baseline);
  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: 'Bearer change.me', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'lfm3-omni-2b',
      input: 'Hello world.',
      lang: 'en',
      voice: 'female',
      seed: 42,
      n_predict: 128,
      response_format: 'wav',
    }),
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) assert.fail(await response.text());
  assert.match(response.headers.get('content-type') || '', /audio\/wav/);
  const wave = resolve(directory, 'cpu-speech.wav');
  await writeFile(wave, Buffer.from(await response.arrayBuffer()));
  const decoded = await verifyAudio(wave);
  const log = output();
  await writeFile(resolve(directory, 'cpu-omni-runtime.log'), log);
  await writeFile(resolve(directory, 'cpu-speech.json'), JSON.stringify(decoded, null, 2));
  assert.match(log, /CPU(?:_Mapped)? .*model buffer|model buffer.*CPU/i);
  assert.match(log, /offloaded 0\/[0-9]+ layers to GPU/i);
  assert.equal((log.match(/CLIP using CPU backend/g) || []).length, 3);
  assert.match(log, /CLIP using CPU backend\r?\n[^\n]*projector:\s+lfm3a_gen/);
  assert.doesNotMatch(log, /CUDA[0-9]+ .*model buffer|model buffer.*CUDA[0-9]+/i);
});
