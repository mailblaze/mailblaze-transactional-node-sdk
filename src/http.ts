import {
  DEFAULT_BASE_URL,
  DEFAULT_GET_RETRY_LIMIT,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_GET_RETRY_LIMIT,
  MAX_RESPONSE_BYTES_LIMIT,
  MAX_RETRY_DELAY_MS,
  MAX_TIMEOUT_MS,
  VERSION,
} from './constants.ts';
import {
  ApiError,
  ConfigurationError,
  ResponseTooLargeError,
  TransportError,
  UnconfirmedSendError,
  type TransportReason,
} from './errors.ts';
import { isIPv4, isIPv6 } from 'node:net';
import { mapError } from './map-error.ts';
import { parseAttachments, parseEmailPage, parseEmailRecord, parseSendResult } from './parse.ts';
import { redact } from './redact.ts';
import { trimAscii } from './validate.ts';
import type {
  CallOptions,
  EmailPage,
  EmailRecord,
  FetchLike,
  Logger,
  MailBlazeOptions,
  SendResult,
  StoredAttachment,
  WireMessage,
} from './types.ts';

const secrets = new WeakMap<Transport, string>();

/** GET retry statuses. 429 is retried on GET only. */
const RETRYABLE_GET_STATUS = new Set([429, 500, 502, 503, 504]);
/** Longest wait between GET attempts, including a server `Retry-After`. Jitter is added on top. */
const MAX_RETRY_WAIT_MS = 60_000;
/** Largest delay `setTimeout` accepts without overflowing to an immediate call. */
const MAX_TIMER_MS = 2_147_483_647;
const UNCONFIRMED_HINT = 'The email may already have been accepted. Check the list before sending it again.';

export interface TransportHooks {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitterMs?: () => number;
  now?: () => number;
}

export class Transport {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #logger: Logger | undefined;
  readonly #timeoutMs: number;
  readonly #getRetryLimit: number;
  readonly #retryDelayMs: number;
  readonly #maxResponseBytes: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #jitterMs: () => number;
  readonly #now: () => number;

