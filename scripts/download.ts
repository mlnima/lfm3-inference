import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import type { ModelConfig } from '../src/config/types.js';
import { downloadArtifact } from '../src/config/downloadArtifact.js';
import { installRuntime } from '../src/config/installRuntime.js';

const download = async (): Promise<void> => {
  existsSync('.env') && process.loadEnvFile('.env');
  const path = process.env.MODELS_CONFIG || 'models.json';
  !existsSync(path) && (await copyFile('models.example.json', path));
  const { models } = JSON.parse(await readFile(path, 'utf8')) as { models: ModelConfig[] };
  !process.argv.includes('--models-only') && (await installRuntime());
  for (const model of models) {
    for (const artifact of model.downloads || []) await downloadArtifact(artifact);
  }
};

await download();
