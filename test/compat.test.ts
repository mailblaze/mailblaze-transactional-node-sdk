import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  AuthenticationError,
  ConfigurationError,
  DEFAULT_TIMEOUT_MS,
  MailBlaze,
  NotFoundError,
  RateLimitError,
  TransportError,
  UnconfirmedSendError,
  ValidationError,
} from '../src/index.ts';
import { DEFAULT_MAX_RESPONSE_BYTES } from '../src/constants.ts';
import { Transport } from '../src/http.ts';
import { mapError } from '../src/map-error.ts';
import { buildMessage } from '../src/message.ts';
import { redact } from '../src/redact.ts';

const KEY = 'mb-test-key';
const base = {
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Receipt',
  html: '<p>Thanks</p>',
};
const ok201 = (): Response =>
  Response.json({ status: 'success', code: '000.000', email_uid: 'em_1', warning: null }, { status: 201 });

function transport(make: (call: number) => Response | Promise<Response>, extra: Record<string, unknown> = {}) {
  const counter = { calls: 0, waits: [] as number[] };
  const t = new Transport({
    apiKey: KEY,
    getRetryLimit: 2,
    jitterMs: () => 0,
    sleep: (ms) => {
      counter.waits.push(ms);
      return Promise.resolve();
    },
    fetch: () => {
      counter.calls += 1;
      return Promise.resolve(make(counter.calls));
    },
    ...extra,
  });
  return { t, counter };
}

const rejectsWith = (pattern: RegExp, type: new (...args: never[]) => Error = ValidationError) => (error: unknown) =>
  error instanceof type && pattern.test(error.message);

// --- base URL ---
test('baseUrl rejects backslashes, whitespace, controls, fragments, and queries', () => {
  for (const baseUrl of [
    'https://evil.example\\@control.mailblaze.com/api',
    'https:\\\\control.mailblaze.com\\api',
    'https://control.mailblaze.com\\api',
    'https://con\ttrol.mailblaze.com/api',
    'https://control.mailblaze.com/a pi',
    'https://control.mailblaze.com/api#',
    'https://control.mailblaze.com/api#x',
    'ftp://control.mailblaze.com/api',
    '   ',
  ]) {
    assert.throws(() => new MailBlaze({ apiKey: KEY, baseUrl }), rejectsWith(/^baseUrl must be an https URL$/, ConfigurationError), baseUrl);
  }
  for (const baseUrl of ['https://control.mailblaze.com/api?', 'https://control.mailblaze.com/api?x=1', 'https://user:pw@control.mailblaze.com/api']) {
    assert.throws(
      () => new MailBlaze({ apiKey: KEY, baseUrl }),
      rejectsWith(/^baseUrl must not contain credentials or a query string$/, ConfigurationError),
      baseUrl,
    );
  }
  assert.doesNotThrow(() => new MailBlaze({ apiKey: KEY, baseUrl: '  https://control.mailblaze.com/api/  ' }));
});

// --- options ---
test('apiKey, timeout, and retry option errors use the documented rules and messages', () => {
  for (const apiKey of ['', '   ', undefined]) {
    assert.throws(() => new MailBlaze({ apiKey: apiKey as never }), rejectsWith(/^apiKey must not be empty$/, ConfigurationError));
  }
  for (const apiKey of ['mb key', 'mb\u00e9key', 42]) {
    assert.throws(
      () => new MailBlaze({ apiKey: apiKey as never }),
      rejectsWith(/^apiKey must be printable ASCII without spaces or control characters$/, ConfigurationError),
    );
  }
  for (const timeoutMs of [0, -1, 120_001, Number.NaN]) {
    assert.throws(
      () => new MailBlaze({ apiKey: KEY, timeoutMs }),
      rejectsWith(/^timeoutMs must be greater than zero and no more than 120000 milliseconds$/, ConfigurationError),
    );
  }
  assert.doesNotThrow(() => new MailBlaze({ apiKey: KEY, timeoutMs: 0.5 }));
  for (const opts of [{ getRetryLimit: 6 }, { getRetryLimit: -1 }, { retryDelayMs: 5_001 }, { retryDelayMs: -1 }, { retryDelayMs: 1.5 }]) {
    assert.throws(
      () => new MailBlaze({ apiKey: KEY, ...opts }),
      rejectsWith(/^getRetryLimit must be from 0 to 5 and retryDelayMs must be from 0 to 5000$/, ConfigurationError),
    );
  }
  // 10 s default timeout; the default response limit is 16 MiB.
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024);
});

