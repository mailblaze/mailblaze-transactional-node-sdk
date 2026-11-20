import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, truncate, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ConfigurationError, MailBlaze, TransportError, ValidationError, attachmentFromPath, sendAtDateTime } from '../src/index.ts';
import type { TransportReason } from '../src/index.ts';
import { buildMessage } from '../src/message.ts';

const KEY = 'mb-test-key';
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

// --- TransportError reasons (including abort and redirect) ---
test('fetch failures map to transport reasons', async () => {
  const cases: Array<[unknown, TransportReason]> = [
    [new TypeError('fetch failed', { cause: coded('getaddrinfo ENOTFOUND api.example', 'ENOTFOUND') }), 'dns'],
    [new TypeError('fetch failed', { cause: coded('getaddrinfo EAI_AGAIN api.example', 'EAI_AGAIN') }), 'dns'],
    [new TypeError('fetch failed', { cause: coded('certificate has expired', 'CERT_HAS_EXPIRED') }), 'tls'],
    [new TypeError('fetch failed', { cause: coded('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT') }), 'tls'],
    [new TypeError('fetch failed', { cause: new AggregateError([coded('connect ECONNREFUSED ::1:443', 'ECONNREFUSED')]) }), 'connect'],
    [new TypeError('fetch failed', { cause: coded('read ECONNRESET', 'ECONNRESET') }), 'connect'],
    [new TypeError('fetch failed', { cause: coded('other side closed', 'UND_ERR_SOCKET') }), 'connect'],
    [new TypeError('fetch failed'), 'connect'],
    [new Error('socket hang up'), 'connect'],
    [new TypeError('fetch failed', { cause: coded('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT') }), 'timeout'],
    [coded('connect ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT'), 'timeout'],
    [new TypeError('fetch failed', { cause: new Error('unexpected redirect') }), 'redirect'],
    [new Error('boom'), 'client'],
    ['not an error', 'unknown'],
  ];
  for (const [thrown, reason] of cases) {
    const logged: unknown[] = [];
    const client = new MailBlaze({
      apiKey: KEY,
      getRetryLimit: 0,
      logger: { info: () => {}, error: (_m, f) => logged.push(f?.['reason']) },
      fetch: () => Promise.reject(thrown),
    });
    await assert.rejects(() => client.get('u1'), (error: unknown) => {
      assert.ok(error instanceof TransportError, reason);
      assert.equal(error.reason, reason, String(thrown));
      if (reason !== 'redirect') {
        assert.equal(error.message, `The Mail Blaze API request could not be completed (${reason})`);
      }
      return true;
    });
    assert.deepEqual(logged, [reason]);
  }
});

test('a GET still retries a dns, tls, connect, or client failure under getRetryLimit', async () => {
  let calls = 0;
  const client = new MailBlaze({
    apiKey: KEY,
    getRetryLimit: 2,
    retryDelayMs: 0,
    fetch: () => {
      calls += 1;
      return Promise.reject(new TypeError('fetch failed', { cause: coded('getaddrinfo ENOTFOUND x', 'ENOTFOUND') }));
    },
  });
  await assert.rejects(() => client.get('u1'), (error: unknown) => error instanceof TransportError && error.reason === 'dns');
  assert.equal(calls, 3);
});

// --- sendAtDateTime ---
const at = (sendAt: string | number | null, zone?: string): string | null =>
  sendAtDateTime({ sendAt }, zone)?.toISOString() ?? null;

test('sendAtDateTime reads the API clock format in UTC unless a time zone is given', () => {
  assert.equal(at('2026-11-16 2:36:59 PM'), '2026-11-16T14:36:59.000Z');
  assert.equal(at('2026-11-16 2:36:59 PM', 'Asia/Manila'), '2026-11-16T06:36:59.000Z');
  assert.equal(at('2026-11-16 2:36:59 PM', '+08:00'), '2026-11-16T06:36:59.000Z');
  assert.equal(at('2026-11-16 02:36:59 pm', '-0530'), '2026-11-16T20:06:59.000Z');
  assert.equal(at('2026-11-16 12:05:00 AM'), '2026-11-16T00:05:00.000Z');
  assert.equal(at('2026-11-16 12:05:00 p.m.'), '2026-11-16T12:05:00.000Z');
  assert.equal(at('  2026-11-16 14:36:59\n'), '2026-11-16T14:36:59.000Z');
  assert.equal(at('2026-11-16T14:36:59', 'America/New_York'), '2026-11-16T19:36:59.000Z');
  assert.equal(at('2026-07-01 12:00:00', 'America/New_York'), '2026-07-01T16:00:00.000Z');
});

