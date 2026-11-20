/**
 * Replace the API key with a fixed marker. Split/join is one pass, so a key
 * that contains the marker is not expanded again.
 */
export function redact(value: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) {
    return value;
  }
  let out = value.includes(secret) ? value.split(secret).join('[redacted]') : value;
  // Also remove the percent-encoded form of the key.
  const encoded = percentEncode(secret);
  if (encoded !== secret && out.includes(encoded)) {
    out = out.split(encoded).join('[redacted]');
  }

  return out;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function redactedError(error: unknown, secret: string | undefined): Error | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const cause = new Error(redact(error.message, secret));
  if (typeof error.stack === 'string') {
    cause.stack = redact(error.stack, secret);
  }
  cause.name = error.name;

  return cause;
}
