import type { ServerResponse } from 'node:http';

export const sendJson = (response: ServerResponse, status: number, data: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
};

export const sendError = (response: ServerResponse, status: number, message: string): void =>
  sendJson(response, status, { error: { message, type: 'invalid_request_error' } });
