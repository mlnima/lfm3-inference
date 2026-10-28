import type {
  RuntimeEntry,
  RuntimeLauncher,
  RuntimeManager,
  ServerConfig,
} from '../config/types.js';
import { startRuntimes } from './startRuntimes.js';

const waitForLoad = (loading: Promise<void>, signal?: AbortSignal): Promise<void> => {
  if (!signal) return loading;
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    signal.aborted && abort();
    loading.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
};

export const createRuntimeManager = (
  config: ServerConfig,
  launch: RuntimeLauncher = startRuntimes,
): RuntimeManager => {
  const entries: RuntimeEntry[] = config.models.map((model) => ({
    model: { ...model, origin: `http://127.0.0.1:${model.port}` },
    users: 0,
  }));
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  const clearIdle = (entry: RuntimeEntry): void => {
    entry.timer && clearTimeout(entry.timer);
    entry.timer = undefined;
  };

  const unload = (entry: RuntimeEntry): Promise<void> => {
    clearIdle(entry);
    if (entry.unloading) return entry.unloading;
    entry.controller?.abort();
    const runtime = entry.runtime;
    entry.runtime = undefined;
    entry.unloading = (async () => {
      await entry.loading?.catch(() => undefined);
      const loaded = entry.runtime;
      entry.runtime = undefined;
      await Promise.all([runtime?.stop(), loaded?.stop()]);
    })().then(() => {
      entry.unloading = undefined;
    });
    return entry.unloading;
  };

  const ensureRunning = async (entry: RuntimeEntry): Promise<void> => {
    await entry.unloading;
    if (stopping) throw new Error('Inference server is stopping.');
    if (!entry.users) throw new Error('Model request was cancelled.');
    if (entry.controller?.signal.aborted) {
      await entry.loading?.catch(() => undefined);
      return ensureRunning(entry);
    }
    if (entry.runtime) return;
    if (!entry.loading) {
      const controller = new AbortController();
      entry.controller = controller;
      entry.loading = Promise.resolve()
        .then(async () => {
          controller.signal.throwIfAborted();
          const runtime = await launch(
            { ...config, models: [entry.model] },
            () => void unload(entry).catch(() => undefined),
            controller.signal,
          );
          entry.runtime = runtime;
          if (stopping || controller.signal.aborted) {
            controller.signal.throwIfAborted();
            throw new Error('Inference server is stopping.');
          }
        })
        .finally(() => {
          entry.loading = undefined;
          entry.controller = undefined;
        });
    }
    await entry.loading;
  };

  const acquire = async (modelId: string, signal?: AbortSignal): Promise<() => void> => {
    signal?.throwIfAborted();
    if (stopping) throw new Error('Inference server is stopping.');
    const entry = entries.find((item) => item.model.id === modelId);
    if (!entry) throw new Error(`Unknown model: ${modelId}`);
    clearIdle(entry);
    entry.users++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      entry.users--;
      if (entry.users || stopping) return;
      if (entry.loading) {
        void unload(entry).catch(() => undefined);
        return;
      }
      if (!entry.runtime || !config.idleTimeoutMs) return;
      entry.timer = setTimeout(
        () => void unload(entry).catch(() => undefined),
        config.idleTimeoutMs,
      );
      entry.timer.unref();
    };
    signal?.addEventListener('abort', release, { once: true });
    signal?.aborted && release();
    try {
      await waitForLoad(ensureRunning(entry), signal);
      signal?.throwIfAborted();
      if (stopping) throw new Error('Inference server is stopping.');
      return release;
    } catch (error) {
      release();
      throw error;
    }
  };

  const stop = (): Promise<void> => {
    stopping = true;
    stopPromise ||= Promise.all(entries.map(unload)).then(() => undefined);
    return stopPromise;
  };

  return { models: entries.map((entry) => entry.model), acquire, stop };
};
