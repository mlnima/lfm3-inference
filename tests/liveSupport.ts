import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts } from './fixtures.ts';

export const baseUrl = process.env.LFM3_TEST_URL || 'http://127.0.0.1:18080';
export const apiKey = process.env.API_KEY || 'change.me';
export const omni = 'lfm3-omni-2b';
export const decision = 'd1-omni-2b';
export const timeout = 240_000;

export type DecisionAnswer = {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
};

export type Reply = {
  choices?: {
    message: {
      content: string;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
  }[];
  content?: { type: string; text?: string; name?: string; input?: unknown }[];
  answers?: Record<string, DecisionAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  output?: { content?: { type: string; text?: string }[] }[];
  text?: string;
};

export const request = async (path: string, body?: unknown) => {
  const response = await fetch(new URL(path, baseUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  assert.equal(response.ok, true, `${path}: ${response.status} ${await errorText(response)}`);
  return response;
};

const errorText = async (response: Response) => (response.ok ? '' : response.text());

export const json = async (path: string, body: unknown) => {
  const response = await request(path, body);
  return (await response.json()) as Reply;
};

export const chat = async (messages: unknown[], extra: Record<string, unknown> = {}) =>
  json('/v1/chat/completions', {
    model: omni,
    messages,
    temperature: 0,
    max_tokens: 160,
    ...extra,
  });

export const chatText = (reply: Reply) => reply.choices?.[0]?.message.content || '';
export const anthropicText = (reply: Reply) =>
  reply.content?.map((part) => part.text || '').join('') || '';

export const askDecision = async (
  state: unknown,
  questions: Record<string, unknown>,
  media: Record<string, unknown> = {},
) => {
  const reply = await json('/v1/systemone', { model: decision, state, questions, ...media });
  assert.ok(reply.answers, 'Decision response must contain answers');
  assert.equal(
    reply.usage?.output_tokens,
    0,
    'Decision must use the native non-generative endpoint',
  );
  return reply.answers;
};

export const probabilities = (answer: DecisionAnswer) => {
  const values = Object.values(answer.probabilities || {});
  assert.ok(values.length >= 2, 'Expected probabilities for each candidate');
  values.forEach((value) => assert.ok(Number.isFinite(value) && value >= 0 && value <= 1));
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 0.001);
};

export const evidence = async (name: string, result: unknown) => {
  await writeFile(join(artifacts, `${name}.json`), JSON.stringify(result, null, 2));
};

export const events = async (response: Response) => {
  const chunks = await response.text();
  return chunks
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
};
