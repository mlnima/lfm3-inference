import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { apiKey, baseUrl, omni, timeout } from './liveSupport.ts';

export type ProtocolEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  session?: { type: string; audio?: { input?: { format?: { rate?: number } } } };
  response?: { status: string; status_details?: unknown };
  error?: { message: string };
};

export const protocolSession = async (
  query: string,
  handle: (event: ProtocolEvent, send: (event: unknown) => void) => boolean,
) => {
  const url = new URL(`/v1/realtime?model=${omni}${query}`, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
    handshakeTimeout: 30_000,
  });
  const events: ProtocolEvent[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime protocol timed out')), timeout);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      socket.on('error', finish);
      socket.on('close', () => finish(new Error('Realtime closed before the expected event')));
      socket.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString()) as ProtocolEvent;
          events.push(event);
          assert.notEqual(event.type, 'error', event.error?.message);
          const finished = handle(event, (value) => socket.send(JSON.stringify(value)));
          finished && finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } finally {
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 3_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }
  return events;
};
