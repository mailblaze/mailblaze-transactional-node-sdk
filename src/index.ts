export { VERSION } from './constants.ts';
export {
  MAX_ATTACHMENT_ENCODED_BYTES,
  MAX_TOTAL_ENCODED_BYTES,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
} from './constants.ts';
export { attachmentFromPath } from './attachment.ts';
export { MailBlaze } from './client.ts';
export {
  ApiError,
  AuthenticationError,
  ConfigurationError,
  DomainNotVerifiedError,
  MailBlazeError,
  NotFoundError,
  QuotaError,
  RateLimitError,
  ResponseTooLargeError,
  SendFailedError,
  TransportError,
  UnconfirmedSendError,
  ValidationError,
  isMailBlazeError,
} from './errors.ts';
export type { ResponseTooLargeDetails, TransportReason } from './errors.ts';
export { sendAtDateTime } from './send-at.ts';
export type {
  Address,
  AttachmentInput,
  CallOptions,
  EmailPage,
  EmailRecord,
  EmailSummary,
  FetchLike,
  HtmlMessage,
  ListQuery,
  Logger,
  MailBlazeOptions,
  OutgoingEmail,
  ReplyTo,
  SendResult,
  StoredAttachment,
  TemplateMessage,
} from './types.ts';
