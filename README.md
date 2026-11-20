# Mail Blaze transactional email for Node.js

`@mailblaze/transactional` is the official Node.js client for the Mail Blaze transactional API. You pass strings and file bytes. The library sends the JSON the API expects.

Version 0.1.0 is a public preview.

## Requirements

Node.js `^22.14.0`, `^24.0.0`, or `^26.0.0`. The package is ESM. On these versions, `require()` can load it. It throws when both `window` and `document` are present. That check does not keep an API key out of a browser bundle.

## Install

```bash
npm install @mailblaze/transactional
```

Pass your Mail Blaze public API key to the constructor. The examples below read `MAILBLAZE_API_KEY` in your own code. The SDK does not read environment variables. The key is sent as the raw `Authorization` header.

## Send an email

```ts
import { MailBlaze } from '@mailblaze/transactional';

const apiKey = process.env.MAILBLAZE_API_KEY;
if (apiKey === undefined || apiKey === '') {
  throw new Error('Set MAILBLAZE_API_KEY');
}

const mailblaze = new MailBlaze({ apiKey });

const sent = await mailblaze.send({
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Your receipt',
  html: '<p>Thanks for your order.</p>',
  text: 'Thanks for your order.',
});

console.log(sent.emailUid);
```

`sent.accepted` means the API queued the email. It does not mean the message was delivered. The same call works from plain JavaScript. CommonJS is below.

`from.email` must use a domain you have verified in Mail Blaze. An unverified domain returns `150.010`.

`html` and `templateId` cannot be used together. `text` is optional with `html`. Strings, `Buffer`, and `Uint8Array` are encoded as strict base64 with no line wraps. The request `Content-Type` is exactly `application/json`.

## Send a template

```js
const sent = await mailblaze.send({
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Your order',
  templateId: 'ab123456-1234-1234-1234-123456789abc',
  mergeTags: { NAME: 'Jane', ORDER_ID: '1001', MAILBLAZE_PREHEADER: 'Your order' },
});
```

Merge tag names must match `[A-Z0-9_]`. `MAILBLAZE_PREHEADER` sets the preheader. A missing tag returns `150.014`. An unknown template returns `150.013`.

## Attachments, copies, and scheduling

An attachment is file bytes, not a URL or a path. The library does not fetch remote files. To read a local file, use `await attachmentFromPath(path)` (Node.js only; it uses the same `window` and `document` check as the client). It returns `{ filename, data }`, named after the last part of the path (`/` or `\\`). A path with a line break or NUL, a path that is not a readable file, a file over the 10 MiB encoded limit (checked before it is read), and an invalid filename all throw `ValidationError`. Pass only a trusted path, such as one your code builds, never a path taken from a request. On Windows, a UNC path (`\\host\share\file.pdf`) makes the OS connect to that host and can send the Windows user's NTLM credentials to it. Each encoded attachment may be up to 10 MiB. Exactly 10 MiB is allowed. One byte over is rejected before the request (`150.005`). The API detects the content type from the bytes. There is no file-type allowlist.

The client also rejects a message whose encoded HTML, plain text, attachments, and merge tag names and values (JSON-encoded, as UTF-8 bytes) add up to more than 15 MiB. That 15 MiB total is a client-side limit. The API also enforces a 10 MiB per-attachment limit.

```js
await mailblaze.send({
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Invoice',
  html: '<p>Invoice attached.</p>',
  attachments: [{ filename: 'invoice.pdf', data: pdfBytes }],
});
```

`cc` and `bcc` are sent as one string. You can pass a string or a list of addresses. The list is joined with commas.

> **Known API limitation:** PHP SDK live checks on 17 Nov 2026 found that the Mail Blaze API does not apply `cc` or `replyTo` to the delivered message. `bcc` was delivered, and those addresses were not shown to the other recipients. This package sends the same fields. It has not repeated that live check.

