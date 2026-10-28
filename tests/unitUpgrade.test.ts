import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import type { ServerConfig } from '../src/config/types.js';
import { createGateway } from '../src/http/createGateway.js';
import { managedModels } from './managedModels.ts';

test('malformed upgrades are rejected and pending handshakes time out', async (context) => {
  const native = createServer();
  const sockets = new Set<import('node:net').Socket>();
  native.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  native.on('upgrade', () => undefined);
  native.listen(0, '127.0.0.1');
  await once(native, 'listening');
  const backend = native.address();
  assert.ok(backend && typeof backend !== 'string');
  const settings: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    apiKey: 'test-key',
    llamaServerBin: '',
    gpuLayers: 'all',
    device: 'gpu',
    idleTimeoutMs: 300000,
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    requestTimeoutMs: 100,
    maxBodyBytes: 4096,
    models: [],
  };
  const gateway = createGateway(
    settings,
    managedModels([
      {
        id: 'omni-test',
        role: 'omni',
        modelPath: '',
        port: backend.port,
        origin: `http://127.0.0.1:${backend.port}`,
      },
    ]),
  );
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const address = gateway.server.address();
  assert.ok(address && typeof address !== 'string');
  context.after(async () => {
    await gateway.close();
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => native.close(() => resolve()));
  });
  const handshake = async (path: string): Promise<string> => {
    const socket = connect(address.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) =>
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    );
    socket.on('error', () => undefined);
    const closed = once(socket, 'close');
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n` +
        'Upgrade: websocket\r\nAuthorization: Bearer test-key\r\n\r\n',
    );
    await closed;
    return Buffer.concat(chunks).toString();
  };
  assert.match(await handshake('//['), /400 Bad Request/);
  assert.equal(await handshake('/v1/realtime?model=omni-test'), '');
  const reset = connect(address.port, '127.0.0.1');
  reset.on('error', () => undefined);
  await once(reset, 'connect');
  reset.write(
    'GET /v1/realtime HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n' +
      'Upgrade: websocket\r\nAuthorization: Bearer test-key\r\n\r\n',
  );
  reset.resetAndDestroy();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
});
