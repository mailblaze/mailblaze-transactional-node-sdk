import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  AuthenticationError,
  ConfigurationError,
  DomainNotVerifiedError,
  MailBlaze,
  NotFoundError,
  QuotaError,
  RateLimitError,
  ResponseTooLargeError,
  SendFailedError,
  TransportError,
  UnconfirmedSendError,
  ValidationError,
  VERSION,
} from '../src/index.ts';
import { Transport } from '../src/http.ts';
import { mapError } from '../src/map-error.ts';
import { assertServerRuntime } from '../src/runtime.ts';

const KEY = 'mb-test-key';

test('error codes map onto the typed hierarchy', () => {
  const cases: Array<[string, number, new (...args: never[]) => Error]> = [
    ['150.001', 403, AuthenticationError],
    ['150.002', 400, ValidationError],
    ['150.003', 400, ValidationError],
    ['150.004', 400, ValidationError],
    ['150.005', 400, ValidationError],
    ['150.006', 422, ValidationError],
    ['150.007', 422, SendFailedError],
    ['150.008', 503, ApiError],
    ['150.009', 404, NotFoundError],
    ['150.010', 403, DomainNotVerifiedError],
    ['150.011', 400, ValidationError],
    ['150.012', 400, ValidationError],
    ['150.013', 404, NotFoundError],
    ['150.014', 400, ValidationError],
    ['150.015', 403, QuotaError],
    ['150.016', 500, SendFailedError],
    ['100.001', 400, ValidationError],
  ];

  for (const [code, status, type] of cases) {
    const error = mapError(status, { status: 'error', code, error: `failed ${KEY}` }, KEY);
    assert.ok(error instanceof type, code);
    assert.equal(error.message.includes(KEY), false);
    assert.match(error.message, /\[redacted\]/);
  }

  assert.ok(mapError(429, { error: 'slow down' }, KEY) instanceof RateLimitError);
  assert.ok(mapError(400, { error: 'Invalid API key' }, KEY) instanceof AuthenticationError);
});

test('init throws in a browser-like runtime and for a non-https base URL', () => {
  assert.throws(
    () => assertServerRuntime({ window: {}, document: {}, process: { versions: { node: '22.19.0' } } }),
    ConfigurationError,
  );
  const scope = globalThis as { window?: unknown; document?: unknown };
  scope.window = {};
  scope.document = {};
  try {
    assert.throws(() => new MailBlaze({ apiKey: KEY }), ConfigurationError);
  } finally {
    delete scope.window;
    delete scope.document;
  }
  assert.throws(() => new MailBlaze({ apiKey: KEY, baseUrl: 'http://control.mailblaze.com/api' }), ConfigurationError);
  assert.throws(() => new MailBlaze({ apiKey: KEY, baseUrl: 'https://user:secret@control.mailblaze.com/api' }), ConfigurationError);
});

test('send sets the raw key, json content type, and redirect error, and does not retry', async () => {
  const requests: Request[] = [];
  const fetchImpl = (request: Request): Promise<Response> => {
    requests.push(request);
    if (requests.length === 1) {
      return Promise.reject(new Error(`socket hang up ${KEY}`));
    }
    return Promise.resolve(Response.json({ status: 'success', code: '000.000', email_uid: 'em_1', warning: null }, { status: 201 }));
  };
  const client = new MailBlaze({ apiKey: KEY, fetch: fetchImpl, getRetryLimit: 2 });

  await assert.rejects(
    () => client.send(sample()),
    (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.reason, 'connect');
      assert.equal(error.message.includes(KEY), false);
      assert.match(error.message, /may already have been accepted/);
      return true;
    },
  );
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.get('authorization'), KEY);
  assert.equal(request.headers.get('content-type'), 'application/json');
  assert.equal(request.headers.get('user-agent'), `mailblaze-transactional-node-sdk/${VERSION}`);
  assert.equal(request.url, 'https://control.mailblaze.com/api/transactional');
  const payload = JSON.parse(await request.clone().text()) as { body?: string };
  assert.equal(payload.body, Buffer.from('<p>Thanks</p>', 'utf8').toString('base64'));
});

