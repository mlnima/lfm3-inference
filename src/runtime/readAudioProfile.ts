import { open } from 'node:fs/promises';

export const readAudioProfile = async (path?: string) => {
  if (!path) return undefined;
  const file = await open(path, 'r');
  let position = 0;
  const read = async (length: number): Promise<Buffer> => {
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, position);
    if (result.bytesRead !== length) throw new Error('Incomplete GGUF metadata.');
    position += length;
    return buffer;
  };
  const integer = async (): Promise<number> => (await read(4)).readUInt32LE();
  const length = async (): Promise<number> => {
    const value = (await read(8)).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF length is too large.');
    return Number(value);
  };
  const string = async (): Promise<string> => {
    const size = await length();
    if (size > 1048576) throw new Error('GGUF metadata string is too large.');
    return (await read(size)).toString('utf8');
  };
  const skip = async (type: number): Promise<void> => {
    if (type === 8) {
      const size = await length();
      position += size;
      return;
    }
    if (type === 9) {
      const element = await integer();
      const count = await length();
      if (count > 1000000) throw new Error('GGUF metadata array is too large.');
      for (let index = 0; index < count; index++) await skip(element);
      return;
    }
    const sizes = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
    if (!sizes[type]) throw new Error('Unsupported GGUF metadata value.');
    position += sizes[type];
  };
  try {
    if ((await read(4)).toString() !== 'GGUF') return undefined;
    if ((await integer()) !== 3) return undefined;
    await length();
    const count = await length();
    if (count > 1000000) throw new Error('GGUF metadata count is too large.');
    for (let index = 0; index < count; index++) {
      const key = await string();
      const type = await integer();
      if (key === 'clip.audio.projector_type' && type === 8) {
        const encoder = await string();
        return encoder === 'lfm3a'
          ? { audioInputSampleRate: 16000, audioInputSamplesPerToken: 1280 }
          : undefined;
      }
      await skip(type);
    }
    return undefined;
  } finally {
    await file.close();
  }
};
