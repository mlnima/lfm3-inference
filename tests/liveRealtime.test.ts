import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import WebSocket from 'ws';
import { artifacts, fixtures, runFfmpeg } from './fixtures.ts';
import { synthesize, transcribe, verifyAudio } from './liveAudioSupport.ts';
import { apiKey, baseUrl, evidence, omni, timeout } from './liveSupport.ts';

type RealtimeEvent = {
  type: string;
  delta?: string;
  session?: {
    audio?: { input?: { format?: { rate?: number } }; output?: { format?: { rate?: number } } };
  };
  error?: { message?: string };
  response?: { status?: string; status_details?: unknown };
};

before(
  async () => {
    await fixtures();
  },
  { timeout },
);

const conversation = async (audioInput?: Buffer) => {
  const url = new URL('/v1/realtime', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('model', omni);
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
    handshakeTimeout: 30_000,
  });
  const audio: Buffer[] = [];
  const received: RealtimeEvent[] = [];
  let outputRate = 0;
  let text = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime response timed out')), timeout);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const send = (event: unknown) => ws.send(JSON.stringify(event));
      ws.on('error', finish);
      ws.on('close', () => finish(new Error('Realtime closed before response.done')));
      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          received.push(
            event.type === 'response.output_audio.delta'
              ? { type: event.type, delta: `${event.delta?.length || 0} base64 characters` }
              : event,
          );
          if (event.type === 'error') throw new Error(event.error?.message || 'Realtime error');
          if (event.type === 'session.created') {
            outputRate = event.session?.audio?.output?.format?.rate || 0;
            assert.equal(event.session?.audio?.input?.format?.rate, 16_000);
            assert.equal(outputRate, 24_000);
            send({
              type: 'session.update',
              session: {
                type: 'realtime',
                output_modalities: ['text', 'audio'],
                max_output_tokens: 256,
                instructions: 'Answer briefly. Speak the answer in English.',
              },
            });
          }
          if (event.type === 'session.updated') {
            if (audioInput) {
              for (let offset = 0; offset < audioInput.length; offset += 16_000) {
                send({
                  type: 'input_audio_buffer.append',
                  audio: audioInput.subarray(offset, offset + 16_000).toString('base64'),
                });
              }
              send({ type: 'input_audio_buffer.commit' });
            } else {
              send({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'What is two plus two?' }],
                },
              });
            }
            send({ type: 'response.create' });
          }
          if (event.type === 'response.output_text.delta') text += event.delta || '';
          if (event.type === 'response.output_audio.delta') {
            audio.push(Buffer.from(event.delta || '', 'base64'));
          }
          if (event.type === 'response.done') {
            assert.notEqual(event.response?.status, 'failed', JSON.stringify(event.response));
            finish();
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } finally {
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 3_000);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close();
    });
  }
  assert.ok(audio.length > 0, 'Realtime response must produce audio deltas');
  const pcm = Buffer.concat(audio);
  assert.ok(pcm.length > outputRate * 2 * 0.2, 'Realtime audio must exceed 200 ms');
  assert.equal(pcm.length % 2, 0, 'Realtime samples must be PCM16');
  return { pcm, text, outputRate, received };
};

const saveResponse = async (name: string, result: Awaited<ReturnType<typeof conversation>>) => {
  const pcmPath = join(artifacts, `${name}.pcm`);
  const wavePath = join(artifacts, `${name}.wav`);
  await writeFile(pcmPath, result.pcm);
  await runFfmpeg([
    '-f',
    's16le',
    '-ar',
    String(result.outputRate),
    '-ac',
    '1',
    '-i',
    pcmPath,
    wavePath,
  ]);
  const decoded = await verifyAudio(wavePath);
  const transcript = await transcribe(wavePath);
  assert.match(transcript, /four|4/i);
  assert.match(result.text, /four|4/i);
  await evidence(name, { decoded, transcript, text: result.text, events: result.received });
};

test('realtime interleaves text and audible speech from a text question', { timeout }, async () => {
  await saveResponse('realtime-text', await conversation());
});

test(
  'realtime understands PCM16 audio input and answers in text and speech',
  { timeout },
  async () => {
    const question = await synthesize(
      'realtime-question',
      'What is two plus two? Answer in one short sentence.',
    );
    const inputPath = join(artifacts, 'realtime-input.pcm');
    await runFfmpeg(['-i', question.path, '-f', 's16le', '-ar', '16000', '-ac', '1', inputPath]);
    const result = await conversation(await readFile(inputPath));
    assert.ok(result.received.some((event) => event.type === 'input_audio_buffer.committed'));
    await saveResponse('realtime-audio', result);
  },
);