test('a redirect is not retried when Node reports it on error.cause', async () => {
  let calls = 0;
  const cause = new Error('unexpected redirect');
  const failure = new TypeError('fetch failed');
  failure.cause = cause;
  const client = new MailBlaze({
    apiKey: KEY,
    getRetryLimit: 2,
    fetch: () => {
      calls += 1;
      return Promise.reject(failure);
    },
  });
  await assert.rejects(() => client.list(), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.reason, 'redirect');
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(() => client.send(sample()), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.reason, 'redirect');
    assert.equal(error.message.includes('may already have been accepted'), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('an empty successful list response is retried', async () => {
  let calls = 0;
  const transport = new Transport({
    apiKey: KEY,
    getRetryLimit: 2,
    sleep: () => Promise.resolve(),
    fetch: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return Promise.resolve(Response.json({
        status: 'success',
        code: '050.001',
        data: { count: '0', total_pages: '0', current_page: '1', next_page: null, prev_page: null, records: [] },
      }));
    },
  });
  const page = await transport.list(1, 10);
  assert.equal(calls, 2);
  assert.equal(page.count, 0);
  assert.equal(page.currentPage, 1);
});

test('a success body that breaks while it is being read is retried', async () => {
  let calls = 0;
  const transport = new Transport({
    apiKey: KEY,
    getRetryLimit: 2,
    sleep: () => Promise.resolve(),
    fetch: () => {
      calls += 1;
      if (calls === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":"succ'));
            controller.error(new Error('connection reset'));
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      }
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
            send_at: null,
            status: 'queued',
          },
        },
      }));
    },
  });
  const email = await transport.get('email_001');
  assert.equal(calls, 2);
  assert.equal(email.emailUid, 'email_001');
});

test('429 on send is a rate limit error and is not retried', async () => {
  let calls = 0;
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json({ status: 'error', error: 'slow down' }, { status: 429 }));
    },
  });
  await assert.rejects(() => client.send(sample()), RateLimitError);
  assert.equal(calls, 1);
});

test('a safe GET retries a 503, honors Retry-After, and keeps ids as strings', async () => {
  const waits: number[] = [];
  let calls = 0;
  const transport = new Transport({
    apiKey: KEY,
    getRetryLimit: 2,
    jitterMs: () => 0,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    fetch: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(Response.json({ status: 'error', code: '150.008', error: 'down' }, {
          status: 503,
          headers: { 'retry-after': '1' },
        }));
      }
      return Promise.resolve(Response.json({
        status: 'success',
        code: '000.000',
        data: {
          count: 1,
          total_pages: 1,
          current_page: 1,
          next_page: null,
          prev_page: null,
          records: [{ email_uid: '00123', to_email: 'jane@example.com', subject: 'Hi', status: 'queued' }],
        },
      }));
    },
  });

  const page = await transport.list(1, 10);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(page.records[0]?.emailUid, '00123');
});

test('list clamps perPage and an aborted GET is not retried', async () => {
  const urls: string[] = [];
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: (request) => {
      urls.push(request.url);
      return Promise.resolve(Response.json({
        status: 'success',
        code: '050.001',
        data: { count: null, total_pages: null, current_page: null, next_page: null, prev_page: null, records: [] },
      }));
    },
  });
  const page = await client.list({ page: 2, perPage: 1000 });
  assert.equal(page.code, '050.001');
  assert.equal(urls[0], 'https://control.mailblaze.com/api/transactional?page=2&per_page=50');

  const aborted = AbortSignal.abort();
  let calls = 0;
  const stopped = new MailBlaze({
    apiKey: KEY,
    fetch: () => {
      calls += 1;
      return Promise.resolve(new Response(''));
    },
  });
  await assert.rejects(() => stopped.get('email-1', { signal: aborted }), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.reason, 'abort');
    return true;
  });
  assert.equal(calls, 0);
});

