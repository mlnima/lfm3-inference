import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const inspectFile = async (path) => {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const errors = lines.flatMap((line, index) =>
    line.length > 100 ? [`${path}:${index + 1}: ${line.length} columns`] : [],
  );
  return lines.length > 300 ? [...errors, `${path}: ${lines.length} lines`] : errors;
};

const inspect = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return inspect(path);
      if (!/\.(ts|mjs)$/.test(path)) return [];
      return inspectFile(path);
    }),
  );
  return results.flat();
};

const rootSources = (await readdir('.')).filter((path) => /\.(ts|mjs)$/.test(path));
const errors = (
  await Promise.all([
    ...['src', 'scripts', 'tests'].map((directory) => inspect(directory)),
    ...rootSources.map((path) => inspectFile(path)),
  ])
).flat();
errors.forEach((error) => console.error(error));
process.exitCode = errors.length ? 1 : 0;
