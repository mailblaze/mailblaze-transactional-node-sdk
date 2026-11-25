import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, ConfigurationError, MailBlaze, NotFoundError, UnconfirmedSendError, ValidationError } from '../src/index.ts';
import { Transport } from '../src/http.ts';
import { mapError } from '../src/map-error.ts';
import { buildMessage } from '../src/message.ts';
import type { Logger } from '../src/types.ts';

const KEY = 'mb-test-key';

const base = {
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Your receipt',
  html: '<p>Thanks</p>',
};

const ok201 = (): Response =>
  Response.json({ status: 'success', code: '000.000', email_uid: 'em_1', warning: null }, { status: 201 });

function retryTransport(
  make: (call: number) => Response,
  waits: number[],
  extra: { timeoutMs?: number; retryDelayMs?: number; getRetryLimit?: number; jitterMs?: number } = {},
) {
  const counter = { calls: 0 };
  const transport = new Transport({
    apiKey: KEY,
    getRetryLimit: extra.getRetryLimit ?? 1,
    retryDelayMs: extra.retryDelayMs ?? 200,
    jitterMs: () => extra.jitterMs ?? 0,
    timeoutMs: extra.timeoutMs ?? 120_000,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => Date.parse('2026-11-18T00:00:00Z'),
    fetch: () => {
      counter.calls += 1;
      return Promise.resolve(make(counter.calls));
    },
  });
  return { transport, counter };
}

test('a throwing logger never changes the result of a call', async () => {
  const logger: Logger = {
    info: () => {
      throw new Error('logger down');
    },
    warn: () => {
      throw new Error('logger down');
    },
  };
  const client = new MailBlaze({ apiKey: KEY, logger, fetch: () => Promise.resolve(ok201()) });
  const sent = await client.send(base);
  assert.equal(sent.emailUid, 'em_1');

  const missing = new MailBlaze({
    apiKey: KEY,
    logger,
    getRetryLimit: 0,
    fetch: () => Promise.resolve(Response.json({ status: 'error', error: 'gone' }, { status: 404 })),
  });
  await assert.rejects(() => missing.get('u1'), NotFoundError);
});

test('a logger that returns a rejecting promise does not cause an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const logger: Logger = {
      info: () => Promise.reject(new Error('async logger down')) as unknown as void,
    };
    const client = new MailBlaze({ apiKey: KEY, logger, fetch: () => Promise.resolve(ok201()) });
    const sent = await client.send(base);
    assert.equal(sent.emailUid, 'em_1');
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

