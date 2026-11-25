import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, MailBlaze } from '../src/index.ts';

const KEY = 'mb-test-key';

test('get and attachments keep ids opaque and return file bytes', async () => {
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: (request) => {
      if (request.url.endsWith('/attachments/email_001')) {
        return Promise.resolve(Response.json({
          status: 'success',
          code: '000.000',
          data: [{ name: 'note.txt', data: Buffer.from('hello').toString('base64') }],
        }));
      }
      assert.equal(request.url, 'https://control.mailblaze.com/api/transactional/email_001');
      return Promise.resolve(Response.json({
        status: 'success',
        code: '000.000',
        data: {
          record: {
            email_uid: 'email_001',
            to_email: 'jane@example.com',
            to_name: 'Jane',
            from_email: 'billing@example.com',
            from_name: 'Acme',
            subject: 'Hi',
            body: '<p>Hi</p>',
            plain_text: 'Hi',
            category: null,
            send_at: '2026-11-16 2:36:59 PM',
            status: 'queued',
          },
        },
      }));
    },
  });

  const email = await client.get('email_001');
  assert.equal(email.emailUid, 'email_001');
  assert.equal(email.body, '<p>Hi</p>');
  assert.equal(email.plainText, 'Hi');
  assert.equal(email.sendAt, '2026-11-16 2:36:59 PM');

  const files = await client.attachments('email_001');
  assert.equal(files[0]?.name, 'note.txt');
  assert.equal(Buffer.from(files[0]?.data ?? new Uint8Array()).toString('utf8'), 'hello');
});

test('attachments returns a zero-byte file alongside the others', async () => {
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: () =>
      Promise.resolve(Response.json({
        status: 'success',
        code: '000.000',
        data: [
          { name: 'note.txt', data: Buffer.from('hello').toString('base64') },
          { name: 'empty.bin', data: '' },
          { name: 'tail.txt', data: Buffer.from('end').toString('base64') },
        ],
      })),
  });

  const files = await client.attachments('email_001');
  assert.deepEqual(files.map((file) => file.name), ['note.txt', 'empty.bin', 'tail.txt']);
  assert.ok(files[1]?.data instanceof Uint8Array);
  assert.equal(files[1]?.data.byteLength, 0);
  assert.equal(Buffer.from(files[2]?.data ?? new Uint8Array()).toString('utf8'), 'end');
});

test('attachments still rejects data that is not a string or not strict base64', async () => {
  for (const data of [null, 123, 'aGVsbG8', 'aGVs\nbG8=']) {
    const client = new MailBlaze({
      apiKey: KEY,
      fetch: () =>
        Promise.resolve(Response.json({
          status: 'success',
          code: '000.000',
          data: [{ name: 'ok.txt', data: 'b2s=' }, { name: 'bad.bin', data }],
        })),
    });
    await assert.rejects(() => client.attachments('email_001'), ApiError, String(data));
  }
});

test('a numeric id is not coerced', async () => {
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: () => Promise.resolve(Response.json({ status: 'success', code: '000.000', email_uid: 123, warning: null }, { status: 201 })),
  });
  await assert.rejects(
    () =>
      client.send({
        to: { email: 'jane@example.com', name: 'Jane' },
        from: { email: 'billing@example.com', name: 'Acme' },
        subject: 'Hi',
        html: '<p>Hi</p>',
      }),
    /could not be read/,
  );
});
