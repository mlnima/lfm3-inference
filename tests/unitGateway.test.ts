import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { RunningModel, ServerConfig } from '../src/config/types.js';
import { createGateway } from '../src/http/createGateway.js';
import { floatPcmToInt16 } from '../src/http/pcm.js';

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
};

const settings: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'test-key',
  llamaServerBin: '',
  gpuLayers: 'all',
  startupTimeoutMs: 1000,
  shutdownTimeoutMs: 1000,
  requestTimeoutMs: 3000,
  maxBodyBytes: 4096,
  models: [],
};

test('gateway routes models and preserves binary and event stream responses', async (context) => {
  const binary = Buffer.from([82, 73, 70, 70, 0, 255, 0, 128]);
  const native = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-api-key'], undefined);
    if (request.url === '/tts') {
      assert.equal(body.input, 'Speak this');
      response.writeHead(200, { 'content-type': 'audio/wav' }).end(binary);
      return;
    }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"text":"hello"}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: body.model, path: request.url }));
  });
  const origin = await listen(native);
  const models: RunningModel[] = [
    { id: 'omni-test', role: 'omni', modelPath: '', port: 0, origin },
    { id: 'decision-test', role: 'decision', modelPath: '', port: 0, origin },
  ];
  const gateway = createGateway(settings, models);
  const base = await listen(gateway.server);
  context.after(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => native.close(() => resolve()));
  });
  const post = (path: string, body: unknown, key = 'test-key') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await post('/v1/chat/completions', {}, 'wrong')).status, 401);
  const listing = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'test-key' } });
  assert.deepEqual(
    (await listing.json()).data.map((model: { id: string }) => model.id),
    ['omni-test', 'decision-test'],
  );
  const decision = await post('/v1/systemone', { model: 'decision-test', state: 'example' });
  assert.equal((await decision.json()).path, '/v1/systemone');
  assert.equal((await post('/v1/chat/completions', { model: 'decision-test' })).status, 404);
  assert.equal((await post('/v1/chat/completions', { model: 'missing' })).status, 404);
  assert.equal((await post('/tools', {})).status, 404);
  const audio = await post('/v1/audio/speech', { model: 'omni-test', input: 'Speak this' });
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), binary);
  const stream = await post('/v1/messages', { model: 'omni-test', stream: true });
  assert.equal(await stream.text(), 'data: {"text":"hello"}\n\ndata: [DONE]\n\n');
  const options = await fetch(`${base}/v1/messages`, {
    method: 'OPTIONS',
    headers: { 'access-control-request-headers': 'x-api-key, x-stainless-lang' },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), '*');
  assert.equal(options.headers.get('access-control-allow-headers'), 'x-api-key, x-stainless-lang');
  assert.equal((await post('/v1/chat/completions', { text: 'x'.repeat(5000) })).status, 400);
});

test('PCM conversion preserves samples across arbitrary upstream chunks', async () => {
  const input = Buffer.alloc(20);
  [-1, -0.5, 0, 0.5, 1].forEach((value, index) => input.writeFloatLE(value, index * 4));
  const transform = floatPcmToInt16();
  const chunks: Buffer[] = [];
  const finished = (async () => {
    for await (const chunk of transform) chunks.push(chunk);
  })();
  transform.write(input.subarray(0, 3));
  transform.write(input.subarray(3, 11));
  transform.end(input.subarray(11));
  await finished;
  const output = Buffer.concat(chunks);
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => output.readInt16LE(index * 2)),
    [-32768, -16384, 0, 16384, 32767],
  );
});