test('a 201 with an unreadable body does not retry the send', async () => {
  let calls = 0;
  const client = new MailBlaze({
    apiKey: KEY,
    fetch: () => {
      calls += 1;
      return Promise.resolve(new Response('not-json', { status: 201 }));
    },
  });
  await assert.rejects(() => client.send(sample()), UnconfirmedSendError);
  assert.equal(calls, 1);
});

test('logs omit the key and message body', async () => {
  const lines: string[] = [];
  const client = new MailBlaze({
    apiKey: KEY,
    logger: {
      info: (message, fields) => {
        lines.push(`${message} ${JSON.stringify(fields)}`);
      },
    },
    fetch: async (request) => {
      lines.push(await request.clone().text());
      return Response.json({ status: 'success', code: '000.000', email_uid: 'em_9', warning: null }, { status: 201 });
    },
  });
  const sent = await client.send(sample());
  assert.equal(sent.accepted, true);
  assert.equal(sent.emailUid, 'em_9');
  const libraryLogs = lines.filter((line) => line.startsWith('Mail Blaze'));
  assert.equal(libraryLogs.some((line) => line.includes(KEY) || line.includes('<p>Thanks</p>')), false);
});

test('an oversized success body is not retried', async () => {
  let calls = 0;
  const client = new MailBlaze({
    apiKey: KEY,
    maxResponseBytes: 1000,
    getRetryLimit: 2,
    fetch: () => {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2000));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    },
  });
  await assert.rejects(() => client.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.maxBytes, 1000);
    assert.equal(error.status, 200);
    assert.equal(error.receivedBytes, 2000);
    return true;
  });
  assert.equal(calls, 1);
});

test('an oversized response is rejected before it is parsed', async () => {
  const client = new MailBlaze({
    apiKey: KEY,
    maxResponseBytes: 32,
    fetch: () => Promise.resolve(Response.json({ status: 'success', code: '000.000', email_uid: 'em_too_long_for_the_cap', warning: null }, { status: 201 })),
  });
  await assert.rejects(() => client.send(sample()), (error: unknown) => {
    assert.ok(error instanceof UnconfirmedSendError);
    return true;
  });
});

function oversized(status: number, size = 2048, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(0x7b));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

function limitedTransport(make: () => Response, counter: { calls: number }): Transport {
  return new Transport({
    apiKey: KEY,
    maxResponseBytes: 1000,
    getRetryLimit: 2,
    sleep: () => Promise.resolve(),
    fetch: () => {
      counter.calls += 1;
      return Promise.resolve(make());
    },
  });
}

test('an oversized 503 on get is retried and then maps by status, not size', async () => {
  const counter = { calls: 0 };
  const transport = limitedTransport(() => oversized(503), counter);
  await assert.rejects(() => transport.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error instanceof ResponseTooLargeError, false);
    assert.equal(error.status, 503);
    assert.match(error.message, /larger than the client limit of 1000 bytes/);
    return true;
  });
  assert.equal(counter.calls, 3);
});

test('an oversized 503 is retried until a readable response arrives', async () => {
  const counter = { calls: 0 };
  const transport = limitedTransport(
    () => (counter.calls === 1 ? oversized(503) : Response.json({ status: 'error', error: 'gone' }, { status: 404 })),
    counter,
  );
  await assert.rejects(() => transport.get('u1'), NotFoundError);
  assert.equal(counter.calls, 2);
});

test('an oversized 404 on get maps to NotFoundError with its status and is not retried', async () => {
  const counter = { calls: 0 };
  const transport = limitedTransport(() => oversized(404, 2048, { 'content-length': '2048' }), counter);
  await assert.rejects(() => transport.get('u1'), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    assert.equal(error.status, 404);
    return true;
  });
  assert.equal(counter.calls, 1);
});

test('an oversized 429 on list and get maps to RateLimitError after the GET retries', async () => {
  for (const call of ['list', 'get'] as const) {
    const counter = { calls: 0 };
    const transport = limitedTransport(() => oversized(429), counter);
    const run = call === 'list' ? () => transport.list(1, 10) : () => transport.get('u1');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof RateLimitError, call);
      assert.equal(error.status, 429);
      return true;
    });
    assert.equal(counter.calls, 3, call);
  }
});

