import { TOKEN_RENEW_BEFORE_MS } from './settings';

/** JWT `exp` is unix seconds. Returns null when the token cannot be decoded. */
export function jwtExpiryEpochSeconds(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the access token's `exp` is at least five minutes ahead.
 * Missing or unreadable `exp` is treated as not valid so we refresh or log in.
 */
export function isAccessTokenValid(token: string, nowMs: number, renewBeforeMs = TOKEN_RENEW_BEFORE_MS): boolean {
  const exp = jwtExpiryEpochSeconds(token);
  if (exp === null) {
    return false;
  }
  return exp * 1000 >= nowMs + renewBeforeMs;
}
