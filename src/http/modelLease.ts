import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RuntimeManager } from '../config/types.js';

export const acquireModel = async (
  runtimes: RuntimeManager,
  modelId: string,
  target: ServerResponse | Duplex,
  timeout: number,
  finishResponse = true,
): Promise<boolean> => {
  if (target.destroyed) return false;
  const closed = new AbortController();
  let release: (() => void) | undefined;
  const detach = (): void => {
    target.removeListener('close', complete);
    finishResponse && target.removeListener('finish', complete);
  };
  const complete = (): void => {
    closed.abort();
    release?.();
    detach();
  };
  target.once('close', complete);
  finishResponse && target.once('finish', complete);
  const timer = setTimeout(
    () => closed.abort(new DOMException('Model loading timed out.', 'TimeoutError')),
    timeout,
  );
  timer.unref();
  try {
    release = await runtimes.acquire(modelId, closed.signal);
    if (closed.signal.aborted || target.destroyed) {
      complete();
      return false;
    }
    return true;
  } catch (error) {
    detach();
    const failure = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(failure, {
      status: failure.name === 'TimeoutError' ? 504 : 503,
    });
  } finally {
    clearTimeout(timer);
  }
};