// --- retries ---
test('GET retries back off exponentially from retryDelayMs, and 0 means no wait', async () => {
  const busy = () => Response.json({ status: 'error', error: 'busy' }, { status: 502 });
  const custom = transport(busy, { retryDelayMs: 50, getRetryLimit: 3 });
  await assert.rejects(() => custom.t.get('u1'), ApiError);
  assert.deepEqual(custom.counter.waits, [50, 100, 200]);
  assert.equal(custom.counter.calls, 4);
  const capped = transport(busy, { retryDelayMs: 5_000, getRetryLimit: 5, timeoutMs: 120_000 });
  await assert.rejects(() => capped.t.get('u1'), ApiError);
  assert.deepEqual(capped.counter.waits, [5_000, 10_000, 20_000, 40_000, 60_000]);
  const none = transport(busy, { retryDelayMs: 0 });
  await assert.rejects(() => none.t.get('u1'), ApiError);
  assert.deepEqual(none.counter.waits, []);
  assert.equal(none.counter.calls, 3);
});

test('HTTP 429 on a GET is retried and honors Retry-After; a send is never retried', async () => {
  const slow = () => Response.json({ status: 'error', error: 'slow down' }, { status: 429, headers: { 'retry-after': '1' } });
  const { t, counter } = transport(slow);
  await assert.rejects(() => t.list(1, 10), (error: unknown) => error instanceof RateLimitError && error.status === 429);
  assert.equal(counter.calls, 3);
  assert.deepEqual(counter.waits, [1_000, 1_000]);
  let sends = 0;
  const client = new MailBlaze({ apiKey: KEY, getRetryLimit: 5, fetch: () => ((sends += 1), Promise.resolve(slow())) });
  await assert.rejects(() => client.send(base), RateLimitError);
  assert.equal(sends, 1);
});

test('a 3xx response is an ApiError for an unexpected redirect and is not retried', async () => {
  const get = transport(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
  await assert.rejects(() => get.t.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 302);
    assert.equal(error.message, 'The Mail Blaze API returned an unexpected redirect');
    return true;
  });
  assert.equal(get.counter.calls, 1);
  const client = new MailBlaze({ apiKey: KEY, fetch: () => Promise.resolve(new Response(null, { status: 307 })) });
  await assert.rejects(() => client.send(base), (error: unknown) => error instanceof ApiError && error.status === 307);
});

test('a 2xx GET body that is JSON but not an object is retried like invalid JSON', async () => {
  const { t, counter } = transport(() => new Response('[1,2]', { status: 200 }));
  await assert.rejects(() => t.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 200);
    assert.match(error.message, /unexpected response/);
    return true;
  });
  assert.equal(counter.calls, 3);
});

test('a 4xx body that is a JSON array maps by status with the unexpected-response message', async () => {
  const { t } = transport(() => new Response('[]', { status: 404 }));
  await assert.rejects(() => t.get('u1'), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    assert.match(error.message, /unexpected response/);
    return true;
  });
});

test('a 4xx body that fails while it is read maps by status instead of a transport error', async () => {
  const broken = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
          controller.error(new Error('socket hang up'));
        },
      }),
      { status: 404 },
    );
  const { t, counter } = transport(broken);
  await assert.rejects(() => t.get('u1'), (error: unknown) => error instanceof NotFoundError && error.status === 404);
  assert.equal(counter.calls, 1);
});

// --- logging and messages ---
test('a transport failure is logged at error level in the documented message format', async () => {
  const lines: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const client = new MailBlaze({
    apiKey: KEY,
    getRetryLimit: 0,
    logger: {
      info: (m, f) => lines.push(['info', m, f]),
      error: (m, f) => lines.push(['error', m, f]),
    },
    fetch: () => Promise.reject(new TypeError('fetch failed')),
  });
  await assert.rejects(() => client.get('u1'), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.message, 'The Mail Blaze API request could not be completed (connect)');
    return true;
  });
  const failure = lines.find(([level]) => level === 'error');
  assert.deepEqual(failure, [
    'error',
    'Mail Blaze transactional API transport failure',
    { message: 'The HTTP client could not complete the request', reason: 'connect' },
  ]);
});

