# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-11-25

### Fixed

- `attachments()` returns a zero-byte file with empty `data`. Before, a file with empty `data` made the whole call throw `ApiError`.
- `VERSION`, `MailBlaze.VERSION`, and the `User-Agent` header report the package version. A test now fails when `VERSION` and `package.json` differ.

### Security

- Merge tag string values that contain a line break (CR, LF, U+0085, U+2028, U+2029) or another C0 or C1 control character, including tab, throw `ValidationError` before the request, the same rules as header fields.

## [0.1.1] - 2026-11-25

### Fixed

- README: removed an outdated note about `cc` and `replyTo`.

### Changed

- Packaging: consistent LF line endings in the repository (`.gitattributes`).

## [0.1.0] - 2026-11-18

### Added

- First public preview of the official Mail Blaze transactional client for Node.js.
- `docs/openapi.yaml` is included in the npm package. The README link points at that file.
- `send`, `list`, `get`, and `attachments` for the four transactional endpoints.
- Strict base64 encoding, exact `application/json` content type, the raw API key in `Authorization`, and `User-Agent: mailblaze-transactional-node-sdk/<version>`.
- Typed errors for codes `100.001` and `150.001`–`150.016`, plus HTTP 429. A 429 response with an API code such as `150.001` maps to that code's error, not `RateLimitError`. A transport failure is logged at `error` level, sensitive log fields are replaced with `[redacted]`, and the URL-encoded API key is redacted.
- Bounded retries for safe GET requests (connection failures, unreadable or empty success bodies, a 2xx body that is not a JSON object, and HTTP 429, 500, 502, 503, and 504), with exponential backoff from `retryDelayMs`, `Retry-After` (delta-seconds or an HTTP-date only; anything else, such as `-5`, is ignored), jitter, a 60-second cap, and the request deadline. `POST /transactional` is never retried. An oversized 2xx list, get, or attachments response fails once as `ResponseTooLargeError` and is not retried. An oversized non-2xx response is handled by its status: GET retries 429/5xx, and 404, 429, and other statuses map to `NotFoundError`, `RateLimitError`, or `ApiError` with `status` set. The body is discarded.
- The default timeout is 10 seconds (maximum 120). GET retries HTTP 429 and honors `Retry-After` with jitter and a 60-second cap. The `retryDelayMs` option (0–5000, default 200) is the base of an exponential backoff. Default `maxResponseBytes` is 16 MiB.
- `attachmentFromPath(path)` (Node.js only) and `sendAtDateTime(record, assumedTimeZone?)`. `sendAtDateTime` moves daylight saving gap times forward, and an abbreviation such as `EST` is a fixed offset. `attachmentFromPath` uses the same `window` and `document` check as the client. That check does not keep an API key out of a browser bundle.
- `TransportError.reason` is `timeout`, `dns`, `tls`, `connect`, `client`, `response`, `unknown`, `abort`, or `redirect`. A redirect reported on `error.cause` is a `redirect` transport error and is not retried. A 3xx response returned to the client is an `ApiError` for an unexpected redirect. A 4xx or 5xx body that fails while it is read maps by status instead of a `TransportError`. A redirect on send does not say the email may already have been accepted.
- A base URL with a backslash, whitespace, control character, fragment, or empty query string throws `ConfigurationError`.
- Header fields and filenames are trimmed of ASCII whitespace before validation. C1 control characters are rejected. Email addresses allow IP-literal domains; numeric TLDs and dotless domains are rejected. Whitespace-only HTML is rejected.
- `sendAt` from a `Date` is sent as `YYYY-MM-DDTHH:MM:SS+00:00`. Any integer `perPage` is clamped to 10–50. Page counts returned as digit strings are accepted.
- `list` and `get` require string fields where the API must send a string. `EmailSummary` and `EmailRecord` fields are typed `string` where the API must send a string, and `send_at` must be a string, an integer, or `null`.
- A malformed `Content-Length` is ignored. The limit is enforced by counting streamed bytes. `ResponseTooLargeError` exposes `maxBytes`, `status`, `receivedBytes`, and `declaredBytes`, and includes them in its message. A `Content-Length` above `Number.MAX_SAFE_INTEGER` is still rejected, with `declaredBytes` left `undefined` and the raw header in the message, truncated to 32 characters plus `…`.

### Security

- The README warns that `attachmentFromPath` needs a trusted path, because a Windows UNC path (`\\host\share`) can send NTLM credentials to a remote host.
- A logger that throws, or returns a rejecting promise, is ignored and does not change a request's outcome or cause an unhandled rejection.
- A `Retry-After` wait is capped at 60 seconds (jitter excluded), and a GET is not retried when the wait would end after the request deadline.
- A non-JSON 2xx body gives a fixed error message. Response text, including any key prefix, is never copied into the error or its cause.
- A 2xx send whose JSON body is not an object is an `UnconfirmedSendError`, not an `ApiError`.
- Control characters (C0/C1, including CR, LF, ESC, BEL) and bidi controls (U+202A-U+202E, U+2066-U+2069) are removed from server error text. Line breaks, including U+2028/U+2029, and tabs become spaces.
- Merge tag names and values count toward the 15 MiB total size check, measured JSON-encoded as they are sent.
- Email addresses with a local part over 64 characters are rejected (RFC 5321).
- `baseUrl` hosts must be a hostname, a public IP address, or loopback (`127.0.0.1`, `::1`). Private, link-local, and reserved IP ranges (including `169.254.169.254`, IPv4-mapped IPv6, `fc00::/7`, and `fe80::/10`) and numeric hosts such as `0x7f.1` or `2130706433` throw `ConfigurationError`. There is no opt-out.
- Options that are not an object, or a non-function `fetch`, throw `ConfigurationError` at construction.
- Negative, fractional, or unsafe page counts in a list response are an `ApiError` that names the field.
- CI actions are pinned to commit SHAs, workflows run with read-only tokens and no persisted checkout credentials, Dependabot watches actions and npm, and a CodeQL workflow is added.
- Releases publish from Node 24 with npm trusted publishing (OIDC) through the protected `npm-publish` environment, after `npm audit --audit-level=high` and a check that npm is 11.5.1 or later. No npm token secret is used.

[0.1.2]: https://github.com/mailblaze/mailblaze-transactional-node-sdk/releases/tag/v0.1.2
[0.1.1]: https://github.com/mailblaze/mailblaze-transactional-node-sdk/releases/tag/v0.1.1
[0.1.0]: https://github.com/mailblaze/mailblaze-transactional-node-sdk/releases/tag/v0.1.0
