export function maskSecrets(message: string, secrets: Array<string | null | undefined>): string {
  const unique = [...new Set(
    secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0),
  )].sort((a, b) => b.length - a.length);

  let out = message;
  for (const secret of unique) {
    out = out.split(secret).join('***');
  }

  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***');
  out = out.replace(
    /"(password|accessToken|refreshToken)"\s*:\s*"[^"]*"/gi,
    '"$1":"***"',
  );
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
