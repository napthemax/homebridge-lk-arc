import { errorMessage, maskSecrets } from './redact';
import {
  API_BASE_URL,
  LK_HEADERS,
  RATE_LIMIT_DEFAULT_SECONDS,
  RATE_LIMIT_RETRIES,
  REQUEST_TIMEOUT_MS,
  TRANSIENT_RETRIES,
} from './settings';
import { isAccessTokenValid } from './token';
import type {
  HubStructure,
  LkApi,
  LoginResponse,
  Realestate,
  SenseMeasurements,
  UserResponse,
} from './types';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface LkClientOptions {
  email: string;
  password: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  encodeMac?: boolean;
  logger?: PluginLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  debug?: boolean;
  session?: {
    accessToken?: string;
    refreshToken?: string;
    userId?: string;
  };
}

export interface Timer {
  cancel(): void;
}

interface SendOptions {
  auth: boolean;
  retry401: boolean;
  retryTransient: boolean;
  /** Setpoint responses may be empty or plain text. */
  lenientBody: boolean;
}

const SUCCESS_JSON = new Set([200]);
const SUCCESS_LENIENT = new Set([200, 201, 204]);

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/**
 * Paths are the only LK endpoints this plugin calls.
 * MAC segments go through formatMacForPath so encoding can be switched in one place.
 */
export function formatMacForPath(mac: string, encodeMac: boolean): string {
  return encodeMac ? encodeURIComponent(mac) : mac;
}

export function apiPaths(encodeMac: boolean) {
  return {
    login: 'auth/auth/login',
    refresh: 'auth/auth/refresh',
    user: 'auth/auth/user',
    userStructure: (userId: string) => `service/users/user/${userId}/structure/false`,
    hubStructure: (hubIdentity: string) => `service/arc/hub/${hubIdentity}/structure/false`,
    senseMeasurement: (mac: string) => `service/arc/sense/${formatMacForPath(mac, encodeMac)}/measurement/true`,
    senseTemperature: (mac: string) => `control/arc/sense/${formatMacForPath(mac, encodeMac)}/temperature`,
  };
}

export class LkHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'LkHttpError';
    this.status = status;
  }
}

export class LkAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LkAuthError';
  }
}

