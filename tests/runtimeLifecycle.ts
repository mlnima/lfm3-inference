import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ModelConfig } from '../src/config/types.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(project, 'artifacts/lifecycle');
const proxyPort = 19080;
const backendPort = 19081;
const command = promisify(execFile);

const runtimePids = async (): Promise<Set<number>> => {
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

const waitFor = async (check: () => Promise<boolean>, timeout = 30000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Lifecycle condition did not complete before its timeout.');
};

const listening = async (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(500),
    headers: { authorization: 'Bearer change.me' },
  }).then(
    async (response) => {
      await response.text();
      return true;
    },
    () => false,
  );

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

const launch = async (
  context: TestContext,
  invalidModel = false,
  invalidExecutable = false,
  development = false,
): Promise<{ child: ChildProcess; output: () => string; baseline: Set<number> }> => {
  await mkdir(directory, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(project, 'models.example.json'), 'utf8')) as {
    models: ModelConfig[];
  };
  const model = manifest.models.find((item) => item.role === 'omni');
  assert.ok(model);
  const path = resolve(directory, 'models.json');
  await writeFile(
    path,
    JSON.stringify({
      models: [
        {
          ...model,
          port: backendPort,
          modelPath: invalidModel ? 'missing-model.gguf' : model.modelPath,
        },
      ],
    }),
  );
  const baseline = await runtimePids();
  const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const bootstrapPath = resolve(directory, 'bootstrap.mjs');
  await writeFile(bootstrapPath, bootstrap(development));
  const child = spawn(
    process.execPath,
    [...(development ? ['--import', 'tsx'] : []), bootstrapPath],
    {
      cwd: project,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(proxyPort),
        API_KEY: 'change.me',
        MODELS_CONFIG: path,
        LLAMA_SERVER_BIN: resolve(
          project,
          invalidExecutable ? 'missing-runtime' : `vendor/llama/${executable}`,
        ),
        STARTUP_TIMEOUT_MS: '60000',
        SHUTDOWN_TIMEOUT_MS: '2000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  let output = '';
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-12000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  context.after(async () => {
    child.exitCode === null && child.signalCode === null && child.kill('SIGKILL');
    await waitFor(async () => !(await listening(proxyPort)) && !(await listening(backendPort)));
    await waitFor(async () => [...(await runtimePids())].every((pid) => baseline.has(pid)));
  });
  return { child, output: () => output, baseline };
};

const exited = async (child: ChildProcess, output: () => string): Promise<void> => {
  try {
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 90000);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${output()}`);
  }
};

test(
  'production SIGTERM handler stops native runtime and supervisor',
  { timeout: 120000 },
  async (t) => {
    const { child, output } = await launch(t);
    await waitFor(
      async () => (await listening(proxyPort)) && (await listening(backendPort)),
      90000,
    );
    child.send('stop');
    await exited(child, output);
    assert.equal(child.exitCode, 0, output());
  },
);

test(
  'forced gateway termination stops the orphaned native process tree',
  { timeout: 120000 },
  async (t) => {
    const { child, output } = await launch(t);
    await waitFor(
      async () => (await listening(proxyPort)) && (await listening(backendPort)),
      90000,
    );
    child.kill('SIGKILL');
    await exited(child, output);
  },
);

test('startup abort stops supervised children before readiness', { timeout: 120000 }, async (t) => {
  const { child, output } = await launch(t);
  child.send('stop');
  await exited(child, output);
  assert.equal(child.exitCode, 0, output());
});

test('missing model startup failure leaves no native process', { timeout: 120000 }, async (t) => {
  const { child, output } = await launch(t, true);
  await exited(child, output);
  assert.equal(child.exitCode, 1, output());
});

test('missing executable startup failure leaves no supervisor', { timeout: 120000 }, async (t) => {
  const { child, output } = await launch(t, false, true);
  await exited(child, output);
  assert.equal(child.exitCode, 1, output());
});

test('development source performs inference and stops cleanly', { timeout: 120000 }, async (t) => {
  const { child, output } = await launch(t, false, false, true);
  await waitFor(async () => (await listening(proxyPort)) && (await listening(backendPort)), 90000);
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer change.me', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'lfm3-omni-2b',
      messages: [{ role: 'user', content: 'What is 2 + 2? Reply with only the number.' }],
      temperature: 0,
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  await writeFile(resolve(directory, 'development-response.json'), JSON.stringify(result, null, 2));
  assert.match(result.choices[0].message.content, /^4\s*$/);
  child.send('stop');
  await exited(child, output);
  assert.equal(child.exitCode, 0, output());
});
