import { readFileSync } from 'fs';
import path from 'path';
import type { FetchLike, PluginLogger } from '../src/lkClient';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fixture<T = any>(name: string): T {
  const file = path.resolve(process.cwd(), 'test/fixtures', name);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function captureLogger(): { log: PluginLogger; lines: Array<{ level: string; message: string }>; text: () => string } {
  const lines: Array<{ level: string; message: string }> = [];
  const push = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    log: {
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      debug: push('debug'),
    },
    text: () => lines.map((line) => `${line.level}: ${line.message}`).join('\n'),
  };
}

export function headerRecord(init?: RequestInit): Record<string, string> {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    return {};
  }
  return { ...(headers as Record<string, string>) };
}

export function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function recordFetch(
  handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: headerRecord(init),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

export const instantSleep = async (): Promise<void> => {};

export const EMAIL = 'you@example.com';
export const PASSWORD = 'super-secret-password';
