import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { artifacts, fixtures, runFfmpeg, toDataUrl } from './fixtures.ts';
import { synthesize, transcribe, verifyAudio } from './liveAudioSupport.ts';
import { protocolSession } from './liveProtocolSocket.ts';
import { chat, chatText, evidence, timeout } from './liveSupport.ts';

before(
  async () => {
    await fixtures();
  },
  { timeout },
);

test('Omni answers a spoken question about an image', { timeout }, async () => {
  const question = await synthesize('visual-question', 'What color is the square?');
  const image = await toDataUrl((await fixtures()).image, 'image/png');
  const reply = await chat([
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: image } },
        {
          type: 'input_audio',
          input_audio: { data: question.audio.toString('base64'), format: 'wav' },
        },
      ],
    },
  ]);
  assert.match(chatText(reply), /\bred\b/i);
  await evidence('spoken-visual-question', reply);
});

test('Omni makes a tool call from speech and uses the result', { timeout }, async () => {
  const question = await synthesize(
    'spoken-tool-question',
    'Add two and three using the add_numbers tool. Then tell me the result.',
  );
  const user = {
    role: 'user',
    content: [
      {
        type: 'input_audio',
        input_audio: { data: question.audio.toString('base64'), format: 'wav' },
      },
    ],
  };
  const tools = [
    {
      type: 'function',
      function: {
        name: 'add_numbers',
        description: 'Add two integers.',
        parameters: {
          type: 'object',
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
          required: ['a', 'b'],
        },
      },
    },
  ];
  const first = await chat([user], {
    tools,
    tool_choice: { type: 'function', function: { name: 'add_numbers' } },
  });
  const assistant = first.choices?.[0]?.message;
  const call = assistant?.tool_calls?.[0] as
    | {
        id: string;
        function: { name: string; arguments: string };
      }
    | undefined;
  assert.equal(call?.function.name, 'add_numbers');
  assert.ok(call?.id);
  assert.deepEqual(JSON.parse(call.function.arguments), { a: 2, b: 3 });
  const final = await chat(
    [user, assistant, { role: 'tool', tool_call_id: call.id, content: '5' }],
    { tools, tool_choice: 'none' },
  );
  assert.match(chatText(final), /\b5\b|\bfive\b/i);
  await evidence('spoken-tool-roundtrip', { first, final });
});

test('Omni translates spoken English into German text and speech', { timeout }, async () => {
  const spoken = await synthesize(
    'translation-source',
    'Good morning. The geometric square is red.',
  );
  const input = join(artifacts, 'translation-input.pcm');
  await runFfmpeg(['-i', spoken.path, '-f', 's16le', '-ar', '16000', '-ac', '1', input]);
  const pcm = await readFile(input);
  const chunks: Buffer[] = [];
  let text = '';
  const received = await protocolSession('', (event, send) => {
    if (event.type === 'session.created') {
      send({
        type: 'session.update',
        session: {
          instructions:
            'Please translate the following spoken English into German text. ' +
            'Respond with interleaved text and audio.',
          output_modalities: ['text', 'audio'],
          max_output_tokens: 256,
        },
      });
    }
    if (event.type === 'session.updated') {
      for (let offset = 0; offset < pcm.length; offset += 16_000) {
        send({
          type: 'input_audio_buffer.append',
          audio: pcm.subarray(offset, offset + 16_000).toString('base64'),
        });
      }
      send({ type: 'input_audio_buffer.commit' });
      send({ type: 'response.create' });
    }
    if (event.type === 'response.output_audio.delta') {
      chunks.push(Buffer.from(event.delta || '', 'base64'));
    }
    if (event.type === 'response.output_text.delta') text += event.delta || '';
    if (event.type !== 'response.done') return false;
    assert.notEqual(event.response?.status, 'failed', JSON.stringify(event.response));
    return true;
  });
  assert.ok(chunks.length > 0, 'Speech translation must produce audio deltas');
  const output = join(artifacts, 'translated-german.pcm');
  const wave = join(artifacts, 'translated-german.wav');
  await writeFile(output, Buffer.concat(chunks));
  await runFfmpeg(['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', output, wave]);
  const decoded = await verifyAudio(wave);
  const transcript = await transcribe(wave, 'de');
  assert.match(text, /Guten\s+Morgen/i);
  assert.match(text, /Quadrat/i);
  assert.match(text, /rot/i);
  assert.match(transcript, /Guten\s+Morgen/i);
  assert.match(transcript, /Quadrat/i);
  assert.match(transcript, /rot/i);
  await evidence('speech-translation', {
    decoded,
    text,
    transcript,
    events: received.map((event) => event.type),
  });
});
