/** Keep in step with package.json. test/version.test.ts fails when they differ. */
export const VERSION = '0.1.3';

export const DEFAULT_BASE_URL = 'https://control.mailblaze.com/api';

/** Default timeout is 10 seconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export const MAX_TIMEOUT_MS = 120_000;

export const DEFAULT_GET_RETRY_LIMIT = 2;

export const MAX_GET_RETRY_LIMIT = 5;

/** Base GET backoff: `retryDelayMs * 2^(attempt - 1)`. */
export const DEFAULT_RETRY_DELAY_MS = 200;

export const MAX_RETRY_DELAY_MS = 5_000;

/**
 * The API allows an encoded attachment of this size and rejects one byte more.
 */
export const MAX_ATTACHMENT_ENCODED_BYTES = 10 * 1024 * 1024;

/**
 * That 15 MiB total is a client-side limit. The API also enforces a 10 MiB
 * per-attachment limit.
 */
export const MAX_TOTAL_ENCODED_BYTES = 15 * 1024 * 1024;

/** Default cap on a response body, in bytes (16 MiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export const MAX_RESPONSE_BYTES_LIMIT = 64 * 1024 * 1024;

export const MIN_PER_PAGE = 10;

export const MAX_PER_PAGE = 50;
