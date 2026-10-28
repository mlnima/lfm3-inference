import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGateway } from '../src/http/createGateway.js';
import { readAudioProfile } from '../src/runtime/readAudioProfile.js';
import { managedModels } from './managedModels.ts';

const uint = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const size = (value: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};
const string = (value: string): Buffer => Buffer.concat([size(value.length), Buffer.from(value)]);

test('audio context profile is identified from encoder metadata, not model name', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gguf-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projector = join(directory, 'projector.gguf');
  const metadata = (encoder: string) =>
    Buffer.concat([
      Buffer.from('GGUF'),
      uint(3),
      size(0),
      size(3),
      string('unrelated.name'),
      uint(8),
      string('example'),
      string('unrelated.array'),
      uint(9),
      uint(4),
      size(2),
      uint(1),
      uint(2),
      string('clip.audio.projector_type'),
      uint(8),
      string(encoder),
    ]);
  await writeFile(projector, metadata('lfm3a'));
  assert.deepEqual(await readAudioProfile(projector), {
    audioInputSampleRate: 16000,
    audioInputSamplesPerToken: 1280,
  });
  await writeFile(projector, metadata('another-encoder'));
  assert.equal(await readAudioProfile(projector), undefined);
});

test('authenticated context and token helpers expose actual runtime metadata', async (t) => {
  const received: string[] = [];
  const native = createServer(async (request, response) => {
    received.push(request.url || '');
    assert.equal(request.headers.authorization, undefined);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/props') {
      response.end(
        JSON.stringify({ default_generation_settings: { n_ctx: 6144 }, total_slots: 2 }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.end(JSON.stringify(request.url === '/tokenize' ? { tokens: [1, 2] } : body));
  });
  native.listen(0, '127.0.0.1');
  await once(native, 'listening');
  const address = native.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = createGateway(
    { apiKey: 'context-key', requestTimeoutMs: 1000, maxBodyBytes: 4096 } as never,
    managedModels([
      {
        id: 'example',
        role: 'omni',
        modelPath: '',
        port: address.port,
        origin: `http://127.0.0.1:${address.port}`,
      },
    ]),
  );
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const local = gateway.server.address();
  assert.ok(local && typeof local !== 'string');
  t.after(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => native.close(() => resolve()));
  });
  const post = (path: string, body: object, key = 'context-key') =>
    fetch(`http://127.0.0.1:${local.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'example', ...body }),
    });
  assert.equal((await post('/v1/context', {}, 'wrong')).status, 401);
  assert.deepEqual(await (await post('/v1/context', {})).json(), {
    contextWindow: 6144,
    totalSlots: 2,
  });
  assert.deepEqual(await (await post('/v1/tokenize', { content: 'hello' })).json(), {
    tokens: [1, 2],
  });
  assert.equal((await post('/v1/apply-template', { messages: [] })).status, 200);
  assert.deepEqual(received, ['/props', '/tokenize', '/apply-template']);
});
