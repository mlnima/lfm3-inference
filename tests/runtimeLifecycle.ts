import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answer,
  backendPort,
  decisionPort,
  exited,
  infer,
  launch,
  listening,
  proxyPort,
  runtimePids,
  waitFor,
} from './lifecycleSupport.ts';

test('production gateway and model listing start without loading weights', async (t) => {
  const { child, output, baseline } = await launch(t, { bothModels: true });
  assert.equal(await listening(backendPort), false);
  assert.equal(await listening(decisionPort), false);
  assert.deepEqual(await runtimePids(), baseline);
  const response = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models', {
    headers: { authorization: 'Bearer change.me' },
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { data: { id: string }[] };
  assert.equal(result.data.length, 2);
  assert.deepEqual(await runtimePids(), baseline);
  child.send('stop');
  await exited(child, output);
  assert.equal(child.exitCode, 0, output());
});

test('concurrent first requests share one selected model load', { timeout: 180000 }, async (t) => {
  const { output } = await launch(t, { bothModels: true });
  await Promise.all((await Promise.all([infer(), infer()])).map(answer));
  assert.equal(await listening(backendPort), true);
  assert.equal(await listening(decisionPort), false);
  const loads = output()
    .split('\n')
    .filter((line) => line.includes("loading model '"));
  assert.equal(loads.length, 1, output());
});

test('production SIGTERM stops a loaded native runtime and supervisor', async (t) => {
  const { child, output } = await launch(t);
  await answer(await infer());
  child.send('stop');
  await exited(child, output);
  assert.equal(child.exitCode, 0, output());
});

test('forced gateway termination cleans its loaded native process tree', async (t) => {
  const { child, output } = await launch(t);
  await answer(await infer());
  child.kill('SIGKILL');
  await exited(child, output);
});

test('shutdown during first model load cleans supervised children', async (t) => {
  const { child, output } = await launch(t);
  const pending = infer().catch((error: Error) => error);
  await waitFor(async () => output().includes("loading model '"));
  child.send('stop');
  await exited(child, output);
  const response = await pending;
  assert.ok(response instanceof Error || response.status >= 400);
  assert.equal(child.exitCode, 0, output());
});

test('missing model fails on request and leaves the gateway available', async (t) => {
  const { baseline } = await launch(t, { invalidModel: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await infer();
    assert.ok(response.status >= 400, await response.clone().text());
    assert.equal(typeof (await response.json()).error.message, 'string');
    assert.equal(await listening(proxyPort), true);
    await waitFor(async () => [...(await runtimePids())].every((pid) => baseline.has(pid)));
  }
});

test('missing executable fails on request without leaving a supervisor', async (t) => {
  const { baseline } = await launch(t, { invalidExecutable: true });
  const response = await infer();
  assert.ok(response.status >= 400, await response.clone().text());
  assert.equal(await listening(proxyPort), true);
  await waitFor(async () => [...(await runtimePids())].every((pid) => baseline.has(pid)));
});

test('development source loads on demand, answers, and stops cleanly', async (t) => {
  const { child, output, baseline } = await launch(t, { development: true });
  assert.deepEqual(await runtimePids(), baseline);
  await answer(await infer());
  child.send('stop');
  await exited(child, output);
  assert.equal(child.exitCode, 0, output());
});

test('parent IPC disconnect stops the loaded gateway and model process tree', async (t) => {
  const { child, output } = await launch(t);
  await answer(await infer());
  child.disconnect();
  await exited(child, output);
  assert.equal(child.exitCode, 0, output());
});