A `Date` in `sendAt` is sent in UTC as RFC 3339 with `+00:00` and whole seconds (for example `2026-11-17T09:00:00+00:00`). A string is sent unchanged. A string with no offset is interpreted in the customer account timezone. An invalid value returns `150.006`.

Names, subjects, categories, template ids, filenames, and addresses are trimmed of leading and trailing ASCII whitespace and NUL. A value that still contains a line break (including U+0085, U+2028, and U+2029) or another control character (C0 or C1) is rejected. The library does not strip those characters and continue. Email addresses may be up to 320 characters. IP-literal domains are allowed. Numeric TLDs and dotless domains are rejected. Commas, semicolons, and angle brackets are rejected, even inside quotes. Filenames must not include a path, hidden or formatting characters, or more than 255 bytes. The `html` empty check uses the same trim set, so `html` that is only ASCII whitespace is rejected.

## List, fetch, and attachments

```js
const page = await mailblaze.list({ page: 1, perPage: 10 });
const email = await mailblaze.get(sent.emailUid);
const files = await mailblaze.attachments(sent.emailUid);
```

Any integer `perPage` is clamped to 10–50, so `0` or a negative value becomes 10. The default is 10. `page` must be at least 1. An empty list is success code `050.001`.

`get` returns the stored HTML and plain text. Ids such as `emailUid` stay strings. `sendAt` on a fetched record is the raw API value, which may be a clock string without an offset, such as `2026-11-16 2:36:59 PM`. `sendAtDateTime(record, assumedTimeZone?)` parses it into a `Date`, or returns `null` when it does not recognise the format. A value without an offset is read in UTC unless you pass `assumedTimeZone`. It accepts an IANA name (`'Asia/Manila'`, any case), an offset (`'+08:00'`, `'+0800'`, `'+8'`, `'GMT+8'`), or a time zone abbreviation such as `'EST'`, `'PST'`, or `'CEST'`. An abbreviation is a fixed offset, so `'PST'` is always UTC−8, even in July; pass `'America/Los_Angeles'` to follow daylight saving time. Anything else throws `ValidationError`. A value with its own zone, or a Unix timestamp, keeps its own instant. A clock time that falls in a daylight saving gap moves forward (02:30 becomes 03:30), and one in an overlap resolves as the first occurrence in New York, the second in London. Historical offsets come from the time zone data bundled with Node.js, so a pre-1900 local mean time can differ across Node.js versions. A `Date` holds milliseconds, so microseconds are truncated.

```ts
import { sendAtDateTime } from '@mailblaze/transactional';

const record = await mailblaze.get(emailUid);
const when = sendAtDateTime(record, 'Asia/Manila'); // Date | null
```

`attachments` returns each file's name and decoded bytes. The `name` is supplied by the server and is not sanitised. It may contain path separators, `..`, control characters, or reserved device names. Sanitise it, or generate your own filename, before writing a file to disk.

Page counts in a list response (`count`, `totalPages`, `currentPage`, `nextPage`, `prevPage`) must be non-negative safe integers or `null`. Anything else is an `ApiError` that names the field.

## Client options

```ts
const apiKey = process.env.MAILBLAZE_API_KEY;
if (apiKey === undefined || apiKey === '') {
  throw new Error('Set MAILBLAZE_API_KEY');
}

declare const logger: { info(message: string): void };
declare const trustedFetch: typeof fetch;

const mailblaze = new MailBlaze({
  apiKey,
  baseUrl: 'https://control.mailblaze.com/api',
  timeoutMs: 10_000, // default
  getRetryLimit: 2, // default
  retryDelayMs: 200, // default
  maxResponseBytes: 16 * 1024 * 1024, // default
  logger,
  fetch: trustedFetch,
});
```

The default timeout is 10 seconds. The maximum is 120000 milliseconds (120 seconds). `timeoutMs` is the deadline for the whole call, including GET retries. Pass `signal` on a call to abort it.

