import type { RunningModel } from '../config/types.js';

export const selectModel = (
  models: RunningModel[],
  id: unknown,
  role: RunningModel['role'],
): RunningModel | undefined =>
  id
    ? models.find((model) => model.id === id && model.role === role)
    : models.find((model) => model.role === role);
