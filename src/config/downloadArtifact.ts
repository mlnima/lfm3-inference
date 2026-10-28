import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import type { ModelDownload } from './types.js';

const checksum = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

export const downloadArtifact = async (artifact: ModelDownload): Promise<void> => {
  const exists = await access(artifact.path).then(
    () => true,
    () => false,
  );
  if (exists && (await checksum(artifact.path)) === artifact.sha256) {
    console.info(`Verified ${artifact.path}`);
    return;
  }

  await mkdir(dirname(artifact.path), { recursive: true });
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(1800000) });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${artifact.url}`);
  }
  const partial = `${artifact.path}.part`;
  try {
    console.info(`Downloading ${artifact.path}`);
    await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(partial));
    if ((await checksum(partial)) !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch: ${artifact.path}`);
    }
    await rename(partial, artifact.path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
};
