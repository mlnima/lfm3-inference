import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeLauncher, ServerConfig } from '../src/config/types.js';
import { createRuntimeManager } from '../src/runtime/createRuntimeManager.js';

const config = (idleTimeoutMs = 20): ServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  llamaServerBin: '',
  device: 'gpu',
  gpuLayers: 'all',
  idleTimeoutMs,
  startupTimeoutMs: 1000,
  shutdownTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  maxBodyBytes: 4096,
  models: [
    { id: 'first', role: 'omni', modelPath: '', port: 1 },
    { id: 'second', role: 'decision', modelPath: '', port: 2 },
  ],
});

const until = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Manager operation timed out');
    await delay(2);
  }
};

test('constructor is lazy and concurrent leases share one load', async (t) => {
  const launches: string[] = [];
  let complete: () => void = () => undefined;
  let stops = 0;
  const loading = new Promise<void>((resolve) => (complete = resolve));
  const launch: RuntimeLauncher = async (value) => {
    launches.push(value.models[0].id);
    await loading;
    return { models: [], stop: async () => void stops++ };
  };
  const manager = createRuntimeManager(config(), launch);
  t.after(() => manager.stop());
  assert.deepEqual(launches, []);
  assert.equal(manager.models.length, 2);
  const first = manager.acquire('first');
  const second = manager.acquire('first');
  await until(() => launches.length === 1);
  complete();
  const [releaseFirst, releaseSecond] = await Promise.all([first, second]);
  releaseFirst();
  releaseFirst();
  await delay(60);
  assert.equal(stops, 0, 'The second active lease must protect the model');
  releaseSecond();
  await until(() => stops === 1);
  assert.deepEqual(launches, ['first']);
});

test('idle models unload independently and a later request reloads only its model', async (t) => {
  const launches: string[] = [];
  const stopped: string[] = [];
  const manager = createRuntimeManager(config(), async (value) => {
    const id = value.models[0].id;
    launches.push(id);
    return { models: [], stop: async () => void stopped.push(id) };
  });
  t.after(() => manager.stop());
  const first = await manager.acquire('first');
  const second = await manager.acquire('second');
  first();
  await until(() => stopped.length === 1);
  assert.deepEqual(stopped, ['first']);
  const reloaded = await manager.acquire('first');
  assert.deepEqual(launches, ['first', 'second', 'first']);
  second();
  reloaded();
});

test('one cancelled waiter does not cancel another waiter sharing its load', async (t) => {
  const controller = new AbortController();
  let complete: () => void = () => undefined;
  let loadSignal: AbortSignal | undefined;
  const loading = new Promise<void>((resolve) => (complete = resolve));
  const manager = createRuntimeManager(config(0), async (_value, _failed, signal) => {
    loadSignal = signal;
    await loading;
    return { models: [], stop: async () => undefined };
  });
  t.after(() => manager.stop());
  const cancelled = manager.acquire('first', controller.signal);
  const surviving = manager.acquire('first');
  await until(() => Boolean(loadSignal));
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(loadSignal?.aborted, false);
  complete();
  (await surviving)();
});

test('cancelling the last waiter aborts loading and a fresh request can retry', async (t) => {
  let attempts = 0;
  let aborted = false;
  const manager = createRuntimeManager(config(0), async (_value, _failed, signal) => {
    attempts++;
    if (attempts === 1) {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
    return { models: [], stop: async () => undefined };
  });
  t.after(() => manager.stop());
  const controller = new AbortController();
  const pending = manager.acquire('first', controller.signal);
  await until(() => attempts === 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await until(() => aborted);
  (await manager.acquire('first'))();
  assert.equal(attempts, 2);
});

test('new requests wait for an idle unload to finish before reloading', async (t) => {
  let attempts = 0;
  let stopStarted = false;
  let finishStop: () => void = () => undefined;
  const stopping = new Promise<void>((resolve) => (finishStop = resolve));
  const manager = createRuntimeManager(config(), async () => {
    attempts++;
    return {
      models: [],
      stop: async () => {
        if (attempts !== 1) return;
        stopStarted = true;
        await stopping;
      },
    };
  });
  t.after(() => manager.stop());
  (await manager.acquire('first'))();
  await until(() => stopStarted);
  const pending = manager.acquire('first');
  await delay(40);
  assert.equal(attempts, 1);
  finishStop();
  (await pending)();
  assert.equal(attempts, 2);
});

test('runtime failures unload only that model and permit a later retry', async (t) => {
  let attempts = 0;
  let stopped = 0;
  let fail: (error: Error) => void = () => undefined;
  const manager = createRuntimeManager(config(0), async (_value, failed) => {
    attempts++;
    fail = failed;
    return { models: [], stop: async () => void stopped++ };
  });
  t.after(() => manager.stop());
  const release = await manager.acquire('first');
  fail(new Error('Native process exited'));
  await until(() => stopped === 1);
  (await manager.acquire('first'))();
  release();
  assert.equal(attempts, 2);
});

test('zero idle timeout keeps a model resident until explicit shutdown', async () => {
  let stopped = 0;
  const manager = createRuntimeManager(config(0), async () => ({
    models: [],
    stop: async () => void stopped++,
  }));
  (await manager.acquire('first'))();
  await delay(60);
  assert.equal(stopped, 0);
  await manager.stop();
  await manager.stop();
  assert.equal(stopped, 1);
  await assert.rejects(manager.acquire('first'), /stopping/);
});

test('shutdown waits for a late launcher and stops the returned process', async () => {
  let complete: () => void = () => undefined;
  const loading = new Promise<void>((resolve) => (complete = resolve));
  let entered = false;
  let stopped = 0;
  const manager = createRuntimeManager(config(), async () => {
    entered = true;
    await loading;
    return { models: [], stop: async () => void stopped++ };
  });
  const pending = manager.acquire('first');
  await until(() => entered);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const stop = manager.stop();
  assert.equal(stopped, 0);
  complete();
  await Promise.all([rejected, stop]);
  assert.equal(stopped, 1);
});

test('failed cleanup prevents a duplicate load and is reported by shutdown', async () => {
  let attempts = 0;
  let stopping = false;
  const manager = createRuntimeManager(config(), async () => {
    attempts++;
    return {
      models: [],
      stop: async () => {
        stopping = true;
        throw new Error('Native cleanup failed');
      },
    };
  });
  (await manager.acquire('first'))();
  await until(() => stopping);
  await assert.rejects(manager.acquire('first'), /Native cleanup failed/);
  assert.equal(attempts, 1);
  await assert.rejects(manager.stop(), /Native cleanup failed/);
});