test('sendAtDateTime keeps the instant of a value with its own zone or a Unix timestamp', () => {
  assert.equal(at('2026-11-16T14:36:59+08:00', 'America/New_York'), '2026-11-16T06:36:59.000Z');
  assert.equal(at('2026-11-16 14:36:59Z'), '2026-11-16T14:36:59.000Z');
  assert.equal(at('2026-11-16 14:36:59 GMT+0200'), '2026-11-16T12:36:59.000Z');
  assert.equal(at('2026-11-16T14:36:59 Asia/Manila'), '2026-11-16T06:36:59.000Z');
  assert.equal(at('2026-11-16T14:36:59 PST'), '2026-11-16T22:36:59.000Z');
  assert.equal(at('2026-11-16T14:36:59.123456-01:00'), '2026-11-16T15:36:59.123Z');
  assert.equal(at(1763303819), '2025-11-16T14:36:59.000Z');
  assert.equal(at('1763303819', 'Asia/Manila'), '2025-11-16T14:36:59.000Z');
});

test('sendAtDateTime returns null for a missing or unrecognised value', () => {
  for (const value of [
    null,
    '',
    'tomorrow',
    ' 1763303819',
    '2026-02-30 10:00:00',
    '2026-11-16 24:00:00',
    '2026-11-16 13:00:00 PM',
    '2026-11-16 1:2:3',
    '2026-11-16 14:36:59 extra',
    '2026/11/16 14:36:59',
  ]) {
    assert.equal(at(value), null, JSON.stringify(value));
  }
  assert.equal(sendAtDateTime({ sendAt: 1.5 }), null);
  assert.throws(() => sendAtDateTime({ sendAt: null }, 'Mars/Base'), ValidationError);
});

// --- attachmentFromPath ---
const dir = await mkdtemp(join(tmpdir(), 'mb-attach-'));
after(() => rm(dir, { recursive: true, force: true }));

test('attachmentFromPath reads the file and names it after the last path part', async () => {
  const file = join(dir, 'invoice.pdf');
  await writeFile(file, 'hello');
  const attachment = await attachmentFromPath(file);
  assert.equal(attachment.filename, 'invoice.pdf');
  assert.deepEqual([...attachment.data], [...Buffer.from('hello')]);
  const wire = buildMessage({
    to: { email: 'jane@example.com', name: 'Jane' },
    from: { email: 'billing@example.com', name: 'Acme' },
    subject: 'Receipt',
    html: '<p>Hi</p>',
    attachments: [attachment],
  });
  assert.deepEqual(wire.attachments, [{ name: 'invoice.pdf', data: 'aGVsbG8=' }]);
  assert.equal((await attachmentFromPath(file.replaceAll('\\', '/'))).filename, 'invoice.pdf');
});

