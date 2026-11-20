import { VERSION, MIN_PER_PAGE, MAX_PER_PAGE } from './constants.ts';
import { ConfigurationError, ValidationError } from './errors.ts';
import { Transport } from './http.ts';
import { buildMessage } from './message.ts';
import { assertServerRuntime } from './runtime.ts';
import type {
  CallOptions,
  EmailPage,
  EmailRecord,
  ListQuery,
  MailBlazeOptions,
  OutgoingEmail,
  SendResult,
  StoredAttachment,
} from './types.ts';
import { assertEmailUid } from './validate.ts';

const inspect = Symbol.for('nodejs.util.inspect.custom');

/**
 * Official client for the Mail Blaze transactional API.
 * Reuse one instance. A send is accepted and queued; it is not confirmed as delivered.
 */
export class MailBlaze {
  static readonly VERSION = VERSION;

  readonly #transport: Transport;

  constructor(options: MailBlazeOptions) {
    assertServerRuntime();
    if (options === null || typeof options !== 'object') {
      throw new ConfigurationError('options must be an object with an apiKey');
    }
    const transportOptions: MailBlazeOptions = { apiKey: options.apiKey };
    if (options.baseUrl !== undefined) {
      transportOptions.baseUrl = options.baseUrl;
    }
    if (options.timeoutMs !== undefined) {
      transportOptions.timeoutMs = options.timeoutMs;
    }
    if (options.fetch !== undefined) {
      transportOptions.fetch = options.fetch;
    }
    if (options.logger !== undefined) {
      transportOptions.logger = options.logger;
    }
    if (options.getRetryLimit !== undefined) {
      transportOptions.getRetryLimit = options.getRetryLimit;
    }
    if (options.retryDelayMs !== undefined) {
      transportOptions.retryDelayMs = options.retryDelayMs;
    }
    if (options.maxResponseBytes !== undefined) {
      transportOptions.maxResponseBytes = options.maxResponseBytes;
    }
    this.#transport = new Transport(transportOptions);
  }

  /** Queue an email. The returned id means the API accepted it, not that it was delivered. */
  send(message: OutgoingEmail, options?: CallOptions): Promise<SendResult> {
    return this.#transport.send(buildMessage(message), options);
  }

  /**
   * List queued and sent transactional emails.
   * `perPage` is clamped to 10–50. The default is 10. `page` starts at 1.
   */
  list(query: ListQuery = {}, options?: CallOptions): Promise<EmailPage> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? MIN_PER_PAGE;
    if (!Number.isInteger(page)) {
      throw new ValidationError('page must be an integer');
    }
    if (page < 1) {
      throw new ValidationError('page must be at least 1');
    }
    // Any integer perPage is clamped to 10-50.
    if (!Number.isInteger(perPage)) {
      throw new ValidationError('perPage must be an integer');
    }

    return this.#transport.list(page, Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, perPage)), options);
  }

  get(emailUid: string, options?: CallOptions): Promise<EmailRecord> {
    return this.#transport.get(assertEmailUid(emailUid), options);
  }

  attachments(emailUid: string, options?: CallOptions): Promise<StoredAttachment[]> {
    return this.#transport.attachments(assertEmailUid(emailUid), options);
  }

  toJSON(): { version: string } {
    return { version: VERSION };
  }

  [inspect](): string {
    return `MailBlaze { version: '${VERSION}' }`;
  }
}
