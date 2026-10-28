import { once } from 'node:events';
import { loadConfig } from './config/loadConfig.js';
import { createGateway } from './http/createGateway.js';
import { startRuntimes } from './runtime/startRuntimes.js';

const main = async (): Promise<void> => {
  const config = await loadConfig();
  const abort = new AbortController();
  let gateway: ReturnType<typeof createGateway> | undefined;
  let runtimes: Awaited<ReturnType<typeof startRuntimes>> | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = (code = 0): Promise<void> => {
    stopping ||= (async () => {
      abort.abort();
      process.exitCode = code;
      await gateway?.close();
      await runtimes?.stop();
    })();
    return stopping;
  };
  const fail = (error: Error): void => {
    console.error(error.message);
    void shutdown(1);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    runtimes = await startRuntimes(config, fail, abort.signal);
    if (stopping) {
      await runtimes.stop();
      return;
    }
    gateway = createGateway(config, runtimes.models);
    gateway.server.listen(config.port, config.host);
    await once(gateway.server, 'listening');
    console.log(`Inference listening on http://${config.host}:${config.port}`);
  } catch (error) {
    console.error((error as Error).message);
    await shutdown(1);
  }
};

await main();