  constructor(options: MailBlazeOptions & TransportHooks) {
    if (options === null || typeof options !== 'object') {
      throw new ConfigurationError('options must be an object with an apiKey');
    }
    const apiKey: unknown = options.apiKey;
    if (apiKey === undefined || apiKey === null || (typeof apiKey === 'string' && trimAscii(apiKey) === '')) {
      throw new ConfigurationError('apiKey must not be empty');
    }
    if (typeof apiKey !== 'string' || !/^[\x21-\x7E]+$/.test(apiKey)) {
      throw new ConfigurationError('apiKey must be printable ASCII without spaces or control characters');
    }
    this.#timeoutMs = timeoutInRange(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const getRetryLimit = options.getRetryLimit ?? DEFAULT_GET_RETRY_LIMIT;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (
      !Number.isInteger(getRetryLimit) ||
      getRetryLimit < 0 ||
      getRetryLimit > MAX_GET_RETRY_LIMIT ||
      !Number.isInteger(retryDelayMs) ||
      retryDelayMs < 0 ||
      retryDelayMs > MAX_RETRY_DELAY_MS
    ) {
      throw new ConfigurationError(
        `getRetryLimit must be from 0 to ${MAX_GET_RETRY_LIMIT} and retryDelayMs must be from 0 to ${MAX_RETRY_DELAY_MS}`,
      );
    }
    this.#getRetryLimit = getRetryLimit;
    this.#retryDelayMs = retryDelayMs;
    secrets.set(this, apiKey);

    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    if (options.fetch !== undefined && typeof options.fetch !== 'function') {
      throw new ConfigurationError('fetch must be a function');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxResponseBytes = integerInRange(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES_LIMIT,
      'maxResponseBytes',
    );
    this.#logger = options.logger === undefined ? undefined : safeLogger(options.logger, apiKey);
    this.#sleep = options.sleep ?? delay;
    this.#jitterMs = options.jitterMs ?? (() => Math.floor(Math.random() * 100));
    this.#now = options.now ?? Date.now;
  }
  send(body: WireMessage, options?: CallOptions): Promise<SendResult> {
    return this.#request('POST', '/transactional', options, body).then((payload) => {
      try {
        return parseSendResult(payload, secrets.get(this));
      } catch (error) {
        if (error instanceof UnconfirmedSendError) {
          throw error;
        }
        throw new UnconfirmedSendError(
          'The Mail Blaze API accepted the request, but the response could not be read. The email may already have been accepted. Check the list before sending it again.',
          undefined,
          secrets.get(this),
          error,
        );
      }
    });
  }

  list(page: number, perPage: number, options?: CallOptions): Promise<EmailPage> {
    return this.#request('GET', '/transactional', options, undefined, {
      page: String(page),
      per_page: String(perPage),
    }).then(parseEmailPage);
  }

  get(emailUid: string, options?: CallOptions): Promise<EmailRecord> {
    return this.#request('GET', `/transactional/${emailUid}`, options).then(parseEmailRecord);
  }

  attachments(emailUid: string, options?: CallOptions): Promise<StoredAttachment[]> {
    return this.#request('GET', `/transactional/attachments/${emailUid}`, options).then(parseAttachments);
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    options: CallOptions | undefined,
    body?: WireMessage,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const secret = secrets.get(this);
    if (secret === undefined) {
      throw new ConfigurationError('apiKey must not be empty');
    }
    const timeoutMs = timeoutInRange(options?.timeoutMs ?? this.#timeoutMs);
    const deadline = AbortSignal.timeout(timeoutMs);
    const deadlineAt = this.#now() + timeoutMs;
    const signal = options?.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
    const attempts = method === 'GET' ? this.#getRetryLimit + 1 : 1;
    const url = endpoint(this.#baseUrl, path, query);
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const bodyBytes = bodyText === undefined ? undefined : new TextEncoder().encode(bodyText);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal.aborted) {
        throw deadlineError(method, signal, secret);
      }

      this.#log('info', 'Mail Blaze transactional API request', {
        method,
        path,
        attempt,
      });

      const init: RequestInit = {
        method,
        headers: requestHeaders(secret, bodyBytes !== undefined),
        redirect: 'error',
        credentials: 'omit',
        signal,
      };
      if (bodyBytes !== undefined) {
        init.body = bodyBytes;
      }
      const request = new Request(url, init);

      let response: Response;
      try {
        response = await this.#fetch(request);
      } catch (error) {
        if (signal.aborted) {
          throw deadlineError(method, signal, secret);
        }
        const reason = classifyFailure(error);
        this.#log('error', 'Mail Blaze transactional API transport failure', {
          message: 'The HTTP client could not complete the request',
          reason,
        });
        const transport = new TransportError(reason, transportFailureMessage(method, reason), secret, error);
        if (
          method !== 'GET' ||
          attempt === attempts ||
          reason === 'redirect' ||
          !(await this.#wait(attempt, undefined, signal, secret, method, deadlineAt))
        ) {
          throw transport;
        }
        continue;
      }

      if (response.redirected || (response.url !== '' && response.url !== url)) {
        throw new TransportError(
          'redirect',
          'The Mail Blaze API response came from a different URL. This client does not follow redirects.',
          secret,
        );
      }

      const status = response.status;
      if (status >= 300 && status < 400) {
        await cancelQuietly(() => response.body?.cancel());
        throw new ApiError('The Mail Blaze API returned an unexpected redirect', status, undefined, undefined, secret);
      }

      let limited: LimitedBody;
      try {
        limited = await readLimited(response, this.#maxResponseBytes);
      } catch (error) {
        if (signal.aborted) {
          throw deadlineError(method, signal, secret);
        }
        if (method === 'POST' && status >= 200 && status < 300) {
          throw unconfirmed(status, secret, error);
        }
        if (
          method === 'GET' &&
          attempt < attempts &&
          isRetryableGetStatus(status) &&
          (await this.#wait(attempt, response, signal, secret, method, deadlineAt))
        ) {
          continue;
        }
        if (status >= 400) {
          throw mapError(status, { error: 'The Mail Blaze API returned an unexpected response' }, secret);
        }
        throw new TransportError('response', transportFailureMessage(method, 'response'), secret, error);
      }

      if (limited.overflow !== undefined) {
        if (status >= 200 && status < 300) {
          const tooLarge = new ResponseTooLargeError({
            maxBytes: this.#maxResponseBytes,
            status,
            receivedBytes: limited.overflow.receivedBytes,
            declaredBytes: limited.overflow.declaredBytes,
            declaredHeader: limited.overflow.declaredHeader,
          });
          if (method === 'POST') {
            throw unconfirmed(status, secret, tooLarge);
          }
          throw tooLarge;
        }
        // Status wins over size: the oversized body is discarded and the status maps as usual.
        this.#log('info', 'Mail Blaze transactional API response', {
          method,
          path,
          status,
          code: null,
        });
        if (
          method === 'GET' &&
          RETRYABLE_GET_STATUS.has(status) &&
          attempt < attempts &&
          (await this.#wait(attempt, response, signal, secret, method, deadlineAt))
        ) {
          continue;
        }
        throw mapError(
          status,
          {
            error: `The Mail Blaze API returned HTTP ${status} with a body larger than the client limit of ${this.#maxResponseBytes} bytes. The body was not read`,
          },
          secret,
        );
      }

      // A retryable GET status is retried before its body is decoded.
      if (method === 'GET' && RETRYABLE_GET_STATUS.has(status) && attempt < attempts) {
        this.#log('info', 'Mail Blaze transactional API response', {
          method,
          path,
          status,
        });
        if (await this.#wait(attempt, response, signal, secret, method, deadlineAt)) {
          continue;
        }
      }

      let decoded: Record<string, unknown>;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(limited.bytes);
        if (text.length === 0) {
          throw new SyntaxError('The Mail Blaze API response was empty');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          // JSON.parse quotes the body in its message. Use a fixed message so no response text reaches the error or its cause.
          throw new SyntaxError('The Mail Blaze API response was not valid JSON');
        }
        if (!isRecord(parsed)) {
          throw new SyntaxError('The Mail Blaze API response was not a JSON object');
        }
        decoded = parsed;
      } catch (error) {
        if (method === 'POST' && status >= 200 && status < 300) {
          throw unconfirmed(status, secret, error);
        }
        // An empty, truncated, or non-object 2xx body is a stalled response, same as 500/502/503/504.
        if (
          method === 'GET' &&
          attempt < attempts &&
          isRetryableGetStatus(status) &&
          (await this.#wait(attempt, response, signal, secret, method, deadlineAt))
        ) {
          continue;
        }
        throw mapError(status, { error: 'The Mail Blaze API returned an unexpected response' }, secret);
      }

      const code = typeof decoded['code'] === 'string' ? decoded['code'] : null;
      this.#log('info', 'Mail Blaze transactional API response', {
        method,
        path,
        status,
        code,
      });

      if (status >= 400 || decoded['status'] === 'error') {
        throw mapError(status, decoded, secret);
      }
      if (status < 200 || status >= 300) {
        throw new ApiError('The Mail Blaze API returned an unexpected response', status, undefined, undefined, secret);
      }

      return decoded;
    }

    throw new TransportError('unknown', transportFailureMessage(method, 'unknown'), secret);
  }

  #log(
    level: 'info' | 'warn' | 'error',
    message: string,
    fields: Record<string, string | number | boolean | null>,
  ): void {
    try {
      this.#logger?.[level]?.(message, fields);
    } catch {
      // A logger must never change the outcome of a request.
    }
  }

  /**
   * Wait before the next GET attempt: the server's `Retry-After` (seconds or an HTTP date)
   * when it sends one, otherwise `retryDelayMs * 2^(attempt - 1)`, capped at 60 seconds, plus a small
   * random jitter. Returns false, without waiting, when the wait would end at or after the request
   * deadline; the caller then returns the current error.
   */
  async #wait(
    attempt: number,
    response: Response | undefined,
    signal: AbortSignal,
    secret: string | undefined,
    method: 'GET' | 'POST',
    deadlineAt: number,
  ): Promise<boolean> {
    const retryAfter = response === undefined ? undefined : retryAfterMs(response, this.#now());
    const backoff = this.#retryDelayMs * 2 ** (attempt - 1);
    const pause = Math.min(retryAfter ?? backoff, MAX_RETRY_WAIT_MS) + this.#jitterMs();
    if (!(this.#now() + pause < deadlineAt)) {
      return false;
    }
    if (pause > 0) {
      try {
        await this.#sleep(pause, signal);
      } catch (error) {
        if (signal.aborted) {
          throw deadlineError(method, signal, secret);
        }
        throw error;
      }
    }
    if (signal.aborted) {
      throw deadlineError(method, signal, secret);
    }

    return true;
  }
}export function normalizeBaseUrl(input: string): string {
  if (typeof input !== 'string') {
    throw new ConfigurationError('baseUrl must be an https URL');
  }
  const trimmed = trimAscii(input);
  // WHATWG URL parsing rewrites backslashes, tabs, and line breaks, and drops an empty query or fragment.
  // Reject those characters (and #) so the URL is not accepted in a form the constructor did not see.
  if (trimmed === '' || /[\\\u0000-\u0020\u007F#]/.test(trimmed)) {
    throw new ConfigurationError('baseUrl must be an https URL');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigurationError('baseUrl must be an https URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
    throw new ConfigurationError('baseUrl must be an https URL');
  }
  if (!isAcceptableHost(rawHost(trimmed), url.hostname)) {
    throw new ConfigurationError(
      'baseUrl host must be a hostname, a public IP address, or loopback. Private, link-local, reserved, and non-standard numeric IP hosts are rejected',
    );
  }
  if (url.protocol !== 'https:') {
    throw new ConfigurationError('baseUrl must use https');
  }
  if (url.username !== '' || url.password !== '' || trimmed.includes('?')) {
    throw new ConfigurationError('baseUrl must not contain credentials or a query string');
  }

  const path = url.pathname.replace(/\/+$/, '');

  return `${url.origin}${path}`;
}
/**
 * The host exactly as written, before WHATWG URL parsing rewrites numeric forms such as
 * `0x7f.1` or `2130706433` into dotted IPv4. Userinfo and port are removed.
 */
function rawHost(input: string): string {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:[/\\]{2}([^/\\?#]*)/.exec(input.trim())?.[1] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');

  return colon === -1 ? host : host.slice(0, colon);
}

/** Whether the host is a hostname, a public IP address, or loopback. */
function isAcceptableHost(host: string, normalized: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    if (inner === '' || !isIPv6(inner)) {
      return false;
    }

    return isAllowedIp(normalized.slice(1, -1));
  }
  if (isIPv4(host)) {
    return isAllowedIp(host);
  }
  // A hostname whose last label is numeric is an IP address in another notation, such as
  // 0x7f.1, 2130706433, 127.1, or 0177.0.0.1. No public top-level domain is numeric.
  const labels = host.replace(/\.+$/, '').split('.');
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/i.test(labels[labels.length - 1] ?? '')) {
    return false;
  }

  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(host);
}

/**
 * Loopback `127.0.0.1` and `::1` are allowed. Otherwise private and reserved ranges are rejected.
 */
function isAllowedIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') {
    return true;
  }
  if (isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return !(
      a === 0 || // 0.0.0.0/8 this network
      a === 10 || // 10.0.0.0/8 private
      a === 127 || // 127.0.0.0/8 loopback (only 127.0.0.1 is allowed above)
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local, including cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
      (a === 192 && b === 168) || // 192.168.0.0/16 private
      a >= 240 // 240.0.0.0/4 reserved and 255.255.255.255 broadcast
    );
  }
  const groups = ipv6Groups(ip);
  if (groups === undefined) {
    return false;
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  return !(
    (zeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) || // :: unspecified and ::1 loopback
    (zeroPrefix && g5 === 0xffff) || // ::ffff:0:0/96 IPv4-mapped
    (g0 >= 0xfc00 && g0 <= 0xfdff) || // fc00::/7 unique local
    (g0 >= 0xfe80 && g0 <= 0xfebf) // fe80::/10 link-local
  );
}

function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4 !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number);
    text = `${text.slice(0, -v4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' && halves[1] !== undefined ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return undefined;
  }

  return parts.map((part) => Number.parseInt(part, 16));
}

function endpoint(baseUrl: string, path: string, query?: Record<string, string>): string {
  const relative = path.replace(/^\/+/, '');
  const parts = relative.split('/');
  if (relative.length === 0 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new ConfigurationError('The request path is invalid');
  }

  const url = new URL(relative, `${baseUrl}/`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  if (!url.href.startsWith(`${baseUrl}/`)) {
    throw new ConfigurationError('The request URL left the configured base URL');
  }

  return url.href;
}

function requestHeaders(secret: string | undefined, json: boolean): Headers {
  const headers = new Headers({
    accept: 'application/json',
    authorization: secret ?? '',
    'user-agent': `mailblaze-transactional-node-sdk/${VERSION}`,
  });
  if (json) {
    headers.set('content-type', 'application/json');
  }

  return headers;
}

interface LimitedBody {
  bytes: Uint8Array;
  /** Set when the body exceeded the limit. The rest of the body was cancelled, and `bytes` is empty. */
  overflow:
    | { receivedBytes: number | undefined; declaredBytes: number | undefined; declaredHeader: string | undefined }
    | undefined;
}

async function readLimited(response: Response, maxBytes: number): Promise<LimitedBody> {
  // An unparsable Content-Length is ignored here. The limit is still enforced by counting streamed bytes.
  const header = response.headers.get('content-length')?.trim();
  const numeric = header !== undefined && /^\d+$/.test(header) ? header : undefined;
  const declared = numeric === undefined ? undefined : Number(numeric);
  // A value past Number.MAX_SAFE_INTEGER is still rejected, but it cannot be reported exactly as a number.
  const declaredBytes = declared !== undefined && Number.isSafeInteger(declared) ? declared : undefined;
  const declaredHeader = declared !== undefined && declaredBytes === undefined ? numeric : undefined;
  if (declared !== undefined && declared > maxBytes) {
    await cancelQuietly(() => response.body?.cancel());
    return { bytes: new Uint8Array(), overflow: { receivedBytes: undefined, declaredBytes, declaredHeader } };
  }

  const body = response.body;
  if (body === null) {
    return { bytes: new Uint8Array(), overflow: undefined };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > maxBytes) {
      await cancelQuietly(() => reader.cancel());
      return { bytes: new Uint8Array(), overflow: { receivedBytes: total, declaredBytes, declaredHeader } };
    }
    chunks.push(next.value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: out, overflow: undefined };
}

async function cancelQuietly(cancel: () => Promise<void> | undefined): Promise<void> {
  try {
    await cancel();
  } catch {
    // The body is being discarded. A failed cancel does not change the result.
  }
}

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '\\d{2}:\\d{2}:\\d{2}';
/** RFC 7231 HTTP-date: IMF-fixdate, plus the obsolete RFC 850 and asctime forms. */
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`);
const RFC_850_DATE = new RegExp(`^${LONG_DAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} (?: \\d|\\d{2}) ${TIME} \\d{4}$`);

