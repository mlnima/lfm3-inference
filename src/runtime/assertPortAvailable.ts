import { createServer } from 'node:net';

export const assertPortAvailable = async (port: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
};
