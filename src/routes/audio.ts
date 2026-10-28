import type { RunningModel } from '../config/types.js';
import { readForm } from '../http/body.js';

export const speechRequest = (body: Record<string, unknown>): Record<string, unknown> => ({
  ...body,
  lang: body.language || body.lang,
});

export const transcriptionRequest = async (
  contentType: string,
  body: Buffer,
): Promise<{ model?: string; body: Record<string, unknown>; format: string }> => {
  const form = await readForm(body, contentType);
  const file = form.get('file');
  if (!(file instanceof File)) throw new Error('The file field must contain audio.');
  const languageCode = String(form.get('language') || 'en');
  const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(languageCode);
  const audio = Buffer.from(await file.arrayBuffer()).toString('base64');
  const model = form.get('model')?.toString();
  return {
    model,
    format: String(form.get('response_format') || 'json'),
    body: {
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: `Perform ASR in ${language}.` },
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: audio } }],
        },
      ],
    },
  };
};

export const transcribe = async (
  model: RunningModel,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ status: number; text: string; error?: unknown }> => {
  const result = await fetch(`${model.origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await result.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: unknown;
  };
  return {
    status: result.status,
    text: data.choices?.[0]?.message?.content || '',
    error: data.error,
  };
};
