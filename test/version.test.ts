import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { MailBlaze, VERSION } from '../src/index.ts';

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };

test('VERSION matches package.json and package-lock.json', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(VERSION, pkg.version);
  assert.equal(MailBlaze.VERSION, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages['']?.version, pkg.version);
});

test('the client and User-Agent report the package version', async () => {
  let userAgent: string | null = null;
  const client = new MailBlaze({
    apiKey: 'mb-test-key',
    fetch: (request) => {
      userAgent = request.headers.get('user-agent');
      return Promise.resolve(Response.json({ status: 'success', code: '000.000', data: { records: [] } }));
    },
  });
  assert.deepEqual(client.toJSON(), { version: pkg.version });
  assert.equal(inspect(client), `MailBlaze { version: '${pkg.version}' }`);
  await client.list();
  assert.equal(userAgent, `mailblaze-transactional-node-sdk/${pkg.version}`);
});

test('CHANGELOG has an entry for the package version', () => {
  assert.ok(read('CHANGELOG.md').includes(`## [${pkg.version}] - `));
});