// Retry-After, 60 s cap, jitter, and the deadline guard
test('a huge numeric Retry-After is capped at 60 seconds', async () => {
  const waits: number[] = [];
  const { transport, counter } = retryTransport(
    () => Response.json({ status: 'error', error: 'busy' }, { status: 503, headers: { 'retry-after': '9'.repeat(400) } }),
    waits,
  );
  await assert.rejects(() => transport.get('u1'), (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.deepEqual(waits, [60_000]);
  assert.equal(counter.calls, 2);
});

test('a far-future Retry-After date is capped at 60 seconds, and a near one is honored', async () => {
  const waits: number[] = [];
  const { transport } = retryTransport(
    (call) =>
      Response.json(
        { status: 'error', error: 'busy' },
        { status: 503, headers: { 'retry-after': call === 1 ? 'Fri, 31 Dec 9999 23:59:59 GMT' : 'Wed, 18 Nov 2026 00:00:03 GMT' } },
      ),
    waits,
    { getRetryLimit: 2 },
  );
  await assert.rejects(() => transport.get('u1'), ApiError);
  assert.deepEqual(waits, [60_000, 3_000]);
});

test('a GET is not retried when the wait would pass the request timeout', async () => {
  const waits: number[] = [];
  const { transport, counter } = retryTransport(
    () => Response.json({ status: 'error', error: 'slow down' }, { status: 429, headers: { 'retry-after': '30' } }),
    waits,
    { timeoutMs: 10_000 },
  );
  await assert.rejects(() => transport.get('u1'), (error: unknown) => error instanceof ApiError && error.status === 429);
  assert.deepEqual(waits, []);
  assert.equal(counter.calls, 1);
});

test('a short Retry-After inside the deadline is honored, with jitter added', async () => {
  const waits: number[] = [];
  const { transport, counter } = retryTransport(
    (call) =>
      call === 1
        ? Response.json({ status: 'error', error: 'busy' }, { status: 503, headers: { 'retry-after': '2' } })
        : Response.json({ status: 'error', error: 'gone' }, { status: 404 }),
    waits,
    { timeoutMs: 10_000, jitterMs: 37 },
  );
  await assert.rejects(() => transport.get('u1'), NotFoundError);
  assert.deepEqual(waits, [2_037]);
  assert.equal(counter.calls, 2);
});
test('Retry-After accepts only delta-seconds or an HTTP-date; anything else uses the normal backoff', async () => {
  for (const header of ['-5', '+5', '1e3', '1.5', 'NaN', 'abc', '0x10', 'Wed, 18 Nov 2026', '2026-11-18T00:00:05Z']) {
    const waits: number[] = [];
    const { transport } = retryTransport(
      () => Response.json({ status: 'error', error: 'busy' }, { status: 503, headers: { 'retry-after': header } }),
      waits,
      { getRetryLimit: 2 },
    );
    await assert.rejects(() => transport.get('u1'), ApiError);
    assert.deepEqual(waits, [200, 400], header);
  }
  // now() is 2026-11-18T00:00:00Z. RFC 850 and asctime (read as UTC) are accepted too.
  for (const [header, wait] of [
    ['7', 7_000],
    ['Wed, 18 Nov 2026 00:00:04 GMT', 4_000],
    ['Wednesday, 18-Nov-26 00:00:05 GMT', 5_000],
    ['Wed Nov 18 00:00:06 2026', 6_000],
  ] as const) {
    const waits: number[] = [];
    const { transport } = retryTransport(
      () => Response.json({ status: 'error', error: 'busy' }, { status: 503, headers: { 'retry-after': header } }),
      waits,
    );
    await assert.rejects(() => transport.get('u1'), ApiError);
    assert.deepEqual(waits, [wait], header);
  }
});
test('a non-JSON 2xx body never copies response text into the error or its cause', async () => {
  const prefix = KEY.slice(0, 10);
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: () => Promise.resolve(new Response(`{"email_uid": "${prefix}`, { status: 201 })),
  });
  await assert.rejects(() => client.send(base), (error: unknown) => {
    assert.ok(error instanceof UnconfirmedSendError);
    const cause = error.cause as Error;
    assert.equal(cause.message, 'The Mail Blaze API response was not valid JSON');
    const all = `${error.message}\n${error.stack ?? ''}\n${cause.message}\n${cause.stack ?? ''}`;
    assert.equal(all.includes(prefix), false);
    return true;
  });

  const reader = new MailBlaze({
    apiKey: KEY,
    getRetryLimit: 0,
    fetch: () => Promise.resolve(new Response(`not json ${prefix}`, { status: 200 })),
  });
  await assert.rejects(() => reader.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(JSON.stringify({ m: error.message, e: error.error, s: error.stack }).includes(prefix), false);
    return true;
  });
});

test('a 2xx send whose JSON body is not an object is unconfirmed', async () => {
  for (const body of ['[]', '"ok"', '123', 'null', 'true']) {
    const client = new MailBlaze({ apiKey: KEY, fetch: () => Promise.resolve(new Response(body, { status: 201 })) });
    await assert.rejects(() => client.send(base), (error: unknown) => {
      assert.ok(error instanceof UnconfirmedSendError, body);
      assert.equal(error.status, 201);
      return true;
    });
  }
});

test('control characters are removed from server error text', () => {
  const error = mapError(500, { error: 'bad\r\nX-Injected: 1\u001b[31m\u0007\u0085\u009bend\tok' }, KEY);
  const controls = /[\u0000-\u001F\u007F-\u009F]/;
  assert.equal(controls.test(error.message), false);
  assert.ok(error instanceof ApiError);
  assert.equal(controls.test(error.error), false);
  assert.equal(error.error, 'bad X-Injected: 1[31m end ok');
});

test('line separators and bidi controls are removed from server error text', () => {
  const error = mapError(500, { error: 'a\u2028b\u2029c\u202Ed\u202Ae\u2066f\u2069g\u202Bh' }, KEY);
  assert.ok(error instanceof ApiError);
  assert.equal(/[\u2028\u2029\u202A-\u202E\u2066-\u2069]/.test(error.message), false);
  assert.equal(error.error, 'a b cdefgh');
});

