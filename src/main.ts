import { once } from 'node:events';
import { loadConfig } from './config/loadConfig.js';
import { createGateway } from './http/createGateway.js';
import { createRuntimeManager } from './runtime/createRuntimeManager.js';

const main = async (): Promise<void> => {
  const config = await loadConfig();
  let gateway: ReturnType<typeof createGateway> | undefined;
  let runtimes: ReturnType<typeof createRuntimeManager> | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = (code = 0): Promise<void> => {
    stopping ||= (async () => {
      process.exitCode = code;
      try {
        await gateway?.close();
        await runtimes?.stop();
      } finally {
        process.connected && process.disconnect?.();
      }
    })();
    return stopping;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.connected && process.once('disconnect', () => void shutdown());
  try {
    runtimes = createRuntimeManager(config);
    gateway = createGateway(config, runtimes);
    gateway.server.listen(config.port, config.host);
    await once(gateway.server, 'listening');
    console.log(`Inference listening on http://${config.host}:${config.port}`);
  } catch (error) {
    console.error((error as Error).message);
    await shutdown(1);
  }
};

await main();
