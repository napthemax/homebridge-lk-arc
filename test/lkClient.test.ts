import { describe, expect, it } from 'vitest';
import { LkClient, formatMacForPath, parseRetryAfter } from '../src/lkClient';
import type { Realestate } from '../src/types';
import {
  EMAIL,
  PASSWORD,
  captureLogger,
  fixture,
  instantSleep,
  jsonResponse,
  makeJwt,
  recordFetch,
} from './helpers';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const BASE = 'https://link2.lk.nu';
const FAR_EXP = 1_900_000_000;
const NOW = 1_700_000_000_000;

function client(options: ConstructorParameters<typeof LkClient>[0]): LkClient {
  return new LkClient({
    email: EMAIL,
    password: PASSWORD,
    sleep: instantSleep,
    now: () => NOW,
    ...options,
  });
}

describe('LkClient auth and headers', () => {
  it('logs in and reads the user id', async () => {
    const login = fixture('login.json');
    const user = fixture('user.json');
    const logger = captureLogger();
    const { calls, fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/login')) {
        return jsonResponse(login);
      }
      if (call.url.endsWith('/auth/auth/user')) {
        return jsonResponse(user);
      }
      throw new Error(`unexpected ${call.url}`);
    });

    const api = client({ fetchImpl, logger: logger.log, debug: true });
    await expect(api.ensureUserId()).resolves.toBe(USER_ID);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${BASE}/auth/auth/login`,
      `GET ${BASE}/auth/auth/user`,
    ]);
    expect(calls[0].body).toEqual({ email: EMAIL, password: PASSWORD });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[1].headers.authorization).toBe(`Bearer ${login.accessToken}`);
    expect(logger.text()).toContain('GET auth/auth/user -> 200');
    expect(logger.text()).toMatch(/GET auth\/auth\/user -> 200 \(\d+ms\)/);
  });

  it('sends the LK headers on every request', async () => {
    const login = fixture('login.json');
    const user = fixture('user.json');
    const structure = fixture('user_structure.json');
    const { calls, fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/login')) return jsonResponse(login);
      if (call.url.endsWith('/auth/auth/user')) return jsonResponse(user);
      if (call.url.endsWith(`/service/users/user/${USER_ID}/structure/false`)) return jsonResponse(structure);
      throw new Error(`unexpected ${call.url}`);
    });

    const api = client({ fetchImpl });
    const estates = await api.getUserStructure(await api.ensureUserId());
    expect(estates[0].realestateId).toBe('re-0001');

    for (const call of calls) {
      expect(call.headers['content-type']).toBe('application/json');
      expect(call.headers['api-version']).toBe('1');
      expect(call.headers.Accept).toBe('application/json, application/xml, text/plain, text/html, *.*');
      expect(call.headers['User-Agent']).toBe('MyLk');
      expect(call.headers['ocp-apim-subscription-key']).toBe('d2d308826cd14e7d92660b28bc7d859c');
    }
    expect(calls[2].headers.authorization).toBe(`Bearer ${login.accessToken}`);
    expect(calls[2].url).toBe(`${BASE}/service/users/user/${USER_ID}/structure/false`);
  });

  it('does not log passwords or tokens', async () => {
    const login = fixture('login.json');
    const logger = captureLogger();
    const { fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/login')) {
        return jsonResponse(login);
      }
      return new Response(
        JSON.stringify({ detail: `leaked ${PASSWORD} ${login.accessToken} ${login.refreshToken}` }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    });

    const api = client({ fetchImpl, logger: logger.log, debug: true });
    await expect(api.ensureUserId()).rejects.toThrow();

    const output = logger.text();
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(login.accessToken);
    expect(output).not.toContain(login.refreshToken);
    expect(output).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(output).toContain('***');
  });
});

describe('LkClient token refresh and retries', () => {
  it('refreshes a near-expiry token and falls back to login when refresh fails', async () => {
    const login = fixture('login.json');
    const structure = fixture<Realestate[]>('user_structure.json');
    const seededAccess = makeJwt(Math.floor(NOW / 1000) + 60);
    const seededRefresh = 'refresh-SECRET-token';
    const logger = captureLogger();
    const { calls, fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/refresh')) {
        return new Response(JSON.stringify({ detail: `nope ${seededRefresh}` }), { status: 500 });
      }
      if (call.url.endsWith('/auth/auth/login')) return jsonResponse(login);
      if (call.url.includes('/structure/false')) return jsonResponse(structure);
      throw new Error(`unexpected ${call.url}`);
    });

    const api = client({
      fetchImpl,
      logger: logger.log,
      session: { accessToken: seededAccess, refreshToken: seededRefresh, userId: USER_ID },
    });
    const estates = await api.getUserStructure(USER_ID);
    expect(estates).toHaveLength(1);
    expect(calls.map((call) => call.url.replace(`${BASE}/`, ''))).toEqual([
      'auth/auth/refresh',
      'auth/auth/login',
      `service/users/user/${USER_ID}/structure/false`,
    ]);
    expect(calls[0].body).toEqual({ refreshToken: seededRefresh });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(calls[2].headers.authorization).toBe(`Bearer ${login.accessToken}`);
    expect(logger.text()).not.toContain(seededAccess);
    expect(logger.text()).not.toContain(seededRefresh);
    expect(logger.text()).not.toContain(PASSWORD);
    expect(logger.text()).not.toContain(login.accessToken);
  });

  it('uses a successful refresh without logging in again', async () => {
    const refreshed = makeJwt(FAR_EXP);
    const structure = fixture('user_structure.json');
    const { calls, fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/refresh')) {
        return jsonResponse({ ...fixture('refresh.json'), accessToken: refreshed, refreshToken: 'rotated-refresh' });
      }
      if (call.url.includes('/structure/false')) return jsonResponse(structure);
      throw new Error(`unexpected ${call.url}`);
    });

    const api = client({
      fetchImpl,
      session: {
        accessToken: makeJwt(Math.floor(NOW / 1000) + 30),
        refreshToken: 'old-refresh',
        userId: USER_ID,
      },
    });
    await api.getUserStructure(USER_ID);
    expect(calls.map((call) => call.method + ' ' + call.url)).toEqual([
      `POST ${BASE}/auth/auth/refresh`,
      `GET ${BASE}/service/users/user/${USER_ID}/structure/false`,
    ]);
    expect(calls[1].headers.authorization).toBe(`Bearer ${refreshed}`);
  });

  it('re-logs in once after a 401 and retries the data call once', async () => {
    const login = fixture('login.json');
    const problem = fixture('problem_401.json');
    const structure = fixture('user_structure.json');
    const seeded = makeJwt(FAR_EXP);
    let structureCalls = 0;
    const { calls, fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/login')) return jsonResponse(login);
      if (call.url.includes('/structure/false')) {
        structureCalls += 1;
        if (structureCalls === 1) return jsonResponse(problem, 401);
        return jsonResponse(structure);
      }
      throw new Error(`unexpected ${call.url}`);
    });

    const api = client({
      fetchImpl,
      session: { accessToken: seeded, refreshToken: 'refresh-SECRET-token', userId: USER_ID },
    });
    await expect(api.getUserStructure(USER_ID)).resolves.toHaveLength(1);
    const paths = calls.map((call) => call.url.replace(`${BASE}/`, ''));
    expect(paths).toEqual([
      `service/users/user/${USER_ID}/structure/false`,
      'auth/auth/login',
      `service/users/user/${USER_ID}/structure/false`,
    ]);
    expect(calls[0].headers.authorization).toBe(`Bearer ${seeded}`);
    expect(calls[2].headers.authorization).toBe(`Bearer ${login.accessToken}`);
    expect(calls.filter((call) => call.url.endsWith('/auth/auth/login'))).toHaveLength(1);
  });

  it('does not log in a second time when the retried call is still 401', async () => {
    const login = fixture('login.json');
    const problem = fixture('problem_401.json');
    const { calls, fetchImpl } = recordFetch((call) => {
      if (call.url.endsWith('/auth/auth/login')) return jsonResponse(login);
      return jsonResponse(problem, 401);
    });
    const api = client({
      fetchImpl,
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
    });
    await expect(api.getUserStructure(USER_ID)).rejects.toThrow(/401/);
    expect(calls.filter((call) => call.url.endsWith('/auth/auth/login'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/structure/false'))).toHaveLength(2);
  });

  it('honours Retry-After and stops after three retries', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: LkClient extends never ? never : import('../src/lkClient').FetchLike = async (_url, _init) => {
      calls += 1;
      if (calls < 4) {
        return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      }
      return jsonResponse(fixture('user_structure.json'));
    };

    const api = client({
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
    });
    await expect(api.getUserStructure(USER_ID)).resolves.toHaveLength(1);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([2000, 2000, 2000]);
  });

  it('uses a 5 second delay when Retry-After is missing and at least 1 second', async () => {
    expect(parseRetryAfter(null)).toBe(5);
    expect(parseRetryAfter('')).toBe(5);
    expect(parseRetryAfter('0')).toBe(1);
    expect(parseRetryAfter('soon')).toBe(5);
    expect(parseRetryAfter('2')).toBe(2);

    const sleeps: number[] = [];
    let calls = 0;
    const api = client({
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('', { status: 429 });
        return jsonResponse(fixture('hub_structure.json'));
      },
    });
    await api.getHubStructure('ARCHUB000123');
    expect(sleeps).toEqual([5000]);
    expect(calls).toBe(2);
  });

  it('retries a transient network error and then warns', async () => {
    const logger = captureLogger();
    const sleeps: number[] = [];
    let calls = 0;
    const api = client({
      logger: logger.log,
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async () => {
        calls += 1;
        const error = new Error('socket hang up') as NodeJS.ErrnoException;
        error.code = 'ECONNRESET';
        throw error;
      },
    });
    await expect(api.getHubStructure('ARCHUB000123')).rejects.toThrow(/ECONNRESET|failed/);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([2000, 4000, 6000]);
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(true);
  });
});

describe('LkClient setpoint', () => {
  it('posts the setpoint body to the raw MAC path and accepts an empty 204', async () => {
    const request = fixture<{ temperature: number }>('set_temperature_request.json');
    const { calls, fetchImpl } = recordFetch(() => new Response(null, { status: 204 }));
    const api = client({
      fetchImpl,
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
    });
    await api.setTemperature('AA:BB:CC:DD:EE:01', request.temperature);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE}/control/arc/sense/AA:BB:CC:DD:EE:01/temperature`);
    expect(calls[0].body).toEqual({ temperature: 215 });
    expect(calls[0].headers.authorization?.startsWith('Bearer ')).toBe(true);
  });

  it('accepts a JSON setpoint response and a non-JSON 200', async () => {
    const response = fixture('set_temperature_response.json');
    let call = 0;
    const api = client({
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
      fetchImpl: async () => {
        call += 1;
        if (call === 1) return jsonResponse(response, 200);
        return new Response('OK', { status: 201 });
      },
    });
    await api.setTemperature('AA:BB:CC:DD:EE:01', 215);
    await api.setTemperature('AA:BB:CC:DD:EE:01', 210);
  });

  it('encodes the MAC only when the flag is on', () => {
    expect(formatMacForPath('AA:BB:CC:DD:EE:01', false)).toBe('AA:BB:CC:DD:EE:01');
    expect(formatMacForPath('AA:BB:CC:DD:EE:01', true)).toBe('AA%3ABB%3ACC%3ADD%3AEE%3A01');
  });

  it('builds an encoded setpoint path when encodeMac is set', async () => {
    const { calls, fetchImpl } = recordFetch(() => new Response('OK', { status: 200 }));
    const api = client({
      fetchImpl,
      encodeMac: true,
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
    });
    await api.setTemperature('AA:BB:CC:DD:EE:01', 215);
    expect(calls[0].url).toBe(`${BASE}/control/arc/sense/AA%3ABB%3ACC%3ADD%3AEE%3A01/temperature`);
  });

  it('reads a sensor measurement from the raw MAC path', async () => {
    const measurement = fixture('sense_measurement.json');
    const { calls, fetchImpl } = recordFetch(() => jsonResponse(measurement));
    const api = client({
      fetchImpl,
      session: { accessToken: makeJwt(FAR_EXP), userId: USER_ID },
    });
    const result = await api.getSenseMeasurement('AA:BB:CC:DD:EE:01');
    expect(result.currentTemperature).toBe(214);
    expect(result.desiredTemperature).toBe(220);
    expect(calls[0].url).toBe(`${BASE}/service/arc/sense/AA:BB:CC:DD:EE:01/measurement/true`);
  });
});