test('merge tag values with line breaks or control characters are rejected before the request', async () => {
  const template = { to: base.to, from: base.from, subject: base.subject, templateId: 't1' };
  let calls = 0;
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: () => {
      calls += 1;
      return Promise.resolve(ok201());
    },
  });
  const cases: Array<[string, RegExp]> = [
    ['Acme\r\nBcc: evil@example.com', /^Merge tag value must not contain line breaks$/],
    ['a\rb', /^Merge tag value must not contain line breaks$/],
    ['a\nb', /^Merge tag value must not contain line breaks$/],
    ['a\u0085b', /^Merge tag value must not contain line breaks$/],
    ['a\u2028b', /^Merge tag value must not contain line breaks$/],
    ['a\u2029b', /^Merge tag value must not contain line breaks$/],
    ['a\tb', /^Merge tag value must not contain control characters$/],
    ['a\u0000b', /^Merge tag value must not contain control characters$/],
    ['a\u001bb', /^Merge tag value must not contain control characters$/],
    ['a\u009bb', /^Merge tag value must not contain control characters$/],
  ];
  for (const [value, message] of cases) {
    await assert.rejects(
      () => Promise.resolve().then(() => client.send({ ...template, mergeTags: { COMPANY_NAME: value } })),
      (error: unknown) => error instanceof ValidationError && message.test(error.message),
      JSON.stringify(value),
    );
  }
  assert.equal(calls, 0);
});

test('merge tag values keep spaces, unicode, and scalar conversions', () => {
  const template = { to: base.to, from: base.from, subject: base.subject, templateId: 't1' };
  const wire = buildMessage({
    ...template,
    mergeTags: { NAME: '  Zoë 日本語 🎉\u200d ', EMPTY: '', NUM: 1001, FLAG: false, NONE: null },
  });
  assert.deepEqual(wire.merge_tags, { NAME: '  Zoë 日本語 🎉\u200d ', EMPTY: '', NUM: '1001', FLAG: '0', NONE: '' });
});

test('merge tag values count toward the 15 MiB total', () => {
  const template = { to: base.to, from: base.from, subject: base.subject, templateId: 't1' };
  assert.throws(
    () => buildMessage({ ...template, mergeTags: { BIG: 'a'.repeat(15 * 1024 * 1024 + 1) } }),
    (error: unknown) => error instanceof ValidationError && /Merge tag BIG/.test(error.message),
  );
  assert.throws(
    () =>
      buildMessage({
        ...template,
        mergeTags: { HALF: 'b'.repeat(6 * 1024 * 1024) },
        attachments: [{ filename: 'a.bin', data: Buffer.alloc(7_864_320, 0x61) }],
      }),
    ValidationError,
  );
  assert.doesNotThrow(() => buildMessage({ ...template, mergeTags: { SMALL: 'c'.repeat(1024) } }));
});

test('merge tags are counted JSON-encoded, so escaped characters count at their wire size', () => {
  const template = { to: base.to, from: base.from, subject: base.subject, templateId: 't1' };
  // 10 MiB of backslashes or quotes is 20 MiB as JSON. Control characters are rejected before counting.
  for (const [label, value] of [
    ['backslash', '\\'.repeat(10 * 1024 * 1024)],
    ['quote', '"'.repeat(10 * 1024 * 1024)],
  ] as const) {
    assert.throws(
      () => buildMessage({ ...template, mergeTags: { ESCAPED: value } }),
      (error: unknown) => error instanceof ValidationError && /Merge tag ESCAPED/.test(error.message),
      label,
    );
  }
});

test('an email local part over 64 characters is rejected', () => {
  assert.doesNotThrow(() => buildMessage({ ...base, to: { email: `${'a'.repeat(64)}@example.com`, name: 'A' } }));
  assert.throws(
    () => buildMessage({ ...base, to: { email: `${'a'.repeat(65)}@example.com`, name: 'A' } }),
    (error: unknown) => error instanceof ValidationError && /must be a valid email address/.test(error.message),
  );
});

// options / fetch
test('non-object options and a non-function fetch are rejected at construction', () => {
  for (const options of [null, undefined, 'key', 42]) {
    assert.throws(() => new MailBlaze(options as never), ConfigurationError);
    assert.throws(() => new Transport(options as never), ConfigurationError);
  }
  for (const fetch of ['https://evil.example', 42, {}, null]) {
    assert.throws(
      () => new MailBlaze({ apiKey: KEY, fetch: fetch as never }),
      (error: unknown) => error instanceof ConfigurationError && /fetch must be a function/.test(error.message),
    );
  }
});

