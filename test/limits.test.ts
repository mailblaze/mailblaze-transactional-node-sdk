import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTACHMENT_ENCODED_BYTES, MAX_TOTAL_ENCODED_BYTES } from '../src/constants.ts';
import { assertAttachmentEncodedLength } from '../src/base64.ts';
import { ValidationError } from '../src/errors.ts';
import { buildMessage } from '../src/message.ts';

const base = {
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Invoice',
  html: '<p>Invoice</p>',
};

test('an encoded attachment of exactly 10 MiB is accepted and one more encoded byte is rejected', () => {
  assert.doesNotThrow(() => assertAttachmentEncodedLength(MAX_ATTACHMENT_ENCODED_BYTES));
  assert.throws(() => assertAttachmentEncodedLength(MAX_ATTACHMENT_ENCODED_BYTES + 1), ValidationError);

  const exact = Buffer.alloc(7_864_320, 0x61);
  const wire = buildMessage({
    ...base,
    attachments: [{ filename: 'exact.bin', data: exact }],
  });
  assert.equal(wire.attachments?.[0]?.data.length, MAX_ATTACHMENT_ENCODED_BYTES);

  const over = Buffer.alloc(7_864_321, 0x61);
  assert.throws(
    () => buildMessage({ ...base, attachments: [{ filename: 'over.bin', data: over }] }),
    ValidationError,
  );
});

test('the client total encoded cap is 15 MiB', () => {
  const one = Buffer.alloc(7_864_320, 0x62);
  assert.throws(
    () =>
      buildMessage({
        ...base,
        attachments: [
          { filename: 'one.bin', data: one },
          { filename: 'two.bin', data: one },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.match(
        error.message,
        new RegExp(
          `exceeds the client-side limit of ${MAX_TOTAL_ENCODED_BYTES} encoded bytes\\. The API also enforces a 10 MiB per-attachment limit\\.`,
        ),
      );
      return true;
    },
  );
});
