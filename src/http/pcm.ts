import { Transform } from 'node:stream';

export const floatPcmToInt16 = (): Transform => {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      const input = Buffer.concat([pending, chunk]);
      const frames = Math.floor(input.length / 4);
      const output = Buffer.alloc(frames * 2);
      for (let index = 0; index < frames; index++) {
        const sample = Math.max(-1, Math.min(1, input.readFloatLE(index * 4)));
        output.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), index * 2);
      }
      pending = input.subarray(frames * 4);
      callback(null, output);
    },
    flush: (callback) => {
      callback(pending.length ? new Error('Incomplete float32 audio sample.') : null);
    },
  });
};
