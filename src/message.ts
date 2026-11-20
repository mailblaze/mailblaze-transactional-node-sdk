import { asBytes, assertAttachmentEncodedLength, strictBase64 } from './base64.ts';
import { MAX_TOTAL_ENCODED_BYTES } from './constants.ts';
import { ValidationError } from './errors.ts';
import type { OutgoingEmail, WireMessage } from './types.ts';
import {
  assertAddressList,
  assertEmail,
  assertFilename,
  assertHeaderField,
  assertMergeTagName,
  mergeTagValue,
  trimAscii,
} from './validate.ts';

export function buildMessage(message: OutgoingEmail): WireMessage {
  if (message === null || typeof message !== 'object') {
    throw new ValidationError('message must be an object');
  }

  const to = message.to as Partial<OutgoingEmail['to']> | null | undefined;
  const from = message.from as Partial<OutgoingEmail['from']> | null | undefined;
  if (
    to === null ||
    to === undefined ||
    to.email === undefined ||
    to.name === undefined ||
    from === null ||
    from === undefined ||
    from.email === undefined ||
    from.name === undefined ||
    message.subject === undefined
  ) {
    throw new ValidationError('to, from, and subject are required');
  }

  const html = 'html' in message ? message.html : undefined;
  const templateId = 'templateId' in message ? message.templateId : undefined;
  const text = 'text' in message ? message.text : undefined;
  const mergeTags = 'mergeTags' in message ? message.mergeTags : undefined;

  const hasHtml = html !== undefined;
  const hasTemplate = templateId !== undefined;
  if (hasHtml && hasTemplate) {
    throw new ValidationError('html cannot be combined with templateId');
  }
  if (hasTemplate && text !== undefined) {
    throw new ValidationError('templateId cannot be combined with text');
  }
  if (!hasHtml && !hasTemplate) {
    throw new ValidationError(
      'Either html or templateId is required',
      undefined,
      '150.012',
      'Either body or template_id must be provided',
    );
  }
  if (!hasTemplate && mergeTags !== undefined) {
    throw new ValidationError('mergeTags cannot be combined with html');
  }

  const wire: WireMessage = {
    to_email: assertEmail(message.to?.email, 'Recipient email'),
    to_name: assertHeaderField(message.to?.name, 'Recipient name'),
    from_email: assertEmail(message.from?.email, 'From email'),
    from_name: assertHeaderField(message.from?.name, 'From name'),
    subject: assertHeaderField(message.subject, 'Subject'),
  };

  if (message.replyTo !== undefined) {
    wire.reply_to_email = assertEmail(message.replyTo.email, 'Reply-to email');
    if (message.replyTo.name !== undefined) {
      wire.reply_to_name = assertHeaderField(message.replyTo.name, 'Reply-to name');
    }
  }
  if (message.cc !== undefined) {
    wire.cc = assertAddressList(message.cc, 'Cc email');
  }
  if (message.bcc !== undefined) {
    wire.bcc = assertAddressList(message.bcc, 'Bcc email');
  }
  if (message.category !== undefined) {
    wire.category = assertHeaderField(message.category, 'Category');
  }
  if (message.sendAt !== undefined) {
    wire.send_at = serializeSendAt(message.sendAt);
  }

  let encodedTotal = 0;
  const add = (bytes: number, label: string): void => {
    encodedTotal += bytes;
    if (encodedTotal > MAX_TOTAL_ENCODED_BYTES) {
      throw new ValidationError(
        `${label} exceeds the client-side limit of ${MAX_TOTAL_ENCODED_BYTES} encoded bytes. The API also enforces a 10 MiB per-attachment limit.`,
      );
    }
  };
  const count = (encoded: string, label: string): void => {
    add(encoded.length, label);
  };

  if (templateId !== undefined) {
    wire.template_id = assertHeaderField(templateId, 'Template id');
    wire.merge_tags = {};
    if (mergeTags !== undefined) {
      if (mergeTags === null || typeof mergeTags !== 'object' || Array.isArray(mergeTags)) {
        throw new ValidationError('mergeTags must be an object');
      }
      for (const [name, value] of Object.entries(mergeTags)) {
        assertMergeTagName(name);
        const tagValue = mergeTagValue(value);
        // Count merge tags as they go on the wire: JSON-encoded name and value, in UTF-8 bytes.
        add(Buffer.byteLength(JSON.stringify(name)) + Buffer.byteLength(JSON.stringify(tagValue)), `Merge tag ${name}`);
        wire.merge_tags[name] = tagValue;
      }
    }
  } else if (html !== undefined) {
    const htmlBytes = asBytes(html, 'html');
    const htmlText = typeof html === 'string' ? html : new TextDecoder('utf-8', { fatal: false }).decode(htmlBytes);
    if (trimAscii(htmlText) === '') {
      throw new ValidationError('html must not be empty');
    }
    const body = strictBase64(htmlBytes);
    count(body, 'html');
    wire.body = body;
    if (text !== undefined) {
      const plain = strictBase64(asBytes(text, 'text'));
      count(plain, 'text');
      wire.plain_text = plain;
    }
  }

  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) {
      throw new ValidationError('attachments must be an array');
    }
    wire.attachments = message.attachments.map((attachment) => {
      if (attachment === null || typeof attachment !== 'object' || typeof (attachment as { data?: unknown }).data === 'string') {
        throw new ValidationError('Attachment data must be a Buffer or Uint8Array. URLs and file paths are not fetched.');
      }
      const filename = assertFilename(attachment.filename);
      const encoded = strictBase64(asBytes(attachment.data, 'Attachment data'));
      assertAttachmentEncodedLength(encoded.length);
      count(encoded, `Attachment ${filename}`);

      return { name: filename, data: encoded };
    });
  }

  return wire;
}

function serializeSendAt(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError('sendAt is an invalid date');
    }

    // send_at is sent with whole seconds and a numeric offset, for example 2026-11-17T09:00:00+00:00.
    return value.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  }
  if (typeof value !== 'string') {
    throw new ValidationError('sendAt must be a Date or a string');
  }

  return assertHeaderField(value, 'sendAt');
}