test('attachmentFromPath rejects a bad path, an oversized file, and an invalid filename', async () => {
  const sub = join(dir, 'folder');
  await mkdir(sub);
  for (const path of [join(dir, 'missing.pdf'), sub, '']) {
    await assert.rejects(() => attachmentFromPath(path), /^ValidationError: Attachment path is not a readable file$/);
  }
  for (const path of [`${dir}\nx.pdf`, `${dir}\0.pdf`]) {
    await assert.rejects(() => attachmentFromPath(path), /^ValidationError: Attachment path must not contain line breaks$/);
  }
  await assert.rejects(() => attachmentFromPath(42 as never), /^ValidationError: Attachment path must be a string$/);

  const big = join(dir, 'big.bin');
  await writeFile(big, '');
  await truncate(big, 7_864_321);
  await assert.rejects(() => attachmentFromPath(big), (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.message, 'Attachment exceeds the 10MB size limit');
    assert.equal(error.code, '150.005');
    return true;
  });

  const disguised = join(dir, 'invoice\u202Efdp.exe');
  await writeFile(disguised, 'x');
  await assert.rejects(() => attachmentFromPath(disguised), /hidden or formatting characters$/);
});
// --- documented base URL host check limits ---
test('the base URL host check has the documented limits', () => {
  const make = (host: string) => () => new MailBlaze({ apiKey: KEY, baseUrl: `https://${host}/api` });
  // IPv4 embedded in IPv6 (other than ::ffff:0:0/96) and hostnames are not resolved or unpacked.
  for (const host of ['[64:ff9b::a00:1]', '[::10.0.0.1]', '[2002:a00:1::]', 'internal.example', 'localhost']) {
    assert.doesNotThrow(make(host), host);
  }
  // Trailing dots and %-encoded hosts are rejected.
  for (const host of ['control.mailblaze.com.', 'control%2Emailblaze.com', 'contr%6Fl.mailblaze.com', '[::ffff:10.0.0.1]']) {
    assert.throws(make(host), ConfigurationError, host);
  }
});
// --- DST gaps and overlaps, abbreviations, and time zone rules ---
test('sendAtDateTime resolves DST gaps and overlaps', () => {
  // A gap time moves forward (02:30 EST does not exist; the result is 03:30 EDT).
  assert.equal(at('2026-03-08 02:30:00', 'America/New_York'), '2026-03-08T07:30:00.000Z');
  // Overlaps: the first occurrence in New York, the second in London.
  assert.equal(at('2026-11-01 01:30:00', 'America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(at('2026-10-25 01:30:00', 'Europe/London'), '2026-10-25T01:30:00.000Z');
  assert.equal(at('2026-03-29 01:30:00', 'Europe/London'), '2026-03-29T01:30:00.000Z');
});

test('assumedTimeZone accepts IANA names, offsets, and abbreviations as fixed offsets', () => {
  const july = (zone: string) => at('2026-07-01 12:00:00', zone);
  assert.equal(july('PST'), '2026-07-01T20:00:00.000Z');
  assert.equal(july('America/Los_Angeles'), '2026-07-01T19:00:00.000Z');
  assert.equal(july('est'), '2026-07-01T17:00:00.000Z');
  assert.equal(july('CEST'), '2026-07-01T10:00:00.000Z');
  assert.equal(july('GMT-0530'), '2026-07-01T17:30:00.000Z');
  assert.equal(july('(UTC)'), '2026-07-01T12:00:00.000Z');
  for (const zone of ['', '+', 'XYZ', 'abcdef', 'brt', 'UTC)', 'America/New_York ', '+0800x', 'UTC\0', 42 as never]) {
    assert.throws(() => july(zone), /^ValidationError: assumedTimeZone is an unknown or bad time zone$/, JSON.stringify(zone));
  }
});

// Older tz data (for example Node 22.14, tzdata 2024b) has Manila's 1844 LMT as -15:56:00
// instead of -15:56:08, so the pre-1900 Asia/Manila case is skipped where the runtime's data differs.
const lmtFromOldTzData = (() => {
  const instant = new Date(0);
  instant.setUTCFullYear(26, 0, 5);
  instant.setUTCHours(16, 56, 8);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', second: 'numeric' }).format(instant) !== '0';
})();

test('sendAtDateTime matches every recorded reference result', (t) => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/send-at-reference.json', import.meta.url), 'utf8')) as {
    values: string[];
    zones: (string | null)[];
    expected: (string | null)[];
    timeZones: { zones: string[]; wall: string; expected: string[] };
  };
  // A 5-digit year is printed without the ISO "+0" prefix.
  const iso = (date: Date | null) => date?.toISOString().replace(/^\+0(\d{5})/, '$1') ?? null;
  let i = 0;
  let skipped = 0;
  for (const zone of fixture.zones) {
    for (const value of fixture.values) {
      const year = /^\s*(\d{1,4})-/.exec(value)?.[1];
      if (lmtFromOldTzData && year !== undefined && Number(year) < 1900 && zone === 'Asia/Manila') {
        skipped += 1;
        i += 1;
        continue;
      }
      assert.equal(iso(sendAtDateTime({ sendAt: value }, zone ?? undefined)), fixture.expected[i], `${zone} ${JSON.stringify(value)}`);
      i += 1;
    }
  }
  if (skipped > 0) {
    t.diagnostic(`skipped ${skipped} pre-1900 Asia/Manila case(s): this runtime's tz data (${process.versions.tz}) has older LMT offsets than the reference fixture`);
  }
  fixture.timeZones.zones.forEach((zone, n) => {
    let got: string | null;
    try {
      got = iso(sendAtDateTime({ sendAt: fixture.timeZones.wall }, zone));
    } catch {
      got = 'bad';
    }
    assert.equal(got, fixture.timeZones.expected[n], JSON.stringify(zone));
  });
});

test('attachmentFromPath throws when window and document are both present', async () => {
  const scope = globalThis as { window?: unknown; document?: unknown };
  scope.window = {};
  scope.document = {};
  try {
    await assert.rejects(() => attachmentFromPath(join(dir, 'invoice.pdf')), ConfigurationError);
  } finally {
    delete scope.window;
    delete scope.document;
  }
});