import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeManager, ServerConfig } from '../config/types.js';
import { readBody, readForm, readJson } from '../http/body.js';
import { proxy } from '../http/proxy.js';
import { sendError, sendJson } from '../http/response.js';
import { selectModel } from '../http/selectModel.js';
import { acquireModel } from '../http/modelLease.js';
import { speechRequest, transcribe, transcriptionRequest } from './audio.js';
import { runtimeContext } from './runtimeContext.js';

const inferencePaths = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/systemone',
  '/completion',
  '/completions',
  '/tts',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
  '/v1/context',
  '/v1/tokenize',
  '/v1/apply-template',
]);

export const authorized = (request: IncomingMessage, key?: string): boolean =>
  !key || request.headers.authorization === `Bearer ${key}` || request.headers['x-api-key'] === key;

export const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  runtimes: RuntimeManager,
): Promise<void> => {
  const models = runtimes.models;
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    request.headers['access-control-request-headers'] ||
      'content-type, authorization, x-api-key, anthropic-version, anthropic-beta, openai-beta',
  );
  response.setHeader('cache-control', 'no-store');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  const path = new URL(request.url || '/', 'http://localhost').pathname;
  if (path === '/health' && request.method === 'GET') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (!authorized(request, config.apiKey)) {
    sendError(response, 401, 'Invalid API key.');
    return;
  }
  if (path === '/v1/models' && request.method === 'GET') {
    sendJson(response, 200, {
      object: 'list',
      data: models.map(({ id, role }) => ({ id, object: 'model', owned_by: 'local', role })),
    });
    return;
  }
  if (request.method !== 'POST' || !inferencePaths.has(path)) {
    sendError(response, 404, 'Unknown inference endpoint.');
    return;
  }
  const bytes = await readBody(request, config.maxBodyBytes);
  if (path === '/v1/audio/transcriptions') {
    const transcription = await transcriptionRequest(request.headers['content-type'] || '', bytes);
    const model = selectModel(models, transcription.model, 'omni');
    if (!model) {
      sendError(response, 404, 'Unknown audio model.');
      return;
    }
    if (!['json', 'text'].includes(transcription.format)) {
      sendError(response, 400, 'Transcription response_format must be json or text.');
      return;
    }
    if (!(await acquireModel(runtimes, model.id, response, config.requestTimeoutMs))) return;
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    const result = await transcribe(
      model,
      transcription.body,
      AbortSignal.any([abort.signal, AbortSignal.timeout(config.requestTimeoutMs)]),
    );
    if (result.error) sendJson(response, result.status, { error: result.error });
    else if (transcription.format === 'text') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(result.text);
    } else sendJson(response, 200, { text: result.text });
    return;
  }
  const multipart = request.headers['content-type']?.startsWith('multipart/form-data');
  const body = multipart
    ? { model: (await readForm(bytes, request.headers['content-type'] || '')).get('model') }
    : readJson(bytes);
  const role = path === '/v1/systemone' ? 'decision' : 'omni';
  const model = selectModel(models, body.model, role);
  if (!model) {
    sendError(response, 404, 'Unknown model for this endpoint.');
    return;
  }
  if (!(await acquireModel(runtimes, model.id, response, config.requestTimeoutMs))) return;
  if (path === '/v1/context') {
    await runtimeContext(model, response, config.requestTimeoutMs);
    return;
  }
  if (path === '/v1/tokenize' || path === '/v1/apply-template') {
    proxy(request, response, model, path.replace('/v1', ''), bytes, config.requestTimeoutMs);
    return;
  }
  if (path === '/v1/audio/speech') {
    proxy(
      request,
      response,
      model,
      '/tts',
      Buffer.from(JSON.stringify(speechRequest(body))),
      config.requestTimeoutMs,
      'application/json',
      body.response_format === 'pcm',
    );
    return;
  }
  proxy(request, response, model, path, bytes, config.requestTimeoutMs);
};
