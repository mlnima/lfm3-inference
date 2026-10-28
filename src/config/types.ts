export type ModelDownload = {
  path: string;
  url: string;
  sha256: string;
};

export type ModelConfig = {
  id: string;
  role: 'omni' | 'decision';
  modelPath: string;
  projectorPath?: string;
  port: number;
  args?: string[];
  downloads?: ModelDownload[];
};

export type ServerConfig = {
  host: string;
  port: number;
  apiKey?: string;
  llamaServerBin: string;
  device: 'gpu' | 'cpu';
  gpuLayers: string;
  idleTimeoutMs: number;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  models: ModelConfig[];
};

export type RunningModel = ModelConfig & { origin: string };

export type WorkerConfig = {
  executable: string;
  model: ModelConfig;
  device: ServerConfig['device'];
  gpuLayers: string;
  shutdownTimeoutMs: number;
};

export type RuntimeAsset = {
  name: string;
  sha256: string;
};

export type RuntimeProcess = {
  models: RunningModel[];
  stop: () => Promise<void>;
};

export type RuntimeLauncher = (
  config: ServerConfig,
  onFailure: (error: Error) => void,
  signal?: AbortSignal,
) => Promise<RuntimeProcess>;

export type RuntimeManager = {
  models: RunningModel[];
  acquire: (modelId: string, signal?: AbortSignal) => Promise<() => void>;
  stop: () => Promise<void>;
};

export type RuntimeEntry = {
  model: RunningModel;
  users: number;
  runtime?: RuntimeProcess;
  loading?: Promise<void>;
  controller?: AbortController;
  unloading?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};
