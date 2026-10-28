import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkerConfig } from '../config/types.js';
import { signalTree } from './processTree.js';

let child: ChildProcess | undefined;
let stopPromise: Promise<void> | undefined;
let timeoutMs = 10000;

const stop = (): Promise<void> => {
  stopPromise ||= (async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      await signalTree(child.pid);
      await Promise.race([exited, delay(timeoutMs, undefined, { ref: false })]);
      child.exitCode === null && child.signalCode === null && (await signalTree(child.pid, true));
      await exited;
    }
    process.connected && process.disconnect?.();
  })();
  return stopPromise;
};

process.on('disconnect', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('message', (message: WorkerConfig | 'stop') => {
  if (message === 'stop') {
    void stop();
    return;
  }
  if (stopPromise) return;
  timeoutMs = message.shutdownTimeoutMs;
  const model = message.model;
  const args = [
    '--host',
    '127.0.0.1',
    '--port',
    String(model.port),
    '--model',
    model.modelPath,
    '--alias',
    model.id,
    '--n-gpu-layers',
    message.gpuLayers,
    '--ctx-size',
    '8192',
    '--parallel',
    '1',
    ...(model.projectorPath ? ['--mmproj', model.projectorPath] : []),
    ...(model.role === 'decision'
      ? ['--batch-size', '8192', '--ubatch-size', '8192']
      : ['--reasoning', 'off', '--jinja']),
    ...(model.args || []),
  ];
  child = spawn(message.executable, args, {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    process.connected && process.send?.({ error: error.message });
    void stop();
  });
  child.once('exit', (code, signal) => {
    !stopPromise &&
      process.connected &&
      process.send?.({ error: `${model.id}: ${code || signal}` });
    void stop();
  });
  process.connected && process.send?.({ pid: child.pid });
});
