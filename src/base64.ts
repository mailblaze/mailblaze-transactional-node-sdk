import { MAX_ATTACHMENT_ENCODED_BYTES } from './constants.ts';
import { ValidationError } from './errors.ts';

export function strictBase64(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString('base64');
  if (encoded.includes('\n') || encoded.includes('\r')) {
    throw new ValidationError('Content could not be encoded as strict base64');
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (!decoded.equals(Buffer.from(bytes)) || decoded.toString('base64') !== encoded) {
    throw new ValidationError('Content could not be encoded as strict base64');
  }

  return encoded;
}

export function assertAttachmentEncodedLength(encodedBytes: number): void {
  if (encodedBytes > MAX_ATTACHMENT_ENCODED_BYTES) {
    throw new ValidationError(
      'Attachment exceeds the 10MB size limit',
      undefined,
      '150.005',
      'Attachment exceeds the 10MB size limit',
    );
  }
}

/**
 * Decode attachment bytes returned by the API. The server sends strict base64.
 */
export function strictDecodeBase64(encoded: string, label: string): Uint8Array {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new ValidationError(`${label} is not strict base64`);
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new ValidationError(`${label} is not strict base64`);
  }

  return new Uint8Array(decoded);
}

export function asBytes(value: string | Buffer | Uint8Array, label: string): Uint8Array {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) {
      throw new ValidationError(`${label} must be valid UTF-8`);
    }

    return Buffer.from(value, 'utf8');
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  throw new ValidationError(`${label} must be a string, Buffer, or Uint8Array`);
}