`getRetryLimit` (0–5, default 2) is how many extra times a GET is tried after a connection failure, a success body that is empty, incomplete, not valid JSON, or not a JSON object, or HTTP 429, 500, 502, 503, or 504. The wait before retry *n* is the server's `Retry-After` when it sends one as delta-seconds (digits only) or an HTTP-date (IMF-fixdate, RFC 850, or asctime); any other value, such as `-5` or `1e3`, is ignored, otherwise `retryDelayMs × 2^(n−1)` (`retryDelayMs` is 0–5000, default 200, so 200 ms, then 400 ms). The wait is capped at 60 seconds, and a small random jitter (under 100 ms) is added on top. The deadline and abort signal still apply: a GET is not retried when the wait would end after `timeoutMs`; the last error is returned instead. Requests set `redirect: 'error'`, so a redirect followed by `fetch` is a transport error with reason `redirect`. A 3xx response returned to the client (for example by a custom `fetch`) is an `ApiError` for an unexpected redirect. Neither is retried, and neither means a send was accepted. A send is never retried, including after HTTP 429, a timeout, or a connection drop.

`maxResponseBytes` (default 16 MiB) caps how much of a response body the client reads. A valid `Content-Length` above the limit is rejected before the body is read. A missing or malformed `Content-Length` is ignored and the limit is enforced by counting the bytes as they stream in. What happens next depends on the status:

- **2xx**: list, get, and attachments throw `ResponseTooLargeError` on the first attempt and do not retry. On send it is an `UnconfirmedSendError` (the email may already have been accepted). Its `cause` is a redacted copy named `ResponseTooLargeError`, not the error itself: `err.cause instanceof ResponseTooLargeError` is `false`, and `maxBytes`, `status`, `receivedBytes`, and `declaredBytes` are `undefined` on it. Only its message carries the limit and sizes. `ResponseTooLargeError` has `maxBytes` (the limit), `status`, `receivedBytes` (bytes read before reading stopped; `undefined` when `Content-Length` alone rejected it), and `declaredBytes` (a valid `Content-Length`, if any; `undefined` when the value is larger than `Number.MAX_SAFE_INTEGER`, in which case the message shows the raw header, for example `declared Content-Length 99999999999999999999`). The exported `ResponseTooLargeDetails` type also has an optional `declaredHeader`: the raw `Content-Length` text, used only in the message when the value is not a safe integer (shown up to 32 characters, then `…`). All of these are also in the message.
- **Non-2xx**: the status wins. The rest of the body is discarded, and the response is handled like any other response with that status. A GET retries HTTP 429, 500, 502, 503, and 504 under `getRetryLimit`. Then 404 becomes `NotFoundError`, 429 becomes `RateLimitError`, and others become `ApiError` (or the matching subclass), with `status` set. The API error code and message are not available, so the message says the body was larger than the limit and was not read.

Reuse one client. `fetch`, when you pass one, must be a function and an implementation you trust. Options that are not an object, or a `fetch` that is not a function, throw `ConfigurationError`. Requests set `redirect: 'error'`. A custom base URL is trimmed, then must be an `https` URL with no credentials, query string (even an empty `?`), or fragment. Backslashes, whitespace, and control characters anywhere in it throw `ConfigurationError`, so `https://evil.example\@control.mailblaze.com` is rejected. Its host must be a hostname, a public IP address, or loopback (`127.0.0.1`, `[::1]`). Private, link-local, and reserved IP hosts (`0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8` other than `127.0.0.1`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `240.0.0.0/4`, `::`, IPv4-mapped `::ffff:0:0/96`, `fc00::/7`, `fe80::/10`) and numeric hosts in other notations (`0x7f.1`, `2130706433`, `127.1`) throw `ConfigurationError`. There is no opt-out. An IPv4 address embedded in IPv6 in other forms (for example `[64:ff9b::a00:1]` or `[::10.0.0.1]`) is accepted, only the literal host is checked (a hostname is not resolved, so a name that points to a private address is allowed), and a host with a trailing dot (`control.mailblaze.com.`) or a `%`-encoded character is rejected.

