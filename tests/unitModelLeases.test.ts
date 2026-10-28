import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import type { RuntimeManager, ServerConfig } from '../src/config/types.js';
import { createGateway } from '../src/http/createGateway.js';

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
};

const config = (requestTimeoutMs = 1000): ServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  apiKey: 'test-key',
  llamaServerBin: '',
  device: 'gpu',
  gpuLayers: 'all',
  idleTimeoutMs: 20,
  startupTimeoutMs: 1000,
  shutdownTimeoutMs: 1000,
  requestTimeoutMs,
  maxBodyBytes: 4096,
  models: [],
});

const fixture = async (
  context: TestContext,
  acquire: RuntimeManager['acquire'],
  nativeOrigin = 'http://127.0.0.1:1',
  requestTimeoutMs = 1000,
) => {
  const gateway = createGateway(config(requestTimeoutMs), {
    models: [{ id: 'model', role: 'omni', modelPath: '', port: 1, origin: nativeOrigin }],
    acquire,
    stop: async () => undefined,
  });
  context.after(() => gateway.close());
  return listen(gateway.server);
};

const post = (base: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

test('metadata, authentication failures and unknown models do not acquire weights', async (t) => {
  let loads = 0;
  const base = await fixture(t, async () => {
    loads++;
    return () => undefined;
  });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/v1/models`, {
        headers: { authorization: 'Bearer test-key' },
      })
    ).status,
    200,
  );
  assert.equal((await post(base, { model: 'missing' })).status, 404);
  assert.equal(loads, 0);
});

test('a failed load returns an error while the gateway remains healthy', async (t) => {
  const base = await fixture(t, async () => {
    throw new Error('Model could not load');
  });
  const response = await post(base, { model: 'model' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /could not load/);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a disconnected HTTP waiter cancels its pending acquisition', async (t) => {
  let acquisitionSignal: AbortSignal | undefined;
  let entered: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const base = await fixture(t, async (_id, signal) => {
    acquisitionSignal = signal;
    entered();
    return new Promise<() => void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const abort = new AbortController();
  const response = post(base, { model: 'model' }, abort.signal);
  await waiting;
  abort.abort();
  await assert.rejects(response, { name: 'AbortError' });
  for (let count = 0; count < 50 && !acquisitionSignal?.aborted; count++) await delay(5);
  assert.equal(acquisitionSignal?.aborted, true);
});

test('an HTTP stream holds its lease until the response ends', async (t) => {
  let complete: () => void = () => undefined;
  let releases = 0;
  const native = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"token":"hello"}\n\n');
    complete = () => response.end('data: [DONE]\n\n');
  });
  const origin = await listen(native);
  t.after(() => new Promise<void>((resolve) => native.close(() => resolve())));
  const base = await fixture(t, async () => () => void releases++, origin);
  const response = await post(base, { model: 'model', stream: true });
  const reader = response.body!.getReader();
  assert.ok((await reader.read()).value?.length);
  await delay(60);
  assert.equal(releases, 0);
  complete();
  while (!(await reader.read()).done) continue;
  assert.equal(releases, 1);
});

test('real-time lease survives request timeout until the socket closes', async (t) => {
  let releases = 0;
  const native = createServer();
  const websocket = new WebSocketServer({ server: native });
  websocket.on('connection', (socket) => socket.send('{"type":"session.created"}'));
  const origin = await listen(native);
  t.after(async () => {
    websocket.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    await new Promise<void>((resolve) => native.close(() => resolve()));
  });
  const base = await fixture(t, async () => () => void releases++, origin, 100);
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/realtime?model=model', {
    headers: { authorization: 'Bearer test-key' },
  });
  t.after(() => socket.terminate());
  const [message] = await once(socket, 'message');
  assert.equal(JSON.parse(message.toString()).type, 'session.created');
  await delay(250);
  assert.equal(releases, 0);
  assert.equal(socket.readyState, WebSocket.OPEN);
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  for (let count = 0; count < 50 && !releases; count++) await delay(5);
  assert.equal(releases, 1);
});
