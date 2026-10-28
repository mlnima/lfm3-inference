import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RunningModel, ServerConfig } from '../config/types.js';
import { authorized } from '../routes/handleRequest.js';
import { selectModel } from './selectModel.js';

export const upgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: ServerConfig,
  models: RunningModel[],
): void => {
  socket.on('error', () => socket.destroy());
  let url: URL;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const model = selectModel(models, url.searchParams.get('model'), 'omni');
  const status = !authorized(request, config.apiKey)
    ? '401 Unauthorized'
    : url.pathname !== '/v1/realtime' || !model
      ? '404 Not Found'
      : '';
  if (status) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.authorization;
  delete headers['x-api-key'];
  const upstream = httpRequest(new URL(request.url || '/', model!.origin), { headers });
  const timer = setTimeout(() => {
    upstream.destroy();
    socket.destroy();
  }, config.requestTimeoutMs);
  timer.unref();
  upstream.once('upgrade', (response, remote, remoteHead) => {
    clearTimeout(timer);
    const responseHeaders = response.rawHeaders.reduce(
      (result, value, index, values) =>
        index % 2 === 0 ? `${result}${value}: ${values[index + 1]}\r\n` : result,
      '',
    );
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders}\r\n`);
    remoteHead.length && socket.write(remoteHead);
    head.length && remote.write(head);
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.once('close', () => remote.destroy());
    remote.once('close', () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  upstream.once('response', (response) => {
    response.resume();
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  upstream.on('error', () => socket.destroy());
  socket.once('close', () => {
    clearTimeout(timer);
    upstream.destroy();
  });
  upstream.end();
};
