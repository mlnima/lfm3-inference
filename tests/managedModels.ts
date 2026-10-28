import type { RunningModel, RuntimeManager } from '../src/config/types.js';

export const managedModels = (models: RunningModel[]): RuntimeManager => ({
  models,
  acquire: async () => () => undefined,
  stop: async () => undefined,
});