/**
 * `Retry-After` as delta-seconds (digits only) or an HTTP-date, capped at 60 seconds. Anything else,
 * such as `-5`, `+5`, `1e3`, or `1.5`, is ignored and the normal backoff applies.
 */
function retryAfterMs(response: Response, now: number): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  if (header === undefined || header === '') {
    return undefined;
  }
  if (/^\d+$/.test(header)) {
    const ms = Number(header) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, MAX_RETRY_WAIT_MS) : MAX_RETRY_WAIT_MS;
  }
  let date = Number.NaN;
  if (IMF_FIXDATE.test(header) || RFC_850_DATE.test(header)) {
    date = Date.parse(header);
  } else if (ASCTIME_DATE.test(header)) {
    // asctime has no zone but is always UTC.
    date = Date.parse(`${header} GMT`);
  }
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, date - now));
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, Math.min(ms, MAX_TIMER_MS));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    function finish(): void {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

function deadlineError(method: 'GET' | 'POST', signal: AbortSignal, secret: string | undefined): TransportError {
  const name = signal.reason instanceof DOMException ? signal.reason.name : '';
  const reason: TransportReason = name === 'TimeoutError' ? 'timeout' : 'abort';

  return new TransportError(reason, transportFailureMessage(method, reason), secret, signal.reason);
}

function unconfirmed(status: number, secret: string | undefined, cause?: unknown): UnconfirmedSendError {
  return new UnconfirmedSendError(
    `The Mail Blaze API returned HTTP ${status}, but the response could not be read. ${UNCONFIRMED_HINT}`,
    status,
    secret,
    cause,
  );
}
/**
 * Sort a fetch failure into a transport reason, from the error, its causes, and their codes.
 * Only the category is derived here. The messages themselves are redacted separately.
 */
function classifyFailure(error: unknown): TransportReason {
  if (mentionsRedirect(error)) {
    return 'redirect';
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth >= 5 || typeof value !== 'object' || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const key of ['name', 'message', 'code'] as const) {
      const field: unknown = (value as Record<string, unknown>)[key];
      if (typeof field === 'string') {
        parts.push(field);
      }
    }
    if (value instanceof AggregateError) {
      for (const inner of value.errors.slice(0, 5)) {
        visit(inner, depth + 1);
      }
    }
    if ('cause' in value) {
      visit(value.cause, depth + 1);
    }
  };
  visit(error, 0);
  const text = ` ${parts.join(' ')} `;

  if (/timed?[ _-]?out|timeout/i.test(text)) {
    return 'timeout';
  }
  if (/resolve|getaddrinfo|name or service not known|no such host|nodename nor servname|\bENOTFOUND\b|\bEAI_[A-Z]+\b/i.test(text)) {
    return 'dns';
  }
  if (/\bssl\b|\btls\b|certificate|\bCERT_|\bERR_(?:TLS|SSL)_|\bUNABLE_TO_(?:VERIFY|GET)|SELF_SIGNED|\bDEPTH_ZERO/i.test(text)) {
    return 'tls';
  }
  // fetch() rejects with a TypeError for any network error.
  if (
    error instanceof TypeError ||
    /connect|refused|unreachable|reset by peer|\bECONNRESET\b|\bEPIPE\b|\bUND_ERR_SOCKET\b|socket hang up|other side closed/i.test(text)
  ) {
    return 'connect';
  }
  if (error instanceof Error) {
    return 'client';
  }

  return 'unknown';
}
/** "The Mail Blaze API request could not be completed (<reason>)". */
function transportFailureMessage(method: 'GET' | 'POST', reason: TransportReason): string {
  if (reason === 'redirect') {
    return 'The Mail Blaze API returned a redirect, which this client refuses (redirect)';
  }
  const message = `The Mail Blaze API request could not be completed (${reason})`;
  // A send that did not complete may still have reached the API.
  return method === 'POST' && reason !== 'abort' ? `${message}. ${UNCONFIRMED_HINT}` : message;
}
function mentionsRedirect(error: unknown, seen = new Set<unknown>()): boolean {
  if (typeof error !== 'object' || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof Error && /redirect/i.test(error.message)) {
    return true;
  }
  if ('cause' in error) {
    return mentionsRedirect(error.cause, seen);
  }

  return false;
}