test('a retried 5xx GET is logged before its body is decoded, without a code', async () => {
  const lines: Array<Record<string, unknown> | undefined> = [];
  const { t } = transport(
    (call) => (call === 1 ? Response.json({ status: 'error', code: '150.008', error: 'down' }, { status: 503 }) : new Response('[]', { status: 404 })),
    { getRetryLimit: 1, logger: { info: (m: string, f?: Record<string, unknown>) => { if (m.endsWith('response')) lines.push(f); } } },
  );
  await assert.rejects(() => t.get('u1'), NotFoundError);
  assert.deepEqual(lines[0], { method: 'GET', path: '/transactional/u1', status: 503 });
});

test('send messages after an unreadable 2xx include the unconfirmed hint', async () => {
  const transportLevel = new MailBlaze({ apiKey: KEY, fetch: () => Promise.resolve(new Response('', { status: 201 })) });
  await assert.rejects(() => transportLevel.send(base), (error: unknown) => {
    assert.ok(error instanceof UnconfirmedSendError);
    assert.equal(
      error.message,
      'The Mail Blaze API returned HTTP 201, but the response could not be read. The email may already have been accepted. Check the list before sending it again.',
    );
    return true;
  });
  const parseLevel = new MailBlaze({
    apiKey: KEY,
    fetch: () => Promise.resolve(Response.json({ status: 'success', code: '000.000', email_uid: '' }, { status: 201 })),
  });
  await assert.rejects(() => parseLevel.send(base), (error: unknown) => {
    assert.ok(error instanceof UnconfirmedSendError);
    assert.match(error.message, /Check the list before sending it again\.$/);
    return true;
  });
});

test('HTTP 429 with no more specific API code is a RateLimitError', () => {
  assert.ok(mapError(429, { error: 'off', code: '150.001' }, KEY) instanceof AuthenticationError);
  const limited = mapError(429, { error: 'slow down' }, KEY);
  assert.ok(limited instanceof RateLimitError);
  assert.ok(limited instanceof ApiError);
});

test('the URL-encoded API key is redacted too', () => {
  const key = "mb+key/1=(x)!";
  const encoded = 'mb%2Bkey%2F1%3D%28x%29%21';
  assert.equal(redact(`raw ${key} enc ${encoded}`, key), 'raw [redacted] enc [redacted]');
});

// --- message validation ---
test('header fields are trimmed and reject line breaks, controls, and invalid UTF-8', () => {
  const wire = buildMessage({ ...base, to: { email: '  jane@example.com ', name: '  Jane Doe  ' }, subject: ' Receipt ' });
  assert.equal(wire.to_email, 'jane@example.com');
  assert.equal(wire.to_name, 'Jane Doe');
  assert.equal(wire.subject, 'Receipt');
  assert.equal(buildMessage({ ...base, subject: '\u00a0Receipt' }).subject, '\u00a0Receipt');
  for (const [subject, pattern] of [
    ['a\nb', /^Subject must not contain line breaks$/],
    ['a\u0085b', /^Subject must not contain line breaks$/],
    ['a\u2028b', /^Subject must not contain line breaks$/],
    ['a\tb', /^Subject must not contain control characters$/],
    ['a\u0090b', /^Subject must not contain control characters$/],
    ['a\ud800b', /^Subject must be valid UTF-8$/],
    ['   ', /^Subject must not be empty$/],
  ] as const) {
    assert.throws(() => buildMessage({ ...base, subject }), rejectsWith(pattern), JSON.stringify(subject));
  }
});

test('email addresses allow IP-literal domains and reject numeric TLDs and dotless domains', () => {
  const to = (email: string) => buildMessage({ ...base, to: { email, name: 'J' } }).to_email;
  assert.equal(to('jane@[127.0.0.1]'), 'jane@[127.0.0.1]');
  assert.equal(to('"jane"@example.com'), '"jane"@example.com');
  assert.equal(to('a@xn--bcher-kva.example'), 'a@xn--bcher-kva.example');
  for (const email of ['a@example.123', 'a@localhost', 'a..b@example.com', 'a@-b.example', 'a@b_c.example', `${'a'.repeat(65)}@example.com`]) {
    assert.throws(() => to(email), rejectsWith(/must be a valid email address$/), email);
  }
  assert.throws(() => to('"a,b"@example.com'), rejectsWith(/must not contain commas, semicolons, or angle brackets$/));
  assert.throws(() => buildMessage({ ...base, cc: 'a@example.com,"x;y"@example.com' }), rejectsWith(/^Cc email must not contain commas/));
});

