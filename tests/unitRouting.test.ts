import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { ServerConfig } from '../src/config/types.js';
import { createGateway } from '../src/http/createGateway.js';
import { managedModels } from './managedModels.ts';

const listen = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
};

test('additional models route by ID for JSON and multipart requests', async (context) => {
  let cancelled: () => void;
  const cancellation = new Promise<void>((resolve) => (cancelled = resolve));
  let received: () => void;
  const receipt = new Promise<void>((resolve) => (received = resolve));
  const first = createServer((request, response) => {
    request.resume();
    response.end('first');
  });
  const second = createServer((request, response) => {
    request.resume();
    if (request.url === '/v1/messages') {
      response.once('close', () => cancelled());
      received();
      return;
    }
    response.end('second');
  });
  const ports = await Promise.all([listen(first), listen(second)]);
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    llamaServerBin: '',
    gpuLayers: 'all',
    device: 'gpu',
    idleTimeoutMs: 300000,
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    requestTimeoutMs: 3000,
    maxBodyBytes: 4096,
    models: [],
  };
  const models = ports.map((port, index) => ({
    id: `model-${index}`,
    role: 'omni' as const,
    modelPath: '',
    port,
    origin: `http://127.0.0.1:${port}`,
  }));
  const gateway = createGateway(config, managedModels(models));
  const port = await listen(gateway.server);
  const base = `http://127.0.0.1:${port}`;
  context.after(async () => {
    await gateway.close();
    await Promise.all(
      [first, second].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });
  const post = (body: unknown, signal?: AbortSignal, path = '/v1/chat/completions') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  assert.equal(await (await post({})).text(), 'first');
  assert.equal(await (await post({ model: 'model-1' })).text(), 'second');
  const form = new FormData();
  form.set('model', 'model-1');
  form.set('input', 'Hello');
  form.set('speaker_ref', new File([Buffer.from([1, 2, 3])], 'reference.wav'));
  const audio = await fetch(`${base}/tts`, { method: 'POST', body: form });
  assert.equal(await audio.text(), 'second');
  const abort = new AbortController();
  const response = post({ model: 'model-1' }, abort.signal, '/v1/messages');
  await receipt;
  abort.abort();
  await assert.rejects(response, { name: 'AbortError' });
  await cancellation;
});
