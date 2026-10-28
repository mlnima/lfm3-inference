import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import {
  answer,
  backendPort,
  infer,
  launch,
  listening,
  proxyPort,
  runtimePids,
  waitFor,
} from './lifecycleSupport.ts';

test('idle timeout unloads weights and the next request loads them again', async (t) => {
  const { output, baseline } = await launch(t, { idleTimeoutMs: 500 });
  await answer(await infer());
  await waitFor(async () => !(await listening(backendPort)));
  await waitFor(async () => [...(await runtimePids())].every((pid) => baseline.has(pid)));
  assert.equal(await listening(proxyPort), true);
  await answer(await infer());
  assert.equal(await listening(backendPort), true);
  const loads = output()
    .split('\n')
    .filter((line) => line.includes("loading model '"));
  assert.equal(loads.length, 2, output());
});

test('an active HTTP event stream prevents idle unloading', async (t) => {
  await launch(t, { idleTimeoutMs: 150 });
  const response = await infer('lfm3-omni-2b', {
    messages: [{ role: 'user', content: 'Write a long story about a mountain expedition.' }],
    stream: true,
    max_tokens: 2048,
    ignore_eos: true,
  });
  if (!response.ok) assert.fail(await response.text());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body!.getReader();
  try {
    assert.ok((await reader.read()).value?.length);
    await delay(450);
    assert.equal(await listening(backendPort), true);
  } finally {
    await reader.cancel();
  }
  await waitFor(async () => !(await listening(backendPort)));
});

test('an open real-time session protects its model until the socket closes', async (t) => {
  await launch(t, { idleTimeoutMs: 150 });
  const socket = new WebSocket('ws://127.0.0.1:' + proxyPort + '/v1/realtime?model=lfm3-omni-2b', {
    headers: { authorization: 'Bearer change.me' },
    handshakeTimeout: 90000,
  });
  try {
    const event = await new Promise<{ type: string }>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    assert.equal(event.type, 'session.created');
    await delay(600);
    assert.equal(await listening(backendPort), true);
  } finally {
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 3000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }
  await waitFor(async () => !(await listening(backendPort)));
});