test('attachment filenames reject a path, controls, formatting characters, and overlong names', () => {
  const name = (filename: string) =>
    buildMessage({ ...base, attachments: [{ filename, data: Buffer.from('x') }] }).attachments?.[0]?.name;
  assert.equal(name('  report.pdf '), 'report.pdf');
  assert.throws(() => name(`${'a'.repeat(252)}.pdf`), rejectsWith(/^Attachment filename is too long$/));
  assert.throws(() => name('   '), rejectsWith(/^Attachment filename is invalid$/));
  assert.throws(() => name('..'), rejectsWith(/^Attachment filename is invalid$/));
  assert.throws(() => name('a\tb.pdf'), rejectsWith(/^Attachment filename must not contain line breaks or control characters$/));
  assert.throws(() => name('a\u202Efdp.exe'), rejectsWith(/^Attachment filename must not contain hidden or formatting characters$/));
  assert.throws(() => name('a\\b.pdf'), rejectsWith(/^Attachment filename must not include a path$/));
  assert.throws(
    () => buildMessage({ ...base, attachments: [{ filename: 'big.bin', data: Buffer.alloc(7_864_321) }] }),
    rejectsWith(/^Attachment exceeds the 10MB size limit$/),
  );
});

test('required fields, html whitespace, merge tag values, and sendAt follow the documented rules', () => {
  assert.throws(() => buildMessage({ ...base, subject: undefined as never }), rejectsWith(/^to, from, and subject are required$/));
  assert.throws(() => buildMessage({ ...base, to: undefined as never }), rejectsWith(/^to, from, and subject are required$/));
  assert.throws(() => buildMessage({ ...base, html: ' \t\r\n' }), rejectsWith(/^html must not be empty$/));
  assert.ok(buildMessage({ ...base, html: '\u00a0' }).body);
  assert.throws(
    () => buildMessage({ to: base.to, from: base.from, subject: 'S', templateId: 't1', mergeTags: { BAD: 'a\ud800' } }),
    rejectsWith(/^Merge tag value must be valid UTF-8$/),
  );
  assert.equal(buildMessage({ ...base, sendAt: new Date('2026-11-18T08:30:15.123Z') }).send_at, '2026-11-18T08:30:15+00:00');
});

test('list clamps any integer perPage and rejects a page below 1', async () => {
  const urls: string[] = [];
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: (request) => {
      urls.push(request.url);
      return Promise.resolve(Response.json({ status: 'success', code: '000.000', data: { records: [] } }));
    },
  });
  await client.list({ perPage: 0 });
  await client.list({ perPage: -5 });
  assert.ok(urls.every((url) => url.endsWith('per_page=10')));
  assert.throws(() => client.list({ page: 0 }), rejectsWith(/^page must be at least 1$/));
  assert.throws(() => client.list({ page: 1.5 }), rejectsWith(/^page must be an integer$/));
  assert.throws(() => client.get('bad id'), rejectsWith(/^emailUid is invalid$/));
});

// --- response parsing ---
test('list and get require string fields where the API must send a string', async () => {
  const reply = (payload: unknown) =>
    new MailBlaze({ apiKey: KEY, getRetryLimit: 0, fetch: () => Promise.resolve(Response.json(payload)) });
  const summary = { email_uid: 'e1', to_email: 'a@example.com', subject: 'S', status: 'sent' };
  await assert.rejects(
    () => reply({ status: 'success', code: '000.000', data: { records: [{ ...summary, to_email: null }] } }).list(),
    rejectsWith(/unexpected to_email$/, ApiError),
  );
  await assert.rejects(
    () => reply({ status: 'success', code: '000.000', data: { records: {} } }).list(),
    rejectsWith(/unexpected records payload$/, ApiError),
  );
  const page = await reply({ status: 'success', code: '000.000', data: { records: [{ ...summary, subject: '' }] } }).list();
  assert.equal(page.records[0]?.subject, '');

  const record = {
    email_uid: 'e1', to_email: 'a@example.com', to_name: 'A', from_email: 'b@example.com', from_name: 'B',
    subject: 'S', body: null, plain_text: null, category: null, send_at: 1763456789, status: 'sent',
  };
  const got = await reply({ status: 'success', code: '000.000', data: { record } }).get('e1');
  assert.equal(got.sendAt, 1763456789);
  assert.equal(got.body, null);
  for (const [field, value] of [['status', null], ['from_name', undefined], ['send_at', 1.5], ['body', 5]] as const) {
    await assert.rejects(
      () => reply({ status: 'success', code: '000.000', data: { record: { ...record, [field]: value } } }).get('e1'),
      rejectsWith(new RegExp(`unexpected ${field}$`), ApiError),
      field,
    );
  }
});