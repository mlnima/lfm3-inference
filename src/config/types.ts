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
  gpuLayers: string;
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
  gpuLayers: string;
  shutdownTimeoutMs: number;
};

export type RuntimeAsset = {
  name: string;
  sha256: string;
};
