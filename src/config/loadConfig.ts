import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelConfig, ServerConfig } from './types.js';

export const loadConfig = async (): Promise<ServerConfig> => {
  existsSync('.env') && process.loadEnvFile('.env');
  const file = process.env.MODELS_CONFIG || 'models.json';
  const { models } = JSON.parse(await readFile(file, 'utf8')) as { models: ModelConfig[] };
  if (!models?.length) throw new Error(`${file} must contain at least one model.`);
  const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const device = process.env.DEVICE || 'gpu';
  const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS || 300000);
  if (device !== 'gpu' && device !== 'cpu') throw new Error('DEVICE must be gpu or cpu.');
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2147483647) {
    throw new Error('IDLE_TIMEOUT_MS must be an integer between 0 and 2147483647.');
  }

  return {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 18080),
    apiKey: process.env.API_KEY,
    llamaServerBin: resolve(process.env.LLAMA_SERVER_BIN || `vendor/llama/${executable}`),
    device,
    gpuLayers: process.env.GPU_LAYERS || 'all',
    idleTimeoutMs,
    startupTimeoutMs: Number(process.env.STARTUP_TIMEOUT_MS || 180000),
    shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 300000),
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 134217728),
    models: models.map((model) => ({
      ...model,
      modelPath: resolve(model.modelPath),
      projectorPath: model.projectorPath ? resolve(model.projectorPath) : undefined,
    })),
  };
};