Pass a logger with `info` and, optionally, `warn` and `error` to record the method, path, status, and error code. A transport failure is logged with `error` when the logger has it. The wrapper removes the API key, URL-encoded too, and replaces any field whose name looks sensitive (authorization, API key, html, plain, body, secret, attachment, password, headers) with `[redacted]`. It does not log message bodies or the `Authorization` header. A logger that throws, or returns a promise that rejects, is ignored. It never changes the result of a call.

## Errors

| Error | When |
| --- | --- |
| `AuthenticationError` | `150.001` (sending is turned off), or HTTP 401/403 with no more specific code. A rejected key is HTTP 400 with `Invalid API key` |
| `QuotaError` | `150.015` insufficient credits |
| `DomainNotVerifiedError` | `150.010` the from-domain is not verified |
| `ValidationError` | Local input checks, HTTP 400/422, and `100.001`, `150.002`–`150.006`, `150.011`, `150.012`, `150.014` |
| `NotFoundError` | HTTP 404, `150.009`, `150.013` |
| `SendFailedError` | `150.007` and `150.016` |
| `RateLimitError` | HTTP 429. The send is not retried |
| `ApiError` | Other HTTP 4xx/5xx responses, and `150.008` at any status |
| `UnconfirmedSendError` | HTTP 2xx on send whose body could not be read. The email may already have been accepted |
| `TransportError` | The request did not complete. `reason` is `timeout`, `dns`, `tls`, `connect`, `client`, `response`, or `unknown`, or `abort` or `redirect` |
| `ResponseTooLargeError` | A 2xx response is larger than `maxResponseBytes`. Has `maxBytes`, `status`, `receivedBytes`, `declaredBytes`. List, get, and attachments are not retried. An oversized non-2xx response maps by its status instead |
| `ConfigurationError` | The constructor rejected the options, including a browser-like runtime, a non-https base URL, or a private, link-local, reserved, or non-standard numeric base URL host |

`TransportError.reason` is taken from the fetch error, its `cause` chain, and their `code` values:

- `timeout`: the deadline passed, or a timeout such as `ETIMEDOUT` or `UND_ERR_CONNECT_TIMEOUT`.
- `dns`: the host could not be resolved (`ENOTFOUND`, `EAI_*`).
- `tls`: a certificate or TLS failure (`CERT_*`, `ERR_TLS_*`, `ERR_SSL_*`, self-signed).
- `connect`: a refused, reset, or closed connection, or any other network `TypeError` from `fetch`.
- `client`: a custom `fetch` threw an error that is not a network error.
- `response`: the response could not be read. An `UnconfirmedSendError` is always `response`.
- `unknown`: anything else, such as a `fetch` that rejects with a value that is not an `Error`.
- `abort`: your `signal` aborted the call.
- `redirect`: `fetch` refused a redirect.

The message ends with the reason in parentheses.

`UnconfirmedSendError` extends `TransportError`. Catch it first when that case needs different handling. After either error on send, check `list` or `get` before sending that email again.

Success codes `000.000` and `050.001` are not errors. `050.001` is an empty list.

## CommonJS

```js
const { MailBlaze } = require('@mailblaze/transactional');
```

## SMTP

This package does not speak SMTP. Mail Blaze SMTP is `smtp.mailblaze.net`, port `587`, with STARTTLS, authenticated by the customer API key. The SMTP username and the login method are not documented here.

## What this package does not do

It does not send campaigns, manage lists, or call the CRM API. It does not send in batches, receive webhooks, or set an idempotency key. Those are not on this API. It does not include a Nodemailer transport.

## Versioning

Pre-1.0 SemVer: minor versions may break. Supported versions are in [SECURITY.md](SECURITY.md). Releases are in [CHANGELOG.md](CHANGELOG.md). The HTTP contract is in [docs/openapi.yaml](docs/openapi.yaml).

## License

MIT. See [LICENSE](LICENSE).
