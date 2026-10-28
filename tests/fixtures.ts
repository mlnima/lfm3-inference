import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const artifacts = resolve('artifacts/live');
const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const videoSource =
  'https://huggingface.co/datasets/raushan-testing-hf/videos-test/resolve/' +
  '4cba700bd771f44d72b549253da025c32e944d42/sample_demo_1.mp4';
const audioSource = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav';

const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const download = async (url: string, name: string) => {
  const path = join(artifacts, name);
  if (await exists(path)) return path;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Fixture download failed: ${response.status} ${url}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
};

export const runFfmpeg = async (args: string[]) => {
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    timeout: 120_000,
    windowsHide: true,
  });
};

export const probeAudio = async (path: string) => {
  const { stdout } = await execute(
    ffprobe,
    ['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', path],
    { timeout: 30_000, windowsHide: true },
  );
  return JSON.parse(stdout) as {
    streams: { sample_rate: string; channels: number; duration?: string }[];
  };
};

export const toDataUrl = async (path: string, mime: string) =>
  `data:${mime};base64,${(await readFile(path)).toString('base64')}`;

const prepare = async () => {
  await mkdir(artifacts, { recursive: true });
  const audio = await download(audioSource, 'jfk.wav');
  const source = await download(videoSource, 'reading-source.mp4');
  const image = join(artifacts, 'red-square.png');
  const video = join(artifacts, 'reading.mp4');
  const silentVideo = join(artifacts, 'reading-silent.mp4');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=256x256',
    '-vf',
    'drawbox=x=48:y=48:w=160:h=160:color=red:t=fill',
    '-frames:v',
    '1',
    image,
  ]);
  await runFfmpeg([
    '-i',
    source,
    '-t',
    '4',
    '-vf',
    'scale=384:-2',
    '-r',
    '2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    video,
  ]);
  await runFfmpeg(['-i', video, '-an', '-c:v', 'copy', silentVideo]);
  const streams = await probeAudio(video);
  if (streams.streams.length !== 1) throw new Error('Reading fixture has no soundtrack');
  await writeFile(
    join(artifacts, 'sources.json'),
    JSON.stringify({ audioSource, videoSource, videoClipSeconds: 4 }, null, 2),
  );
  return { audio, image, video, silentVideo };
};

let prepared: ReturnType<typeof prepare> | undefined;
export const fixtures = () => (prepared ||= prepare());
