import { indexMessage } from '../src/gmail-index.ts';
import { compileGmailQuery } from '../src/gmail-query.ts';
import { searchMailIndex } from '../src/gmail-search.ts';
import { connect, namespacesFor } from '../src/turbopuffer.ts';

const raw = [
  'From: Lee <lee@example.org>',
  'To: Pat <pat@example.net>',
  'Subject: Delivery receipt',
  'Message-ID: <delivery@example.org>',
  'Content-Type: text/plain; charset=utf-8',
  '', 'The parcel arrived on Tuesday.',
].join('\r\n');
const indexed = await indexMessage({
  id: 'delivery-1', threadId: 'delivery', labelIds: ['INBOX'], historyId: '1',
  internalDate: String(Date.UTC(2025, 0, 14)), raw: Buffer.from(raw).toString('base64url'),
}, 'objects/delivery.eml');
const query = 'from:lee@example.org subject:"delivery receipt"';
if (!compileGmailQuery(query).matches(indexed.message)) throw new Error('Fixture did not match');

if (process.argv.includes('--live')) {
  const client = connect(process.env.TURBOPUFFER_REGION ?? '', process.env.TURBOPUFFER_API_KEY ?? '');
  const namespaces = namespacesFor('synthetic-demo-' + crypto.randomUUID());
  console.log('Fixture namespaces', namespaces);
  await client.upsert(namespaces, [indexed]);
  const page = await searchMailIndex({ query, mode: 'gmail' }, {}, namespaces, client.query);
  const passages = await searchMailIndex({ text: 'parcel', mode: 'semantic' }, {}, namespaces, client.query);
  for (const result of [page, passages]) {
    if (result.rows[0]?.id !== indexed.message.id) throw new Error('Fixture retrieval failed');
  }
  console.log('Strict and semantic searches returned', indexed.message.id);
} else {
  console.log('Matched', indexed.message.id, 'with', indexed.chunks.length, 'semantic chunk(s)');
}
