import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { artifacts, fixtures, runFfmpeg } from './fixtures.ts';
import { protocolSession } from './liveProtocolSocket.ts';
import {
  anthropicText,
  chat,
  chatText,
  evidence,
  json,
  omni,
  request,
  timeout,
} from './liveSupport.ts';

before(
  async () => {
    await fixtures();
  },
  { timeout },
);

const parameters = {
  type: 'object',
  properties: { a: { type: 'integer' }, b: { type: 'integer' } },
  required: ['a', 'b'],
};
const question = { role: 'user', content: 'Use add_numbers for 2 + 3, then answer with the sum.' };

test('OpenAI Completions generates a usable text continuation', { timeout }, async () => {
  const response = await request('/v1/completions', {
    model: omni,
    prompt: `<|startoftext|><|im_start|>user
What is the capital of France? Reply with the city name only.<|im_end|>
<|im_start|>assistant
<think></think>`,
    temperature: 0,
    max_tokens: 24,
  });
  const result = (await response.json()) as { choices: { text: string }[] };
  assert.match(result.choices[0].text, /Paris/);
  await evidence('openai-completions', result);
});

test('Anthropic token counting counts text and image content', { timeout }, async () => {
  const image = (await readFile((await fixtures()).image)).toString('base64');
  const count = async (content: unknown) => {
    const response = await request('/v1/messages/count_tokens', {
      model: omni,
      messages: [{ role: 'user', content }],
    });
    const result = (await response.json()) as { input_tokens: number };
    assert.ok(Number.isInteger(result.input_tokens) && result.input_tokens > 0);
    return result.input_tokens;
  };
  const text = await count('What color is the square?');
  const picture = await count([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
    { type: 'text', text: 'What color is the square?' },
  ]);
  assert.ok(picture > text, 'Image input must contribute visual tokens');
  await evidence('anthropic-token-count', { text, picture });
});

test(
  'OpenAI tool calls accept tool results and generate the final answer',
  { timeout },
  async () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'add_numbers', description: 'Add two integers.', parameters },
      },
    ];
    const first = await chat([question], {
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
      [question, assistant, { role: 'tool', tool_call_id: call.id, content: '5' }],
      { tools, tool_choice: 'none' },
    );
    assert.match(chatText(final), /\b5\b|\bfive\b/i);
    assert.equal(final.choices?.[0]?.message.tool_calls?.length || 0, 0);
    await evidence('openai-tool-roundtrip', { first, final });
  },
);

test(
  'Anthropic tool use accepts tool results and generates the final answer',
  { timeout },
  async () => {
    const tools = [
      { name: 'add_numbers', description: 'Add two integers.', input_schema: parameters },
    ];
    const first = await json('/v1/messages', {
      model: omni,
      max_tokens: 128,
      temperature: 0,
      messages: [question],
      tools,
      tool_choice: { type: 'tool', name: 'add_numbers' },
    });
    const call = first.content?.find((part) => part.type === 'tool_use') as
      | {
          id: string;
          name: string;
          input: unknown;
        }
      | undefined;
    assert.equal(call?.name, 'add_numbers');
    assert.ok(call?.id);
    assert.deepEqual(call.input, { a: 2, b: 3 });
    const final = await json('/v1/messages', {
      model: omni,
      max_tokens: 128,
      temperature: 0,
      messages: [
        question,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: call.id, content: '5' }],
        },
      ],
      tools,
      tool_choice: { type: 'none' },
    });
    assert.match(anthropicText(final), /\b5\b|\bfive\b/i);
    assert.equal(final.content?.filter((part) => part.type === 'tool_use').length || 0, 0);
    await evidence('anthropic-tool-roundtrip', { first, final });
  },
);

test('realtime transcription session recognizes the recorded JFK speech', { timeout }, async () => {
  const pcmPath = join(artifacts, 'jfk-realtime.pcm');
  await runFfmpeg([
    '-i',
    (await fixtures()).audio,
    '-f',
    's16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    pcmPath,
  ]);
  const pcm = await readFile(pcmPath);
  let transcript = '';
  const received = await protocolSession('', (event, send) => {
    if (event.type === 'session.created') {
      assert.equal(event.session?.type, 'realtime');
      assert.equal(event.session?.audio?.input?.format?.rate, 16_000);
      send({
        type: 'session.update',
        session: { type: 'transcription', audio: { input: { transcription: { language: 'en' } } } },
      });
    }
    if (event.type === 'session.updated') {
      assert.equal(event.session?.type, 'transcription');
      for (let offset = 0; offset < pcm.length; offset += 16_000) {
        send({
          type: 'input_audio_buffer.append',
          audio: pcm.subarray(offset, offset + 16_000).toString('base64'),
        });
      }
      send({ type: 'input_audio_buffer.commit' });
    }
    if (event.type !== 'conversation.item.input_audio_transcription.completed') return false;
    transcript = event.transcript || '';
    return true;
  });
  assert.match(transcript, /ask/i);
  assert.match(transcript, /country/i);
  assert.ok(received.some((event) => event.type === 'input_audio_buffer.committed'));
  await evidence('realtime-transcription', { transcript, events: received });
});

test('realtime conversation retains context across two text turns', { timeout }, async () => {
  const replies: string[] = [];
  let text = '';
  const received = await protocolSession('', (event, send) => {
    const user = (content: string) => {
      send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] },
      });
      send({ type: 'response.create' });
    };
    if (event.type === 'session.created') {
      send({
        type: 'session.update',
        session: { output_modalities: ['text'], max_output_tokens: 128 },
      });
    }
    if (event.type === 'session.updated') user('Remember the code 4627. Reply OK.');
    if (event.type === 'response.output_text.delta') text += event.delta || '';
    assert.notEqual(
      event.type,
      'response.output_audio.delta',
      'Text-only mode must not emit audio',
    );
    if (event.type !== 'response.done') return false;
    assert.notEqual(event.response?.status, 'failed', JSON.stringify(event.response));
    replies.push(text);
    text = '';
    if (replies.length === 2) return true;
    user('What code did I ask you to remember? Reply with the digits only.');
    return false;
  });
  assert.equal(replies.length, 2);
  assert.match(replies[1], /4627/);
  await evidence('realtime-multiturn', { replies, events: received });
});
