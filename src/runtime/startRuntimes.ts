import { fork, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunningModel, ServerConfig } from '../config/types.js';
import { assertPortAvailable } from './assertPortAvailable.js';

export const startRuntimes = async (
  config: ServerConfig,
  onFailure: (error: Error) => void,
  signal?: AbortSignal,
): Promise<{ models: RunningModel[]; stop: () => Promise<void> }> => {
  const workers: ChildProcess[] = [];
  let stopping = false;
  let started = false;
  let failure: Error | undefined;
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopPromise ||= (async () => {
      stopping = true;
      signal?.removeEventListener('abort', abort);
      await Promise.all(
        workers.map(async (worker) => {
          if (worker.exitCode !== null || worker.signalCode !== null) return;
          const exited = new Promise<void>((resolve) => worker.once('close', () => resolve()));
          worker.connected && worker.send('stop');
          await exited;
        }),
      );
    })();
    return stopPromise;
  };

  const abort = (): void => {
    void stop();
  };
  signal?.addEventListener('abort', abort, { once: true });

  const fail = (error: Error): void => {
    if (stopping || failure) return;
    failure = error;
    started && onFailure(error);
    void stop();
  };

  const models = config.models.map((model) => ({
    ...model,
    origin: `http://127.0.0.1:${model.port}`,
  }));

  try {
    for (const model of models) {
      signal?.throwIfAborted();
      await assertPortAvailable(model.port);
      signal?.throwIfAborted();
      const suffix = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      const worker = fork(new URL(`./runtimeWorker.${suffix}`, import.meta.url), [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      workers.push(worker);
      worker.on('error', fail);
      worker.on('message', (message: { error?: string }) => {
        message.error && fail(new Error(message.error));
      });
      worker.once('exit', (code, signal) => {
        fail(new Error(`${model.id} supervisor exited: ${code || signal}`));
      });
      worker.send({
        executable: config.llamaServerBin,
        model,
        gpuLayers: config.gpuLayers,
        shutdownTimeoutMs: config.shutdownTimeoutMs,
      });
      const deadline = Date.now() + config.startupTimeoutMs;
      let ready = false;
      while (!ready && !failure && !signal?.aborted && Date.now() < deadline) {
        ready = await fetch(`${model.origin}/health`, { signal: AbortSignal.timeout(1000) })
          .then((response) => response.ok)
          .catch(() => false);
        !ready && !failure && (await delay(250));
      }
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (!ready) throw new Error(`${model.id} startup exceeded ${config.startupTimeoutMs}ms.`);
    }
    started = true;
    signal?.removeEventListener('abort', abort);
    return { models, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
