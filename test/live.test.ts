import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailBlaze } from '../src/index.ts';

const apiKey = process.env['MAILBLAZE_API_KEY'];
const fromEmail = process.env['MAILBLAZE_FROM_EMAIL'];
const toEmail = process.env['MAILBLAZE_TO_EMAIL'];
const enabled = process.env['MAILBLAZE_LIVE'] === '1' && apiKey !== undefined && fromEmail !== undefined && toEmail !== undefined;

test(
  'a live send is accepted and queued, not checked for delivery',
  { skip: enabled ? false : 'Set MAILBLAZE_LIVE=1, MAILBLAZE_API_KEY, MAILBLAZE_FROM_EMAIL, and MAILBLAZE_TO_EMAIL' },
  async () => {
    if (apiKey === undefined || fromEmail === undefined || toEmail === undefined) {
      return;
    }
    const client = new MailBlaze({ apiKey });
    const sent = await client.send({
      to: { email: toEmail, name: 'Mail Blaze SDK' },
      from: { email: fromEmail, name: 'Mail Blaze SDK' },
      subject: 'Node SDK live check',
      html: '<p>Accepted means queued, not delivered.</p>',
      text: 'Accepted means queued, not delivered.',
    });
    assert.equal(sent.accepted, true);
    assert.equal(typeof sent.emailUid, 'string');
    assert.equal(sent.emailUid.length > 0, true);
  },
);
