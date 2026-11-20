import { MailBlaze } from '../dist/index.js';

const apiKey = process.env.MAILBLAZE_API_KEY;
if (!apiKey) {
  throw new Error('Set MAILBLAZE_API_KEY');
}

const mailblaze = new MailBlaze({ apiKey });
const sent = await mailblaze.send({
  to: { email: 'jane@example.com', name: 'Jane Doe' },
  from: { email: 'billing@example.com', name: 'Acme' },
  subject: 'Your order',
  templateId: 'ab123456-1234-1234-1234-123456789abc',
  mergeTags: { NAME: 'Jane', ORDER_ID: '1001' },
});

console.log(sent.emailUid);
