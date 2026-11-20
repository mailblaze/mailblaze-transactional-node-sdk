import {
  ApiError,
  AuthenticationError,
  DomainNotVerifiedError,
  NotFoundError,
  QuotaError,
  RateLimitError,
  SendFailedError,
  ValidationError,
  type MailBlazeError,
} from './errors.ts';
import { redact } from './redact.ts';

const VALIDATION_CODES = new Set([
  '100.001',
  '150.002',
  '150.003',
  '150.004',
  '150.005',
  '150.006',
  '150.011',
  '150.012',
  '150.014',
]);

export function mapError(status: number, payload: unknown, secret: string | undefined): MailBlazeError {
  const body = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const code = typeof body['code'] === 'string' && /^\d{3}\.\d{3}$/.test(body['code']) ? body['code'] : undefined;
  let error = typeof body['error'] === 'string' ? body['error'] : 'The Mail Blaze API request failed';
  error = redact(stripControls(error), secret);
  if (Buffer.byteLength(error) > 500) {
    error = truncate(error, 500);
  }
  const message = code === undefined ? error : `${error} (${code})`;

  if (code === '150.001' || (code === undefined && (status === 401 || status === 403))) {
    return new AuthenticationError(message, status, code, error, secret);
  }
  if (code === undefined && status === 400 && /invalid api key/i.test(error)) {
    return new AuthenticationError(message, status, code, error, secret);
  }
  if (code === '150.015') {
    return new QuotaError(message, status, code, error, secret);
  }
  if (code === '150.010') {
    return new DomainNotVerifiedError(message, status, code, error, secret);
  }
  if (code !== undefined && VALIDATION_CODES.has(code)) {
    return new ValidationError(message, status, code, error, secret);
  }
  if (code === '150.009' || code === '150.013') {
    return new NotFoundError(message, status, code, error, secret);
  }
  if (code === '150.007' || code === '150.016') {
    return new SendFailedError(message, status, code, error, secret);
  }
  if (code === '150.008') {
    return new ApiError(message, status, code, error, secret);
  }
  if (status === 401 || status === 403) {
    return new AuthenticationError(message, status, code, error, secret);
  }
  if (status === 404) {
    return new NotFoundError(message, status, code, error, secret);
  }
  if (status === 400 || status === 422) {
    return new ValidationError(message, status, code, error, secret);
  }
  // HTTP 429 with no more specific API code.
  if (status === 429) {
    return new RateLimitError(message, status, code, error, secret);
  }

  return new ApiError(message, status, code, error, secret);
}

/**
 * Server text can reach logs and terminals. Line breaks (including U+2028/U+2029) and tabs become spaces.
 * Other C0/C1 controls and bidi controls (U+202A-U+202E, U+2066-U+2069) are removed.
 */
function stripControls(value: string): string {
  return value
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
}

function truncate(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, '');
}
