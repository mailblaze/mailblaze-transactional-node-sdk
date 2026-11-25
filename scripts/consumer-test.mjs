import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileUrl(new URL('..', import.meta.url));
const packed = JSON.parse(runNpm(['pack', '--json', '--silent'], { cwd: root, encoding: 'utf8' }));
const tarball = join(root, packed[0].filename);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

try {
  await smoke('module', 'smoke.mjs', `
    import { MailBlaze, VERSION, attachmentFromPath, sendAtDateTime } from '@mailblaze/transactional';
    const client = new MailBlaze({ apiKey: 'mb-consumer-key' });
    if (VERSION !== '${version}' || MailBlaze.VERSION !== '${version}') {
      throw new Error('ESM consumer reported VERSION ' + VERSION + ', expected ${version}');
    }
    if (typeof client.send !== 'function' || typeof client.list !== 'function') {
      throw new Error('ESM consumer did not receive the client methods');
    }
    if (typeof attachmentFromPath !== 'function' || typeof sendAtDateTime !== 'function') {
      throw new Error('ESM consumer did not receive the helpers');
    }
    if (sendAtDateTime({ sendAt: '2026-11-16 2:36:59 PM' })?.toISOString() !== '2026-11-16T14:36:59.000Z') {
      throw new Error('ESM sendAtDateTime returned an unexpected value');
    }
    const { writeFileSync, rmSync } = await import('node:fs');
    const file = new URL('./esm-invoice.txt', import.meta.url);
    writeFileSync(file, 'esm');
    try {
      const attachment = await attachmentFromPath((await import('node:url')).fileURLToPath(file));
      if (attachment.filename !== 'esm-invoice.txt' || Buffer.from(attachment.data).toString() !== 'esm') {
        throw new Error('ESM attachmentFromPath returned an unexpected value');
      }
    } finally {
      rmSync(file, { force: true });
    }
    console.log('esm ok');
  `);
  await smoke(undefined, 'smoke.cjs', `
    const { MailBlaze, VERSION, attachmentFromPath, sendAtDateTime } = require('@mailblaze/transactional');
    const client = new MailBlaze({ apiKey: 'mb-consumer-key' });
    if (VERSION !== '${version}' || MailBlaze.VERSION !== '${version}') {
      throw new Error('CJS consumer reported VERSION ' + VERSION + ', expected ${version}');
    }
    if (typeof client.send !== 'function' || typeof client.get !== 'function') {
      throw new Error('CJS consumer did not receive the client methods');
    }
    if (typeof attachmentFromPath !== 'function' || typeof sendAtDateTime !== 'function') {
      throw new Error('CJS consumer did not receive the helpers');
    }
    if (sendAtDateTime({ sendAt: 1763303819 })?.toISOString() !== '2025-11-16T14:36:59.000Z') {
      throw new Error('CJS sendAtDateTime returned an unexpected value');
    }
    const { writeFileSync, rmSync } = require('node:fs');
    const file = require('node:path').join(__dirname, 'cjs-invoice.txt');
    writeFileSync(file, 'cjs');
    attachmentFromPath(file)
      .then((attachment) => {
        if (attachment.filename !== 'cjs-invoice.txt' || Buffer.from(attachment.data).toString() !== 'cjs') {
          throw new Error('CJS attachmentFromPath returned an unexpected value');
        }
        console.log('cjs ok');
      })
      .finally(() => rmSync(file, { force: true }))
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  `);
} finally {
  rmSync(tarball, { force: true });
}

function smoke(type, filename, source) {
  const dir = mkdtempSync(join(tmpdir(), 'mailblaze-consumer-'));
  const manifest = { name: 'consumer', private: true };
  if (type !== undefined) {
    manifest.type = type;
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  try {
    runNpm(['install', '--silent', '--no-fund', '--no-audit', tarball], { cwd: dir, stdio: 'inherit' });
    writeFileSync(join(dir, filename), source);
    execFileSync(process.execPath, [filename], { cwd: dir, stdio: 'inherit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runNpm(args, options) {
  if (process.platform === 'win32') {
    const command = ['npm', ...args.map(quoteCmd)].join(' ');
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], options);
  }

  return execFileSync('npm', args, options);
}

function quoteCmd(arg) {
  if (/[\s"&|<>^]/.test(arg)) {
    return `"${arg.replaceAll('"', '""')}"`;
  }

  return arg;
}

function fileUrl(url) {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}
