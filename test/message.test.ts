import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailBlaze, ValidationError } from '../src/index.ts';
import { buildMessage } from '../src/message.ts';
import type { OutgoingEmail } from '../src/types.ts';

const base = {
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Your receipt',
} as const;

function htmlMessage(extra: Record<string, unknown> = {}): OutgoingEmail {
  return { ...base, html: '<p>Thanks</p>', ...extra } as OutgoingEmail;
}

test('html and text are strict base64 and template fields are absent', () => {
  const wire = buildMessage(htmlMessage({ text: 'Thanks' }));
  assert.equal(wire.body, Buffer.from('<p>Thanks</p>', 'utf8').toString('base64'));
  assert.equal(wire.plain_text, Buffer.from('Thanks', 'utf8').toString('base64'));
  assert.equal(wire.body?.includes('\n'), false);
  assert.equal(wire.template_id, undefined);
  assert.equal(Buffer.from(wire.body ?? '', 'base64').toString('base64'), wire.body);
});

test('a template send uses template_id and merge tags', () => {
  const wire = buildMessage({
    ...base,
    templateId: 'ab123456-1234-1234-1234-123456789abc',
    mergeTags: { NAME: 'Jane', ORDER_ID: 1001, ACTIVE: true, NOTE: null, MAILBLAZE_PREHEADER: 'Hello' },
  });
  assert.equal(wire.template_id, 'ab123456-1234-1234-1234-123456789abc');
  assert.equal(wire.body, undefined);
  assert.deepEqual(wire.merge_tags, {
    NAME: 'Jane',
    ORDER_ID: '1001',
    ACTIVE: '1',
    NOTE: '',
    MAILBLAZE_PREHEADER: 'Hello',
  });
});

test('html that is only whitespace is rejected', () => {
  assert.throws(() => buildMessage(htmlMessage({ html: ' \n\t ' })), ValidationError);
  assert.throws(() => buildMessage(htmlMessage({ html: Buffer.from('   ') })), ValidationError);
  const kept = buildMessage(htmlMessage({ html: ' <p>Hi</p> ' }));
  assert.equal(Buffer.from(kept.body ?? '', 'base64').toString('utf8'), ' <p>Hi</p> ');
});

test('html and templateId are mutually exclusive', () => {
  assert.throws(
    () => buildMessage({ ...base, html: '<p>Hi</p>', templateId: 'tpl' } as unknown as OutgoingEmail),
    ValidationError,
  );
  assert.throws(() => buildMessage({ ...base } as OutgoingEmail), (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, '150.012');
    return true;
  });
});

test('line breaks in names, subjects, filenames, and addresses are rejected', () => {
  const samples = [
    htmlMessage({ subject: 'Hello\nthere' }),
    htmlMessage({ to: { email: 'jane@example.com', name: 'Jane\rDoe' } }),
    htmlMessage({ from: { email: 'bad\n@example.com', name: 'Acme' } }),
    htmlMessage({ cc: 'ops@example.com\n' }),
    htmlMessage({ attachments: [{ filename: 'invoice\r.pdf', data: Buffer.from('a') }] }),
  ];
  for (const sample of samples) {
    assert.throws(() => buildMessage(sample), ValidationError);
  }
});

test('a Date sendAt is RFC 3339 with +00:00 and an offset-less string is preserved', () => {
  const dated = buildMessage(htmlMessage({ sendAt: new Date('2026-11-17T09:00:00.000Z') }));
  assert.equal(dated.send_at, '2026-11-17T09:00:00+00:00');
  const raw = buildMessage(htmlMessage({ sendAt: '2026-11-17T17:00:00' }));
  assert.equal(raw.send_at, '2026-11-17T17:00:00');
});

test('attachment data must be bytes, not a URL or path', () => {
  assert.throws(
    () => buildMessage(htmlMessage({ attachments: [{ filename: 'a.txt', data: 'https://example.com/a.txt' }] })),
    /not fetched/,
  );
});

test('cc and bcc are one comma-separated string', () => {
  const wire = buildMessage(htmlMessage({ cc: ['a@example.com', 'b@example.com'], bcc: 'c@example.com, d@example.com' }));
  assert.equal(wire.cc, 'a@example.com,b@example.com');
  assert.equal(wire.bcc, 'c@example.com,d@example.com');
});

test('the public client can be constructed and does not reveal the key', () => {
  const client = new MailBlaze({ apiKey: 'mb-test-key' });
  assert.equal(JSON.stringify(client).includes('mb-test-key'), false);
  assert.equal(inspect(client).includes('mb-test-key'), false);
});

function inspect(value: unknown): string {
  const custom = Symbol.for('nodejs.util.inspect.custom');
  const target = value as { [custom]?: () => string };
  return target[custom]?.() ?? '';
}
