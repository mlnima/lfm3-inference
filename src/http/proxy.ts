import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { RunningModel } from '../config/types.js';
import { floatPcmToInt16 } from './pcm.js';

export const proxy = (
  request: IncomingMessage,
  response: ServerResponse,
  model: RunningModel,
  path: string,
  body: Buffer,
  timeout: number,
  contentType = request.headers['content-type'],
  pcm16 = false,
): void => {
  const headers = { ...request.headers };
  for (const name of ['host', 'authorization', 'x-api-key', 'connection', 'transfer-encoding']) {
    delete headers[name];
  }
  headers['content-length'] = String(body.length);
  contentType && (headers['content-type'] = contentType);
  const upstream = httpRequest(
    new URL(path, model.origin),
    { method: request.method, headers },
    (result) => {
      const outgoing = { ...result.headers };
      delete outgoing.connection;
      delete outgoing['access-control-allow-origin'];
      const convert = pcm16 && outgoing['content-type']?.startsWith('audio/pcm');
      if (convert) {
        outgoing['content-type'] = 'audio/pcm;rate=24000;encoding=signed-integer;bits=16';
        delete outgoing['content-length'];
      }
      response.writeHead(result.statusCode || 502, outgoing);
      result.on('error', () => response.destroy());
      if (convert) {
        const transform = floatPcmToInt16();
        transform.on('error', () => response.destroy());
        result.pipe(transform).pipe(response);
      } else result.pipe(response);
    },
  );
  const timer = setTimeout(
    () => upstream.destroy(new Error('Inference request timed out.')),
    timeout,
  );
  timer.unref();
  response.once('close', () => {
    clearTimeout(timer);
    upstream.destroy();
  });
  upstream.on('error', (error) => {
    clearTimeout(timer);
    response.headersSent
      ? response.destroy(error)
      : response
          .writeHead(502, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: error.message, type: 'api_error' } }));
  });
  upstream.end(body);
};
