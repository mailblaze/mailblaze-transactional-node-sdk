export interface Address {
  email: string;
  name: string;
}

export interface ReplyTo {
  email: string;
  name?: string;
}

export interface AttachmentInput {
  filename: string;
  /** File bytes. The SDK base64-encodes them. A string path or URL is rejected. */
  data: Buffer | Uint8Array;
}

interface MessageFields {
  to: Address;
  from: Address;
  subject: string;
  replyTo?: ReplyTo;
  /** One address, or several separated by commas. Sent as a single string. */
  cc?: string | readonly string[];
  /** One address, or several separated by commas. Sent as a single string. */
  bcc?: string | readonly string[];
  category?: string;
  /**
   * A `Date` is sent as RFC 3339 with a numeric offset and whole seconds,
   * for example `2026-11-17T09:00:00+00:00`. A string is sent unchanged.
   * A string with no offset is interpreted in the customer account timezone.
   */
  sendAt?: Date | string;
  attachments?: readonly AttachmentInput[];
}

export interface HtmlMessage extends MessageFields {
  html: string | Buffer | Uint8Array;
  text?: string | Buffer | Uint8Array;
  templateId?: never;
  mergeTags?: never;
}

export interface TemplateMessage extends MessageFields {
  templateId: string;
  mergeTags?: Readonly<Record<string, string | number | boolean | null>>;
  html?: never;
  text?: never;
}

export type OutgoingEmail = HtmlMessage | TemplateMessage;

export interface SendResult {
  readonly emailUid: string;
  readonly code: string;
  /** The API accepted the email and queued it. This does not mean it was delivered. */
  readonly accepted: true;
  readonly warning: string | null;
}

export interface EmailSummary {
  readonly emailUid: string;
  readonly toEmail: string;
  readonly subject: string;
  readonly status: string;
}

export interface EmailPage {
  readonly code: string;
  readonly count: number | null;
  readonly totalPages: number | null;
  readonly currentPage: number | null;
  readonly nextPage: number | null;
  readonly prevPage: number | null;
  readonly records: readonly EmailSummary[];
}

export interface EmailRecord {
  readonly emailUid: string;
  readonly toEmail: string;
  readonly toName: string;
  readonly fromEmail: string;
  readonly fromName: string;
  readonly subject: string;
  readonly body: string | null;
  readonly plainText: string | null;
  readonly category: string | null;
  readonly sendAt: string | number | null;
  readonly status: string;
}

export interface StoredAttachment {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ListQuery {
  page?: number;
  perPage?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Logger {
  info?(message: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  warn?(message: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  error?(message: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

/**
 * A fetch implementation you trust. Requests use `redirect: 'error'` and stay
 * on the configured https base URL. The package does not accept a proxy URL.
 */
export type FetchLike = (input: Request, init?: RequestInit) => Promise<Response>;

export interface MailBlazeOptions {
  apiKey: string;
  baseUrl?: string;
  /** Deadline for the whole call, including GET retries. Default 10000 (10 seconds), maximum 120000. */
  timeoutMs?: number;
  fetch?: FetchLike;
  logger?: Logger;
  /** Extra attempts for a safe GET. `POST /transactional` is never retried. Default 2. */
  getRetryLimit?: number;
  /** Base GET backoff: `retryDelayMs * 2^(attempt - 1)`, unless the server sends `Retry-After`. 0–5000, default 200. */
  retryDelayMs?: number;
  /** Largest response body the client reads, in bytes. Default 16 MiB. */
  maxResponseBytes?: number;
}

export interface WireMessage {
  to_email: string;
  to_name: string;
  from_email: string;
  from_name: string;
  subject: string;
  reply_to_email?: string;
  reply_to_name?: string;
  cc?: string;
  bcc?: string;
  category?: string;
  send_at?: string;
  body?: string;
  plain_text?: string;
  template_id?: string;
  merge_tags?: Record<string, string>;
  attachments?: { name: string; data: string }[];
}