const noopLogger: PluginLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export class LkClient implements LkApi {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly encodeMac: boolean;
  private readonly log: PluginLogger;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly debugToInfo: boolean;
  private readonly email: string;
  private readonly password: string;
  private readonly paths: ReturnType<typeof apiPaths>;
  private readonly seenSecrets = new Set<string>();

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private userId: string | null = null;
  private authFlight: Promise<void> | null = null;

  constructor(options: LkClientOptions) {
    this.email = options.email;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? API_BASE_URL).replace(/\/+$/, '');
    this.encodeMac = options.encodeMac ?? false;
    this.log = options.logger ?? noopLogger;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.debugToInfo = options.debug ?? false;
    this.paths = apiPaths(this.encodeMac);
    this.remember(this.password);
    if (options.session?.accessToken) {
      this.accessToken = options.session.accessToken;
      this.remember(options.session.accessToken);
    }
    if (options.session?.refreshToken) {
      this.refreshToken = options.session.refreshToken;
      this.remember(options.session.refreshToken);
    }
    if (options.session?.userId) {
      this.userId = options.session.userId;
    }
  }

  async ensureUserId(): Promise<string> {
    await this.ensureAuth();
    if (!this.userId) {
      throw new LkAuthError('Login did not return a user id');
    }
    return this.userId;
  }

  async getUserStructure(userId: string): Promise<Realestate[]> {
    await this.ensureAuth();
    const data = await this.send('GET', this.paths.userStructure(userId), undefined, {
      auth: true,
      retry401: true,
      retryTransient: true,
      lenientBody: false,
    });
    if (!Array.isArray(data)) {
      throw new LkHttpError('User structure was not a list', 200);
    }
    return data as Realestate[];
  }

  async getHubStructure(hubIdentity: string): Promise<HubStructure> {
    await this.ensureAuth();
    const data = await this.send('GET', this.paths.hubStructure(hubIdentity), undefined, {
      auth: true,
      retry401: true,
      retryTransient: true,
      lenientBody: false,
    });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new LkHttpError('Hub structure was not an object', 200);
    }
    return data as HubStructure;
  }

  async getSenseMeasurement(mac: string): Promise<SenseMeasurements> {
    await this.ensureAuth();
    const data = await this.send('GET', this.paths.senseMeasurement(mac), undefined, {
      auth: true,
      retry401: true,
      retryTransient: true,
      lenientBody: false,
    });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new LkHttpError('Sense measurement was not an object', 200);
    }
    return data as SenseMeasurements;
  }

  async setTemperature(mac: string, tenths: number): Promise<void> {
    if (!Number.isInteger(tenths) || tenths < 50 || tenths > 300 || tenths % 5 !== 0) {
      throw new Error(`Refusing setpoint ${tenths} tenths`);
    }
    await this.ensureAuth();
    await this.send('POST', this.paths.senseTemperature(mac), { temperature: tenths }, {
      auth: true,
      retry401: true,
      retryTransient: true,
      lenientBody: true,
    });
  }

  private async ensureAuth(): Promise<void> {
    if (this.accessToken && isAccessTokenValid(this.accessToken, this.now()) && this.userId) {
      return;
    }
    if (!this.authFlight) {
      this.authFlight = this.authenticate().finally(() => {
        this.authFlight = null;
      });
    }
    await this.authFlight;
  }

  private async authenticate(): Promise<void> {
    const usable = !!this.accessToken && isAccessTokenValid(this.accessToken, this.now());
    if (!usable) {
      if (this.refreshToken) {
        try {
          await this.refresh();
        } catch (err) {
          this.debug(`Token refresh failed, falling back to login: ${errorMessage(err)}`);
          await this.login();
        }
      } else {
        await this.login();
      }
    }
    if (!this.accessToken) {
      throw new LkAuthError('Authentication did not produce an access token');
    }
    if (!this.userId) {
      await this.loadUser();
    }
  }

  /**
   * auth/auth/refresh is documented in the OpenAPI spec and was not used by the
   * Home Assistant library. Any failure falls back to a full login.
   */
  private async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new LkAuthError('No refresh token');
    }
    this.debug('Refreshing access token');
    const data = await this.send('POST', this.paths.refresh, { refreshToken: this.refreshToken }, {
      auth: false,
      retry401: false,
      retryTransient: false,
      lenientBody: false,
    });
    this.storeSession(data);
    if (!this.accessToken || !isAccessTokenValid(this.accessToken, this.now())) {
      throw new LkAuthError('Refresh did not return a usable access token');
    }
  }

  private async login(): Promise<void> {
    this.debug('Logging in');
    const data = await this.send('POST', this.paths.login, {
      email: this.email,
      password: this.password,
    }, {
      auth: false,
      retry401: false,
      retryTransient: true,
      lenientBody: false,
    });
    this.storeSession(data);
    if (!this.accessToken) {
      throw new LkAuthError('Login did not return an access token');
    }
    this.info('Logged in to the LK cloud');
  }

  /** The user endpoint sometimes fails immediately after login; retry a few times. */
  private async loadUser(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const data = await this.send('GET', this.paths.user, undefined, {
          auth: true,
          retry401: false,
          retryTransient: false,
          lenientBody: false,
        });
        const userId = (data as UserResponse | undefined)?.userId;
        if (typeof userId !== 'string' || userId.length === 0) {
          throw new LkAuthError('User response did not include userId');
        }
        this.userId = userId;
        return;
      } catch (err) {
        lastError = err;
        this.debug(`Reading user id failed (attempt ${attempt})`);
        if (attempt < 3) {
          await this.sleepImpl(200 * attempt);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new LkAuthError('Could not read user id');
  }

  private storeSession(data: unknown): void {
    if (!data || typeof data !== 'object') {
      throw new LkAuthError('Auth response was not an object');
    }
    const body = data as LoginResponse;
    if (typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
      throw new LkAuthError('Auth response did not include an access token');
    }
    this.accessToken = body.accessToken;
    this.remember(body.accessToken);
    if (typeof body.refreshToken === 'string' && body.refreshToken.length > 0) {
      this.refreshToken = body.refreshToken;
      this.remember(body.refreshToken);
    }
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: SendOptions,
  ): Promise<unknown> {
    let rateLimitRetries = 0;
    let transientRetries = 0;
    let retry401 = options.retry401;

    for (;;) {
      try {
        const response = await this.fetchOnce(method, path, body, options.auth);
        if (response.status === 429 && rateLimitRetries < RATE_LIMIT_RETRIES) {
          rateLimitRetries += 1;
          const seconds = parseRetryAfter(response.retryAfter);
          this.debug(`${method} ${path} -> 429, retry ${rateLimitRetries} in ${seconds}s`);
          await this.sleepImpl(seconds * 1000);
          continue;
        }
        if (response.status === 401 && retry401 && !this.isAuthPath(path)) {
          this.debug(`${method} ${path} -> 401, logging in once and retrying`);
          retry401 = false;
          await this.login();
          continue;
        }
        if (TRANSIENT_STATUSES.has(response.status) && options.retryTransient && transientRetries < TRANSIENT_RETRIES) {
          transientRetries += 1;
          this.debug(`${method} ${path} -> ${response.status}, retry ${transientRetries}`);
          await this.sleepImpl(2000 * transientRetries);
          continue;
        }
        return this.parseBody(method, path, response.status, response.text, options.lenientBody);
      } catch (err) {
        if (err instanceof LkHttpError || err instanceof LkAuthError) {
          throw err;
        }
        if (options.retryTransient && isTransientError(err) && transientRetries < TRANSIENT_RETRIES) {
          transientRetries += 1;
          this.debug(`${method} ${path} network error, retry ${transientRetries}: ${errorMessage(err)}`);
          await this.sleepImpl(2000 * transientRetries);
          continue;
        }
        const message = this.mask(`${method} ${path} failed: ${errorMessage(err)}`);
        this.warn(message);
        throw new Error(message);
      }
    }
  }

  private async fetchOnce(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<{ status: number; text: string; retryAfter: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { ...LK_HEADERS };
    if (auth) {
      if (!this.accessToken) {
        throw new LkAuthError('Not authenticated');
      }
      headers.authorization = `Bearer ${this.accessToken}`;
    }
    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const url = `${this.baseUrl}/${path}`;
    const started = this.now();
    try {
      const response = await this.fetchImpl(url, init);
      const text = await response.text();
      const duration = Math.max(0, this.now() - started);
      this.debug(`${method} ${path} -> ${response.status} (${duration}ms)`);
      return {
        status: response.status,
        text,
        retryAfter: response.headers.get('retry-after'),
      };
    } catch (err) {
      const duration = Math.max(0, this.now() - started);
      this.debug(`${method} ${path} -> network error (${duration}ms)`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseBody(
    method: string,
    path: string,
    status: number,
    text: string,
    lenient: boolean,
  ): unknown {
    const ok = lenient ? SUCCESS_LENIENT : SUCCESS_JSON;
    if (!ok.has(status)) {
      const snippet = text.trim().slice(0, 300);
      const message = this.mask(`${method} ${path} failed with ${status}${snippet ? `: ${snippet}` : ''}`);
      this.warn(message);
      if (status === 401 && (path === this.paths.login || path === this.paths.refresh)) {
        throw new LkAuthError(message);
      }
      throw new LkHttpError(message, status);
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      if (lenient) {
        return undefined;
      }
      throw new LkHttpError(this.mask(`${method} ${path} returned non-JSON`), status);
    }
  }

  private isAuthPath(path: string): boolean {
    return path === this.paths.login || path === this.paths.refresh || path === this.paths.user;
  }

  private remember(secret: string | null | undefined): void {
    if (secret && secret.length > 0) {
      this.seenSecrets.add(secret);
    }
  }

  private mask(message: string): string {
    return maskSecrets(message, [this.password, this.accessToken, this.refreshToken, ...this.seenSecrets]);
  }

  private debug(message: string): void {
    const masked = this.mask(message);
    this.log.debug(masked);
    if (this.debugToInfo) {
      this.log.info(masked);
    }
  }

  private info(message: string): void {
    this.log.info(this.mask(message));
  }

  private warn(message: string): void {
    this.log.warn(this.mask(message));
  }
}

export function parseRetryAfter(header: string | null): number {
  if (header === null || header.trim() === '') {
    return RATE_LIMIT_DEFAULT_SECONDS;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds)) {
    return RATE_LIMIT_DEFAULT_SECONDS;
  }
  return Math.max(1, Math.ceil(seconds));
}

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return true;
  }
  const code = (err as { code?: string }).code;
  return code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND'
    || code === 'EPIPE'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_SOCKET';
}
