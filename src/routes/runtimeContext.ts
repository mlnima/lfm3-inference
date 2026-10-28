import type { ServerResponse } from 'node:http';
import type { RunningModel } from '../config/types.js';
import { readAudioProfile } from '../runtime/readAudioProfile.js';
import { sendJson } from '../http/response.js';

export const runtimeContext = async (
  model: RunningModel,
  response: ServerResponse,
  timeout: number,
): Promise<void> => {
  const closed = new AbortController();
  response.once('close', () => closed.abort());
  const result = await fetch(`${model.origin}/props`, {
    signal: AbortSignal.any([closed.signal, AbortSignal.timeout(timeout)]),
  });
  if (!result.ok) throw new Error(`Runtime metadata failed (${result.status}).`);
  const props = (await result.json()) as {
    default_generation_settings?: { n_ctx?: number };
    total_slots?: number;
  };
  const contextWindow = props.default_generation_settings?.n_ctx;
  const totalSlots = props.total_slots;
  if (!Number.isSafeInteger(contextWindow) || Number(contextWindow) < 1) {
    throw new Error('Runtime did not report its configured context window.');
  }
  if (!Number.isSafeInteger(totalSlots) || Number(totalSlots) < 1) {
    throw new Error('Runtime did not report its slot count.');
  }
  const audio = await readAudioProfile(model.projectorPath);
  sendJson(response, 200, { contextWindow, totalSlots, ...audio });
};
