import type { IncomingMessage } from 'node:http';

export const readBody = async (request: IncomingMessage, limit: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body exceeds MAX_BODY_BYTES.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export const readJson = (body: Buffer): Record<string, unknown> =>
  JSON.parse(body.toString('utf8')) as Record<string, unknown>;

export const readForm = async (body: Buffer, contentType: string): Promise<FormData> =>
  new Request('http://localhost', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  }).formData();
