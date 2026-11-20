import { ValidationError } from './errors.ts';

/** Line breaks rejected in header fields. */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
/** C0 and C1 control characters (Unicode category Cc). */
const CONTROL = /\p{Cc}/u;
/**
 * Bidirectional embeddings, overrides, and isolates, and invisible characters.
 * LRM, RLM, ALM, ZWNJ, and ZWJ are allowed because Hebrew, Arabic, emoji, and several scripts need them.
 */
const HIDDEN_HEADER = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
/**
 * Email address pattern, based on a regex by Michael Rushton, Copyright (c) Michael Rushton 2009-10.
 * ASCII only (no Unicode local parts).
 */
const EMAIL_PATTERN =
  /^(?!(?:(?:\x22?\x5C[\x00-\x7E]\x22?)|(?:\x22?[^\x5C\x22]\x22?)){255,})(?!(?:(?:\x22?\x5C[\x00-\x7E]\x22?)|(?:\x22?[^\x5C\x22]\x22?)){65,}@)(?:(?:[\x21\x23-\x27\x2A\x2B\x2D\x2F-\x39\x3D\x3F\x5E-\x7E]+)|(?:\x22(?:[\x01-\x08\x0B\x0C\x0E-\x1F\x21\x23-\x5B\x5D-\x7F]|(?:\x5C[\x00-\x7F]))*\x22))(?:\.(?:(?:[\x21\x23-\x27\x2A\x2B\x2D\x2F-\x39\x3D\x3F\x5E-\x7E]+)|(?:\x22(?:[\x01-\x08\x0B\x0C\x0E-\x1F\x21\x23-\x5B\x5D-\x7F]|(?:\x5C[\x00-\x7F]))*\x22)))*@(?:(?:(?!.*[^.]{64,})(?:(?:(?:xn--)?[a-z0-9]+(?:-+[a-z0-9]+)*\.){1,126}){1,}(?:(?:[a-z][a-z0-9]*)|(?:(?:xn--)[a-z0-9]+))(?:-+[a-z0-9]+)*)|(?:\[(?:(?:IPv6:(?:(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){7})|(?:(?!(?:.*[a-f0-9][:\]]){7,})(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,5})?::(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,5})?)))|(?:(?:IPv6:(?:(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){5}:)|(?:(?!(?:.*[a-f0-9]:){5,})(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,3})?::(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,3}:)?)))?(?:(?:25[0-5])|(?:2[0-4][0-9])|(?:1[0-9]{2})|(?:[1-9]?[0-9]))(?:\.(?:(?:25[0-5])|(?:2[0-4][0-9])|(?:1[0-9]{2})|(?:[1-9]?[0-9]))){3}))\]))$/i;
/** Addresses longer than this are rejected before the pattern is run. */
const MAX_EMAIL_LENGTH = 320;

/** Trim leading and trailing space, tab, LF, CR, NUL, and vertical tab only. */
export function trimAscii(value: string): string {
  return value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

function assertUtf8(value: string, label: string): void {
  if (!value.isWellFormed()) {
    throw new ValidationError(`${label} must be valid UTF-8`);
  }
}

/**
 * Reject line breaks, controls, and hidden characters. Do not remove them and continue.
 * Leading and trailing spaces are trimmed.
 */
export function assertHeaderField(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be a string`);
  }
  assertUtf8(value, label);
  if (LINE_BREAK.test(value)) {
    throw new ValidationError(`${label} must not contain line breaks`);
  }
  if (CONTROL.test(value)) {
    throw new ValidationError(`${label} must not contain control characters`);
  }
  if (HIDDEN_HEADER.test(value)) {
    throw new ValidationError(`${label} must not contain bidirectional override or invisible characters`);
  }
  const trimmed = trimAscii(value);
  if (trimmed === '') {
    throw new ValidationError(`${label} must not be empty`);
  }

  return trimmed;
}

export function assertEmail(value: unknown, label: string): string {
  const address = assertHeaderField(value, label);
  if (address.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(address)) {
    throw new ValidationError(`${label} must be a valid email address`);
  }
  // A quoted local part such as "a,b"@example.com passes the pattern. Cc and Bcc are one
  // comma-separated string, so a comma, semicolon, or angle bracket would split or disguise an address.
  if (/[,;<>]/.test(address)) {
    throw new ValidationError(`${label} must not contain commas, semicolons, or angle brackets`);
  }

  return address;
}

/**
 * `cc` and `bcc` are one string on the wire. Spaces around commas are list
 * separators. A line break is rejected before any trimming.
 */
export function assertAddressList(value: string | readonly string[], label: string): string {
  if (typeof value === 'string') {
    if (LINE_BREAK.test(value)) {
      throw new ValidationError(`${label} must not contain line breaks`);
    }
    if (CONTROL.test(value)) {
      throw new ValidationError(`${label} must not contain control characters`);
    }
  }

  const parts = typeof value === 'string' ? value.split(',') : value;
  if (parts.length === 0) {
    throw new ValidationError(`${label} must include an email address`);
  }

  const addresses: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') {
      throw new ValidationError(`${label} must be an email address`);
    }
    addresses.push(assertEmail(part, label));
  }

  return addresses.join(',');
}

/** Filename checks: no path, no controls or formatting characters, max 255 bytes. */
export function assertFilename(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('Attachment filename must be a string');
  }
  if (!value.isWellFormed()) {
    throw new ValidationError('Attachment filename must be valid UTF-8');
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new ValidationError('Attachment filename must not include a path');
  }
  if (/[\p{Cc}\u0085\u2028\u2029]/u.test(value)) {
    throw new ValidationError('Attachment filename must not contain line breaks or control characters');
  }
  // Format characters include bidirectional overrides such as U+202E, which can disguise an extension.
  if (/\p{Cf}/u.test(value)) {
    throw new ValidationError('Attachment filename must not contain hidden or formatting characters');
  }
  const name = trimAscii(value);
  if (Buffer.byteLength(name) > 255) {
    throw new ValidationError('Attachment filename is too long');
  }
  if (name === '' || name === '.' || name === '..') {
    throw new ValidationError('Attachment filename is invalid');
  }

  return name;
}

export function assertMergeTagName(name: string): void {
  if (!/^[A-Z0-9_]+$/.test(name)) {
    throw new ValidationError('Merge tag names must match [A-Z0-9_]');
  }
}

export function assertEmailUid(emailUid: string): string {
  if (typeof emailUid !== 'string' || !/^[A-Za-z0-9_-]+$/.test(emailUid)) {
    throw new ValidationError('emailUid is invalid');
  }

  return emailUid;
}

export function mergeTagValue(value: string | number | boolean | null): string {
  if (typeof value === 'string') {
    assertUtf8(value, 'Merge tag value');

    return value;
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (value === null) {
    return '';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  throw new ValidationError('Merge tag values must be a string, number, boolean, or null');
}