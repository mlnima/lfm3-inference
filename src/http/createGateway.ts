import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RunningModel, ServerConfig } from '../config/types.js';
import { handleRequest } from '../routes/handleRequest.js';
import { sendError } from './response.js';
import { upgrade } from './upgrade.js';

export const createGateway = (config: ServerConfig, models: RunningModel[]) => {
  const connections = new Set<Duplex>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, models).catch((error: Error) => {
      response.headersSent ? response.destroy(error) : sendError(response, 400, error.message);
    });
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => upgrade(request, socket, head, config, models));
  return {
    server,
    close: async (): Promise<void> => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      connections.forEach((socket) => socket.destroy());
      await closed;
    },
  };
};