function isRetryableGetStatus(status: number): boolean {
  return (status >= 200 && status < 300) || RETRYABLE_GET_STATUS.has(status);
}

/** Context keys whose values are replaced, including `headers`. */
const SENSITIVE_LOG_KEY = /authorization|api[-_]?key|html|plain|body|secret|attachment|password|headers/i;

function safeLogger(logger: Logger, secret: string): Logger {
  const write = (
    level: 'info' | 'warn' | 'error',
    message: string,
    fields?: Readonly<Record<string, string | number | boolean | null>>,
  ): void => {
    try {
      const fn = logger[level];
      if (typeof fn !== 'function') {
        return;
      }
      const safe: Record<string, string | number | boolean | null> = {};
      if (fields !== undefined) {
        for (const [key, value] of Object.entries(fields)) {
          if (SENSITIVE_LOG_KEY.test(key)) {
            safe[key] = '[redacted]';
            continue;
          }
          safe[key] = typeof value === 'string' ? redact(value, secret) : value;
        }
      }
      const result: unknown = fn.call(logger, redact(message, secret), safe);
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        // An async logger that rejects must not become an unhandled rejection.
        Promise.resolve(result).catch(() => {});
      }
    } catch {
      // A logger must never change the outcome of a request.
    }
  };

  return {
    info: (message, fields) => {
      write('info', message, fields);
    },
    warn: (message, fields) => {
      write('warn', message, fields);
    },
    error: (message, fields) => {
      write('error', message, fields);
    },
  };
}

function timeoutInRange(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new ConfigurationError(`timeoutMs must be greater than zero and no more than ${MAX_TIMEOUT_MS} milliseconds`);
  }

  return value;
}
function finiteInRange(value: number, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigurationError(`${label} must be from ${min} to ${max}`);
  }

  return value;
}

function integerInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new ConfigurationError(`${label} must be an integer from ${min} to ${max}`);
  }

  return finiteInRange(value, min, max, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
