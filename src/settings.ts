import type { PlatformConfig } from 'homebridge';

export const PLUGIN_NAME = 'homebridge-lk-arc';
export const PLATFORM_NAME = 'LkArc';

export const API_BASE_URL = 'https://link2.lk.nu';

/**
 * Public APIM subscription key shipped in angoyd/ha-lksystems.
 * It is not an account secret. Whether LK expects it to be reused is unverified.
 */
export const OCP_APIM_SUBSCRIPTION_KEY = 'd2d308826cd14e7d92660b28bc7d859c';

export const LK_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  'api-version': '1',
  Accept: 'application/json, application/xml, text/plain, text/html, *.*',
  'User-Agent': 'MyLk',
  'ocp-apim-subscription-key': OCP_APIM_SUBSCRIPTION_KEY,
});

export const REQUEST_TIMEOUT_MS = 20_000;
export const TOKEN_RENEW_BEFORE_MS = 5 * 60 * 1000;
export const SETPOINT_DEBOUNCE_MS = 1500;
export const SETPOINT_REFRESH_DELAY_MS = 5000;
/** Hub structure is cached (`/false`). Ignore a stale setpoint echo for this long after a successful write. */
export const SETPOINT_ECHO_GRACE_MS = 20_000;
export const MIN_CELSIUS = 5;
export const MAX_CELSIUS = 30;
export const DEFAULT_POLL_INTERVAL_MINUTES = 5;
export const MAX_POLL_BACKOFF_MS = 30 * 60 * 1000;
export const RATE_LIMIT_RETRIES = 3;
export const RATE_LIMIT_DEFAULT_SECONDS = 5;
export const TRANSIENT_RETRIES = 3;

/** Library sends the MAC with colons. Flip with the encodeMac config flag. */
export const ENCODE_MAC_DEFAULT = false;

export interface ResolvedSettings {
  name: string;
  email: string;
  password: string;
  pollIntervalMinutes: number;
  pollIntervalMs: number;
  debug: boolean;
  hideRooms: string[];
  encodeMac: boolean;
}

export function resolvePollIntervalMinutes(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_POLL_INTERVAL_MINUTES;
  }
  return Math.max(1, Math.floor(parsed));
}

/**
 * Delay before the next poll. The first failure waits twice the normal
 * interval, then doubles, and never exceeds 30 minutes.
 */
export function nextPollDelayMs(consecutiveFailures: number, intervalMs: number): number {
  if (consecutiveFailures <= 0) {
    return intervalMs;
  }
  const factor = 2 ** Math.min(consecutiveFailures, 16);
  return Math.min(intervalMs * factor, MAX_POLL_BACKOFF_MS);
}

export function resolveSettings(config: PlatformConfig): ResolvedSettings | null {
  const email = typeof config.email === 'string' ? config.email.trim() : '';
  const password = typeof config.password === 'string' ? config.password : '';
  if (!email || !password) {
    return null;
  }

  const pollIntervalMinutes = resolvePollIntervalMinutes(config.pollIntervalMinutes);
  const hideRooms = Array.isArray(config.hideRooms)
    ? config.hideRooms
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    : [];

  return {
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : 'LK Arc',
    email,
    password,
    pollIntervalMinutes,
    pollIntervalMs: pollIntervalMinutes * 60 * 1000,
    debug: config.debug === true,
    hideRooms,
    encodeMac: config.encodeMac === true,
  };
}
