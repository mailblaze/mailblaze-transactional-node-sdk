import { redact, redactedError } from './redact.ts';

export class MailBlazeError extends Error {
  override readonly name: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Constructor options were rejected before a request. This is not an API response.
 */
export class ConfigurationError extends MailBlazeError {}

/**
 * The request was not sent because the message failed a client-side check,
 * or the API returned a validation code.
 */
export class ValidationError extends MailBlazeError {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly error: string;

  constructor(
    message: string,
    status?: number,
    code?: string,
    error?: string,
    secret?: string,
  ) {
    const safe = redact(message, secret);
    super(safe);
    this.status = status;
    this.code = code;
    this.error = redact(error ?? message, secret);
  }
}

export class ApiError extends MailBlazeError {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly error: string;

  constructor(
    message: string,
    status?: number,
    code?: string,
    error?: string,
    secret?: string,
    cause?: unknown,
  ) {
    const safe = redact(message, secret);
    const options = cause === undefined ? undefined : { cause: redactedError(cause, secret) };
    super(safe, options);
    this.status = status;
    this.code = code;
    this.error = redact(error ?? message, secret);
  }
}

/** `150.001`, or HTTP 401/403 when no more specific code applies. Sending is turned off, or the key was rejected. */
export class AuthenticationError extends ApiError {}

/** `150.015`. The account does not have enough credits. */
export class QuotaError extends ApiError {}

/** `150.010`. `from` is not on a verified domain. */
export class DomainNotVerifiedError extends ApiError {}

/** HTTP 404, `150.009`, or `150.013`. */
export class NotFoundError extends ApiError {}

/** `150.007` or `150.016`. The API refused the send. */
export class SendFailedError extends ApiError {}

/** HTTP 429. A send is not retried. */
export class RateLimitError extends ApiError {}

/**
 * Why a request did not complete. `timeout`, `dns`, `tls`, `connect`, `client`, `response`, `unknown`,
 * `abort` (your signal), and `redirect` (a redirect was refused).
 */
export type TransportReason = 'timeout' | 'abort' | 'dns' | 'tls' | 'connect' | 'client' | 'redirect' | 'response' | 'unknown';

/**
 * The request did not complete, or the body could not be read.
 * `POST /transactional` is never retried. After a timeout, the email may already have been accepted.
 */
export class TransportError extends MailBlazeError {
  readonly reason: TransportReason;

  constructor(reason: TransportReason, message: string, secret?: string, cause?: unknown) {
    const options = cause === undefined ? undefined : { cause: redactedError(cause, secret) };
    super(redact(message, secret), options);
    this.reason = reason;
  }
}

export interface ResponseTooLargeDetails {
  /** The `maxResponseBytes` limit that was exceeded. */
  maxBytes: number;
  /** HTTP status of the oversized response. */
  status?: number | undefined;
  /** Bytes read before the client stopped reading. Undefined when `Content-Length` alone rejected it. */
  receivedBytes?: number | undefined;
  /** A valid numeric `Content-Length` header, when the response had one. */
  declaredBytes?: number | undefined;
  /** The raw `Content-Length` header when it is numeric but too large to be a safe integer. Message only. */
  declaredHeader?: string | undefined;
}

/**
 * A 2xx response body is larger than `maxResponseBytes`. Retrying would download it again, so list, get,
 * and attachments fail on the first attempt. Oversized non-2xx responses are not reported this way: they
 * map by HTTP status (retry, `NotFoundError`, `RateLimitError`, `ApiError`, ...) without reading the body.
 */
export class ResponseTooLargeError extends TransportError {
  readonly maxBytes: number;
  readonly status: number | undefined;
  readonly receivedBytes: number | undefined;
  readonly declaredBytes: number | undefined;

  constructor(details: ResponseTooLargeDetails) {
    const status = details.status === undefined ? '' : ` (HTTP ${details.status})`;
    let message = `The Mail Blaze API response${status} is larger than the client limit of ${details.maxBytes} bytes`;
    if (details.declaredBytes !== undefined) {
      message += `; Content-Length is ${details.declaredBytes}`;
    } else if (details.declaredHeader !== undefined) {
      const raw = details.declaredHeader;
      message += `; declared Content-Length ${raw.length > 32 ? `${raw.slice(0, 32)}\u2026` : raw}`;
    }
    if (details.receivedBytes !== undefined) {
      message += `; reading stopped after ${details.receivedBytes} bytes`;
    }
    super('response', `${message}.`);
    this.maxBytes = details.maxBytes;
    this.status = details.status;
    this.receivedBytes = details.receivedBytes;
    this.declaredBytes = details.declaredBytes;
  }
}

/**
 * HTTP 2xx on send, but the body could not be read. The email may already have been accepted.
 * Check `list` or `get` before sending it again.
 */
export class UnconfirmedSendError extends TransportError {
  readonly status: number | undefined;

  constructor(message: string, status?: number, secret?: string, cause?: unknown) {
    super('response', message, secret, cause);
    this.status = status;
  }
}

export function isMailBlazeError(error: unknown): error is MailBlazeError {
  return error instanceof MailBlazeError;
}
