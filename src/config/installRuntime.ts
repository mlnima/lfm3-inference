import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { downloadArtifact } from './downloadArtifact.js';
import { runtimeAssets, runtimeVersion } from './runtimeAssets.js';

const extract = async (archive: string, directory: string): Promise<void> => {
  await new Promise<void>((done, reject) => {
    const child = spawn('tar', ['-xf', resolve(archive), '-C', directory], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      code === 0 ? done() : reject(new Error(`tar exited with ${code}`));
    });
  });
};

const copyFiles = async (directory: string, target: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await copyFiles(path, target);
      continue;
    }
    await cp(path, resolve(target, entry.name), { verbatimSymlinks: true });
  }
};

export const installRuntime = async (): Promise<void> => {
  const assets = runtimeAssets[`${process.platform}-${process.arch}`];
  if (!assets) throw new Error('Set LLAMA_SERVER_BIN for this platform and use --models-only.');
  const vendor = resolve('vendor');
  const target = resolve(vendor, 'llama');
  await mkdir(target, { recursive: true });
  for (const asset of assets) {
    const path = `vendor/downloads/${asset.name}`;
    const base = 'https://github.com/ggml-org/llama.cpp/releases/download';
    await downloadArtifact({ path, url: `${base}/${runtimeVersion}/${asset.name}`, ...asset });
    const temporary = await mkdtemp(resolve(vendor, 'install-'));
    try {
      await extract(path, temporary);
      await copyFiles(temporary, target);
    } finally {
      if (!temporary.startsWith(`${vendor}${sep}`)) throw new Error('Invalid staging directory.');
      await rm(temporary, { recursive: true, force: true });
    }
  }
};
