import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RuntimeManager, ServerConfig } from '../config/types.js';
import { handleRequest } from '../routes/handleRequest.js';
import { sendError } from './response.js';
import { upgrade } from './upgrade.js';

export const createGateway = (config: ServerConfig, runtimes: RuntimeManager) => {
  const connections = new Set<Duplex>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, runtimes).catch(
      (error: Error & { status?: number }) => {
        if (response.destroyed) return;
        response.headersSent
          ? response.destroy(error)
          : sendError(response, error.status || 400, error.message);
      },
    );
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    void upgrade(request, socket, head, config, runtimes).catch(() => {
      !socket.destroyed &&
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
    });
  });
  return {
    server,
    close: async (): Promise<void> => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      connections.forEach((socket) => socket.destroy());
      await closed;
    },
  };
};
