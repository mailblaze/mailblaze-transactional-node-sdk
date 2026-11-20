import { assertAttachmentEncodedLength } from './base64.ts';
import { ConfigurationError, ValidationError } from './errors.ts';
import { assertServerRuntime } from './runtime.ts';
import type { AttachmentInput } from './types.ts';
import { assertFilename } from './validate.ts';

/**
 * Read a file from disk into an attachment.
 * The filename is the last part of the path. The same size and filename rules apply.
 * Node.js only: it needs `node:fs`, and it uses the same `window` and `document` check as the client.
 * Pass a trusted local path. On Windows, a UNC path (`\\host\share`) makes the OS connect to that
 * host and can send your NTLM credentials to it.
 */
export async function attachmentFromPath(path: string): Promise<AttachmentInput> {
  assertServerRuntime();
  if (typeof path !== 'string') {
    throw new ValidationError('Attachment path must be a string');
  }
  if (/[\r\n\0]/.test(path)) {
    throw new ValidationError('Attachment path must not contain line breaks');
  }

  let fs: typeof import('node:fs/promises');
  try {
    fs = await import('node:fs/promises');
  } catch {
    throw new ConfigurationError('attachmentFromPath needs the Node.js file system');
  }

  let size: number;
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) {
      throw new Error('not a file');
    }
    await fs.access(path, fs.constants.R_OK);
    size = stat.size;
  } catch {
    throw new ValidationError('Attachment path is not a readable file');
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ValidationError('Attachment size could not be read');
  }
  assertAttachmentEncodedLength(estimatedEncodedLength(size));

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(path));
  } catch {
    throw new ValidationError('Attachment could not be read');
  }
  // The file may have changed since it was measured.
  assertAttachmentEncodedLength(estimatedEncodedLength(bytes.byteLength));

  const name = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return { filename: assertFilename(name.slice(name.lastIndexOf('/') + 1)), data: bytes };
}

function estimatedEncodedLength(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}