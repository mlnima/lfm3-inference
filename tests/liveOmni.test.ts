import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { fixtures, toDataUrl } from './fixtures.ts';
import {
  anthropicText,
  chat,
  chatText,
  events,
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

test('OpenAI chat and Responses answer a text question', { timeout }, async () => {
  const completion = await chat([{ role: 'user', content: 'What is 2 + 2? Answer one digit.' }]);
  assert.match(chatText(completion), /\b4\b/);
  const response = await json('/v1/responses', {
    model: omni,
    input: 'What is 2 + 2? Answer one digit.',
    temperature: 0,
    max_output_tokens: 32,
  });
  const text =
    response.output
      ?.flatMap((item) => item.content || [])
      .map((item) => item.text || '')
      .join('') || '';
  assert.match(text, /\b4\b/);
  await evidence('openai-text', { completion, response });
});

test('OpenAI chat streams generated text', { timeout }, async () => {
  const response = await request('/v1/chat/completions', {
    model: omni,
    messages: [{ role: 'user', content: 'What is 2 + 2? Answer one digit.' }],
    stream: true,
    temperature: 0,
    max_tokens: 32,
  });
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const result = await events(response);
  const text = result
    .map((event) => {
      const chunk = event as { choices?: { delta?: { content?: string } }[] };
      return chunk.choices?.[0]?.delta?.content || '';
    })
    .join('');
  assert.match(text, /\b4\b/);
  await evidence('openai-stream', result);
});

test('OpenAI chat understands an image', { timeout }, async () => {
  const image = await toDataUrl((await fixtures()).image, 'image/png');
  const result = await chat([
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: 'What color is the square? Answer one color.' },
      ],
    },
  ]);
  assert.match(chatText(result), /\bred\b/i);
  await evidence('openai-image', result);
});

test('OpenAI chat understands and translates recorded audio', { timeout }, async () => {
  const data = (await readFile((await fixtures()).audio)).toString('base64');
  const audio = { type: 'input_audio', input_audio: { data, format: 'wav' } };
  const question = await chat([
    {
      role: 'user',
      content: [audio, { type: 'text', text: 'What language is spoken? Answer one language.' }],
    },
  ]);
  assert.match(chatText(question), /English/i);
  const translated = await chat(
    [
      { role: 'system', content: 'Translate the speech into German.' },
      { role: 'user', content: [audio] },
    ],
    { max_tokens: 180 },
  );
  assert.match(chatText(translated), /Land|fragen|tun/i);
  await evidence('openai-audio', { question, translated });
});

test(
  'OpenAI chat sees video and distinguishes its soundtrack from silence',
  { timeout },
  async () => {
    const { video, silentVideo } = await fixtures();
    const answers = [];
    for (const [path, expected] of [
      [video, /\byes\b/i],
      [silentVideo, /\bno\b/i],
    ] as const) {
      const data = (await readFile(path)).toString('base64');
      const result = await chat([
        {
          role: 'system',
          content: 'Answer questions about the video using what you see and hear.',
        },
        {
          role: 'user',
          content: [
            { type: 'input_video', input_video: { data } },
            {
              type: 'text',
              text: 'Can you hear someone speaking in the soundtrack? Answer yes or no.',
            },
          ],
        },
      ]);
      assert.match(chatText(result), expected);
      answers.push(result);
    }
    const videoData = (await readFile(video)).toString('base64');
    const activity = await chat([
      {
        role: 'user',
        content: [
          { type: 'input_video', input_video: { data: videoData } },
          { type: 'text', text: 'What is the child doing? Answer in one sentence.' },
        ],
      },
    ]);
    assert.match(chatText(activity), /read|book/i);
    await evidence('openai-video', { answers, activity });
  },
);

test('OpenAI chat produces schema-constrained JSON', { timeout }, async () => {
  const result = await chat([{ role: 'user', content: 'Return JSON with sum equal to 2 + 3.' }], {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'sum',
        strict: true,
        schema: {
          type: 'object',
          properties: { sum: { type: 'integer' } },
          required: ['sum'],
          additionalProperties: false,
        },
      },
    },
  });
  assert.deepEqual(JSON.parse(chatText(result)), { sum: 5 });
  await evidence('openai-schema', result);
});

test('OpenAI chat produces usable tool arguments', { timeout }, async () => {
  const result = await chat([{ role: 'user', content: 'Call add_numbers with a=2 and b=3.' }], {
    tools: [
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
    ],
    tool_choice: { type: 'function', function: { name: 'add_numbers' } },
  });
  const call = result.choices?.[0]?.message.tool_calls?.[0];
  assert.equal(call?.function.name, 'add_numbers');
  assert.deepEqual(JSON.parse(call!.function.arguments), { a: 2, b: 3 });
  await evidence('openai-tool', result);
});

test('Anthropic Messages answers text and image questions', { timeout }, async () => {
  const image = (await readFile((await fixtures()).image)).toString('base64');
  const text = await json('/v1/messages', {
    model: omni,
    max_tokens: 32,
    temperature: 0,
    messages: [{ role: 'user', content: 'What is 2 + 2? Answer one digit.' }],
  });
  assert.match(anthropicText(text), /\b4\b/);
  const picture = await json('/v1/messages', {
    model: omni,
    max_tokens: 64,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
          { type: 'text', text: 'What color is the square? Answer one color.' },
        ],
      },
    ],
  });
  assert.match(anthropicText(picture), /\bred\b/i);
  await evidence('anthropic-messages', { text, picture });
});

test('Anthropic Messages streams text content', { timeout }, async () => {
  const response = await request('/v1/messages', {
    model: omni,
    max_tokens: 32,
    temperature: 0,
    stream: true,
    messages: [{ role: 'user', content: 'What is 2 + 2? Answer one digit.' }],
  });
  const result = await events(response);
  assert.ok(result.some((event) => event.type === 'message_start'));
  assert.ok(result.some((event) => event.type === 'message_stop'));
  const text = result
    .map((event) => {
      const chunk = event as { delta?: { text?: string } };
      return chunk.delta?.text || '';
    })
    .join('');
  assert.match(text, /\b4\b/);
  await evidence('anthropic-stream', result);
});
