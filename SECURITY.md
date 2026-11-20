# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

Security fixes are released for the latest 0.1.x version.

## Reporting a vulnerability

Report vulnerabilities privately to support@mailblaze.com. Do not open a public GitHub issue for a security problem. Do not include API keys, message bodies, or customer data in the report.

## How this package handles the API key

This package does not read environment variables. You pass the API key to `new MailBlaze({ apiKey })`, for example from your own `process.env.MAILBLAZE_API_KEY` or a secrets manager. It sends that key only in the `Authorization` header. It does not put the key in the URL. Requests use `redirect: 'error'`, so the key is not forwarded to another host, and a custom `baseUrl` must be `https` with a hostname, a public IP address, or loopback as its host. Private, link-local, reserved, and non-standard numeric IP hosts, such as cloud metadata addresses, are rejected. Exception messages and library logs redact the key. `JSON.stringify()` and `util.inspect()` do not include the key, because it is not stored as an object property. The constructor throws when both `window` and `document` are present. That check does not keep an API key out of a browser bundle. Keep the key on the server.

## Sending safely

A timeout or a dropped connection on `POST /transactional` does not mean the message failed. The API may already have accepted it. Check `list` or `get` before sending the same message again.

`POST /transactional` is never retried, including after HTTP 429. The API has no idempotency key, so a retry can send the same email twice.