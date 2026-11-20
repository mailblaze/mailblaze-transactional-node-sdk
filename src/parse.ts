import { strictDecodeBase64 } from './base64.ts';
import { ApiError, UnconfirmedSendError, ValidationError } from './errors.ts';
import type { EmailPage, EmailRecord, EmailSummary, SendResult, StoredAttachment } from './types.ts';

export function parseSendResult(payload: unknown, secret: string | undefined): SendResult {
  const record = objectValue(payload, 'response');
  const emailUid = requiredString(record['email_uid'], 'email_uid');
  const code = requiredString(record['code'], 'code');
  const warning = record['warning'];
  if (warning !== null && warning !== undefined && typeof warning !== 'string') {
    throw new UnconfirmedSendError(
      'The Mail Blaze API accepted the request, but the response could not be read. The email may already have been accepted. Check the list before sending it again.',
      undefined,
      secret,
    );
  }

  return {
    emailUid,
    code,
    accepted: true,
    warning: typeof warning === 'string' ? warning : null,
  };
}

export function parseEmailPage(payload: unknown): EmailPage {
  const record = objectValue(payload, 'response');
  const data = objectValue(record['data'], 'data');
  const rows = data['records'];
  if (!Array.isArray(rows)) {
    throw new ApiError('The Mail Blaze API returned an unexpected records payload');
  }

  const records: EmailSummary[] = rows.map((row) => {
    const item = objectValue(row, 'record');

    return {
      emailUid: requiredString(item['email_uid'], 'email_uid'),
      toEmail: text(item['to_email'], 'to_email'),
      subject: text(item['subject'], 'subject'),
      status: text(item['status'], 'status'),
    };
  });

  return {
    code: requiredString(record['code'], 'code'),
    count: optionalCount(data['count'], 'count'),
    totalPages: optionalCount(data['total_pages'], 'total_pages'),
    currentPage: optionalCount(data['current_page'], 'current_page'),
    nextPage: optionalCount(data['next_page'], 'next_page'),
    prevPage: optionalCount(data['prev_page'], 'prev_page'),
    records,
  };
}

export function parseEmailRecord(payload: unknown): EmailRecord {
  const data = objectValue(objectValue(payload, 'response')['data'], 'data');
  const record = objectValue(data['record'], 'record');
  const sendAt = record['send_at'];
  if (
    sendAt !== null &&
    sendAt !== undefined &&
    typeof sendAt !== 'string' &&
    !(typeof sendAt === 'number' && Number.isSafeInteger(sendAt))
  ) {
    throw new ApiError('The Mail Blaze API returned an unexpected send_at');
  }

  return {
    emailUid: requiredString(record['email_uid'], 'email_uid'),
    toEmail: text(record['to_email'], 'to_email'),
    toName: text(record['to_name'], 'to_name'),
    fromEmail: text(record['from_email'], 'from_email'),
    fromName: text(record['from_name'], 'from_name'),
    subject: text(record['subject'], 'subject'),
    body: nullableText(record['body'], 'body'),
    plainText: nullableText(record['plain_text'], 'plain_text'),
    category: nullableText(record['category'], 'category'),
    sendAt: sendAt ?? null,
    status: text(record['status'], 'status'),
  };
}

export function parseAttachments(payload: unknown): StoredAttachment[] {
  const data = objectValue(payload, 'response')['data'];
  if (!Array.isArray(data)) {
    throw new ApiError('The Mail Blaze API returned an unexpected attachment payload');
  }

  return data.map((item) => {
    const file = objectValue(item, 'attachment');
    const name = requiredString(file['name'], 'name');
    let data: Uint8Array;
    try {
      data = strictDecodeBase64(requiredString(file['data'], 'data'), 'Attachment data');
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ApiError('The Mail Blaze API returned attachment data that is not strict base64');
      }
      throw error;
    }

    return { name, data };
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(`The Mail Blaze API returned an unexpected ${label}`);
  }

  return value as Record<string, unknown>;
}

/** A non-empty string. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(`The Mail Blaze API returned an unexpected ${label}`);
  }

  return value;
}

/** Any string, including empty. */
function text(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(`The Mail Blaze API returned an unexpected ${label}`);
  }

  return value;
}

/** A string or null. */
function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return text(value, label);
}

function optionalCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value === 0 ? 0 : value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new ApiError(`The Mail Blaze API returned an invalid ${label}. Page counts must be non-negative safe integers.`);
}