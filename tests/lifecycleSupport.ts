import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ModelConfig } from '../src/config/types.js';

export const project = fileURLToPath(new URL('../', import.meta.url));
export const directory = resolve(project, 'artifacts/lifecycle');
export const proxyPort = 19080;
export const backendPort = 19081;
export const decisionPort = 19082;
const command = promisify(execFile);

export const runtimePids = async (): Promise<Set<number>> => {
  if (process.platform === 'win32') {
    const { stdout } = await command('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
    return new Set(
      [...stdout.matchAll(/^"llama(?:-server)?\.exe","(\d+)"/gim)].map((match) => Number(match[1])),
    );
  }
  const { stdout } = await command('ps', ['-A', '-o', 'pid=,comm=']);
  return new Set(
    stdout
      .split('\n')
      .filter((line) => /\s(?:.*\/)?llama(?:-server)?$/.test(line.trim()))
      .map((line) => Number(line.trim().split(/\s+/)[0])),
  );
};

export const waitFor = async (check: () => Promise<boolean>, timeout = 30000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Lifecycle condition did not complete before its timeout.');
};

export const listening = async (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then(
    async (response) => {
      await response.text();
      return response.ok;
    },
    () => false,
  );

type LaunchOptions = {
  invalidModel?: boolean;
  invalidExecutable?: boolean;
  development?: boolean;
  idleTimeoutMs?: number;
  device?: 'gpu' | 'cpu';
  role?: ModelConfig['role'];
  bothModels?: boolean;
  args?: string[];
};

const bootstrap = (development: boolean): string => `
import { setTimeout as delay } from 'node:timers/promises';
const stop = async () => {
  while (!process.listenerCount('SIGTERM')) await delay(10);
  process.emit('SIGTERM');
  process.connected && process.disconnect();
};
process.on('message', (message) => message === 'stop' && void stop());
await import('../../${development ? 'src/main.ts' : 'dist/main.js'}');
process.exitCode && process.connected && process.disconnect();
`;

export const launch = async (context: TestContext, options: LaunchOptions = {}) => {
  await mkdir(directory, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(project, 'models.example.json'), 'utf8')) as {
    models: ModelConfig[];
  };
  const role = options.role || 'omni';
  const selected = options.bothModels
    ? manifest.models
    : manifest.models.filter((model) => model.role === role);
  assert.ok(selected.length > 0);
  const models = selected.map((model) => ({
    ...model,
    port: model.role === 'decision' ? decisionPort : backendPort,
    modelPath: options.invalidModel ? 'missing-model.gguf' : model.modelPath,
    args: [...(model.args || []), ...(options.args || [])],
  }));
  const path = resolve(directory, 'models.json');
  await writeFile(path, JSON.stringify({ models }));
  const baseline = await runtimePids();
  const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const bootstrapPath = resolve(directory, 'bootstrap.mjs');
  await writeFile(bootstrapPath, bootstrap(Boolean(options.development)));
  const child = spawn(
    process.execPath,
    [...(options.development ? ['--import', 'tsx'] : []), bootstrapPath],
    {
      cwd: project,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(proxyPort),
        API_KEY: 'change.me',
        MODELS_CONFIG: path,
        DEVICE: options.device || 'gpu',
        IDLE_TIMEOUT_MS: String(options.idleTimeoutMs ?? 0),
        LLAMA_SERVER_BIN: resolve(
          project,
          options.invalidExecutable ? 'missing-runtime' : `vendor/llama/${executable}`,
        ),
        STARTUP_TIMEOUT_MS: '90000',
        SHUTDOWN_TIMEOUT_MS: '2000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  let output = '';
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-5000000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  context.after(async () => {
    child.exitCode === null && child.signalCode === null && child.kill('SIGKILL');
    await waitFor(
      async () =>
        !(await listening(proxyPort)) &&
        !(await listening(backendPort)) &&
        !(await listening(decisionPort)),
    );
    await waitFor(async () => [...(await runtimePids())].every((pid) => baseline.has(pid)));
  });
  await waitFor(async () => listening(proxyPort));
  return { child, output: () => output, baseline, models };
};

export const infer = async (
  model = 'lfm3-omni-2b',
  extra: Record<string, unknown> = {},
): Promise<Response> => {
  const decision = model === 'd1-omni-2b';
  const path = decision ? '/v1/systemone' : '/v1/chat/completions';
  return fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer change.me', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      ...(decision
        ? {
            state: 'I was charged twice. Please refund the duplicate charge.',
            questions: {
              route: {
                type: 'choice',
                instructions: 'Which team should handle this?',
                criteria: { billing: 'Charges and refunds', technical: 'Software faults' },
              },
            },
          }
        : {
            messages: [{ role: 'user', content: 'What is 2 + 2? Reply with only the number.' }],
            temperature: 0,
            max_tokens: 16,
          }),
      ...extra,
    }),
    signal: AbortSignal.timeout(180000),
  });
};

export const answer = async (response: Response): Promise<void> => {
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as { choices: { message: { content: string } }[] };
  assert.match(result.choices[0].message.content, /^4\s*$/);
};

export const exited = async (child: ChildProcess, output: () => string): Promise<void> => {
  try {
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 90000);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${output()}`);
  }
};