// page counts
test('negative, fractional, or unsafe page counts in a list response are rejected', async () => {
  const listWith = (data: Record<string, unknown>) =>
    new MailBlaze({
      apiKey: KEY,
      getRetryLimit: 0,
      fetch: () => Promise.resolve(Response.json({ status: 'success', code: '000.000', data: { records: [], ...data } })),
    });
  for (const [field, value] of [
    ['total_pages', -1],
    ['count', 1.5],
    ['current_page', 2 ** 53],
    ['next_page', '9007199254740993'],
    ['prev_page', '-1'],
  ] as const) {
    await assert.rejects(() => listWith({ [field]: value }).list(), (error: unknown) => {
      assert.ok(error instanceof ApiError, `${field}=${String(value)}`);
      assert.match(error.message, new RegExp(field));
      return true;
    });
  }
  const page = await listWith({ count: 0, total_pages: '3', current_page: 1, next_page: 2, prev_page: null }).list();
  assert.equal(page.count, 0);
  assert.equal(page.totalPages, 3);
  assert.equal(page.prevPage, null);
});
// base URL host rules
test('baseUrl rejects every private, link-local, reserved, and non-standard numeric host', () => {
  const blocked: Array<[string, string]> = [
    ['0.0.0.0/8 this network', 'https://0.1.2.3/api'],
    ['10.0.0.0/8 private', 'https://10.0.0.5/api'],
    ['127.0.0.0/8 other than 127.0.0.1', 'https://127.0.0.2/api'],
    ['169.254.0.0/16 link-local metadata', 'https://169.254.169.254/latest'],
    ['172.16.0.0/12 private (low)', 'https://172.16.0.1/api'],
    ['172.16.0.0/12 private (high)', 'https://172.31.255.255/api'],
    ['192.168.0.0/16 private', 'https://192.168.1.10/api'],
    ['240.0.0.0/4 reserved', 'https://240.0.0.1/api'],
    ['255.255.255.255 broadcast', 'https://255.255.255.255/api'],
    [':: unspecified', 'https://[::]/api'],
    ['::ffff:0:0/96 IPv4-mapped', 'https://[::ffff:8.8.8.8]/api'],
    ['::ffff:0:0/96 IPv4-mapped private', 'https://[::ffff:10.0.0.1]/api'],
    ['fc00::/7 unique local (fc)', 'https://[fc00::1]/api'],
    ['fc00::/7 unique local (fd)', 'https://[fd12:3456::1]/api'],
    ['fe80::/10 link-local (low)', 'https://[fe80::1]/api'],
    ['fe80::/10 link-local (high)', 'https://[febf::1]/api'],
    ['hex IPv4 0x7f.1', 'https://0x7f.1/api'],
    ['hex IPv4 0x7f000001', 'https://0x7f000001/api'],
    ['decimal IPv4 2130706433', 'https://2130706433/api'],
    ['short IPv4 127.1', 'https://127.1/api'],
    ['octal IPv4 0177.0.0.1', 'https://0177.0.0.1/api'],
    ['non-ASCII hostname', 'https://b\u00fccher.example/api'],
    ['private host over http', 'http://10.0.0.1/api'],
  ];
  for (const [label, baseUrl] of blocked) {
    assert.throws(
      () => new MailBlaze({ apiKey: KEY, baseUrl }),
      (error: unknown) => error instanceof ConfigurationError && error.message.startsWith('baseUrl host must be a hostname, a public IP address, or loopback'),
      label,
    );
  }
});

test('baseUrl accepts hostnames, public IP addresses, and loopback', () => {
  for (const baseUrl of [
    'https://control.mailblaze.com/api',
    'https://api.example.com',
    'https://8.8.8.8/api',
    'https://172.32.0.1/api',
    'https://100.64.0.1/api',
    'https://[2606:4700:4700::1111]/api',
    'https://127.0.0.1:8443/api',
    'https://[::1]/api',
    'https://localhost/api',
  ]) {
    assert.doesNotThrow(() => new MailBlaze({ apiKey: KEY, baseUrl, fetch: () => Promise.resolve(ok201()) }), baseUrl);
  }
});

test('a public base URL still sends through the mocked fetch', async () => {
  let url = '';
  const client = new MailBlaze({
    apiKey: KEY,
    baseUrl: 'https://api.example.com/v1',
    fetch: (request) => {
      url = request.url;
      return Promise.resolve(ok201());
    },
  });
  const sent = await client.send(base);
  assert.equal(sent.emailUid, 'em_1');
  assert.equal(url, 'https://api.example.com/v1/transactional');
});