test('an oversized 404 on list maps to NotFoundError', async () => {
  const counter = { calls: 0 };
  const transport = limitedTransport(() => oversized(404), counter);
  await assert.rejects(() => transport.list(1, 10), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    assert.equal(error.status, 404);
    return true;
  });
  assert.equal(counter.calls, 1);
});

test('an oversized 500 on send is an ApiError with its status, sent once', async () => {
  let calls = 0;
  const client = new MailBlaze({
    apiKey: KEY,
    maxResponseBytes: 1000,
    fetch: () => {
      calls += 1;
      return Promise.resolve(oversized(500));
    },
  });
  await assert.rejects(() => client.send(sample()), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.match(error.message, /body was not read/);
    return true;
  });
  assert.equal(calls, 1);
});

test('a malformed Content-Length is ignored and a small body is read normally', async () => {
  const client = new MailBlaze({
    apiKey: KEY,
    maxResponseBytes: 1000,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'success', code: '000.000', email_uid: 'em_9', warning: null }), {
          status: 201,
          headers: { 'content-type': 'application/json', 'content-length': 'abc' },
        }),
      ),
  });
  const sent = await client.send(sample());
  assert.equal(sent.emailUid, 'em_9');
});

test('a malformed Content-Length still enforces the limit by counting streamed bytes', async () => {
  const counter = { calls: 0 };
  const transport = limitedTransport(() => oversized(200, 2000, { 'content-length': 'abc' }), counter);
  await assert.rejects(() => transport.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.maxBytes, 1000);
    assert.equal(error.status, 200);
    assert.equal(error.receivedBytes, 2000);
    assert.equal(error.declaredBytes, undefined);
    return true;
  });
  assert.equal(counter.calls, 1);
});

test('ResponseTooLargeError exposes the limit, status, and declared size', async () => {
  const counter = { calls: 0 };
  const transport = limitedTransport(() => oversized(200, 2048, { 'content-length': '2048' }), counter);
  await assert.rejects(() => transport.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.maxBytes, 1000);
    assert.equal(error.status, 200);
    assert.equal(error.declaredBytes, 2048);
    assert.equal(error.receivedBytes, undefined);
    assert.equal(error.reason, 'response');
    assert.match(error.message, /HTTP 200/);
    assert.match(error.message, /1000 bytes/);
    assert.match(error.message, /Content-Length is 2048/);
    return true;
  });
  assert.equal(counter.calls, 1);
});

test('a Content-Length past MAX_SAFE_INTEGER is rejected with declaredBytes undefined and the raw header in the message', async () => {
  const counter = { calls: 0 };
  const transport = limitedTransport(() => oversized(200, 2048, { 'content-length': '99999999999999999999' }), counter);
  await assert.rejects(() => transport.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.declaredBytes, undefined);
    assert.equal(error.receivedBytes, undefined);
    assert.equal(error.maxBytes, 1000);
    assert.match(error.message, /declared Content-Length 99999999999999999999/);
    return true;
  });
  assert.equal(counter.calls, 1);
});

test('a very long Content-Length is truncated to 32 characters in the message', async () => {
  const counter = { calls: 0 };
  const header = '9'.repeat(400);
  const transport = limitedTransport(() => oversized(200, 2048, { 'content-length': header }), counter);
  await assert.rejects(() => transport.get('u1'), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.declaredBytes, undefined);
    assert.ok(error.message.includes(`declared Content-Length ${'9'.repeat(32)}\u2026`));
    assert.equal(error.message.includes('9'.repeat(33)), false);
    return true;
  });
  assert.equal(counter.calls, 1);
});

function sample() {
  return {
    to: { email: 'jane@example.com', name: 'Jane Doe' },
    from: { email: 'billing@example.com', name: 'Acme' },
    subject: 'Your receipt',
    html: '<p>Thanks</p>',
  };
}
