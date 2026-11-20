import { CHUNK_SCHEMA, MESSAGE_SCHEMA, INDEX_GENERATION, hash, type IndexedMessage, type Row } from './gmail-index.ts';
import type { MailQuery } from './gmail-search.ts';

export function namespacesFor(mailboxId: string) {
  if (!mailboxId.trim()) throw new Error('A stable mailbox ID is required');
  const prefix = `gpuf-${hash(mailboxId).slice(0, 32)}-${INDEX_GENERATION}`;
  return { messages: prefix + '-messages', chunks: prefix + '-chunks' };
}

export function connect(region: string, apiKey: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region) || !apiKey) {
    throw new Error('Set TURBOPUFFER_REGION and TURBOPUFFER_API_KEY');
  }
  const origin = `https://${region}.turbopuffer.com`;
  async function post(namespace: string, path: string, body: Record<string, unknown>) {
    const url = `${origin}/v2/namespaces/${encodeURIComponent(namespace)}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`turbopuffer ${response.status}: ${await response.text()}`);
    return response.json();
  }
  const query: MailQuery = async (namespace, body) => {
    const result = await post(namespace, '/query', body);
    if (!Array.isArray(result.rows)) throw new Error('Expected rows from turbopuffer');
    return { rows: result.rows as Row[] };
  };
  async function upsert(namespaces: ReturnType<typeof namespacesFor>, documents: IndexedMessage[]) {
    for (let i = 0; i < documents.length; i += 32) {
      await post(namespaces.messages, '', {
        schema: MESSAGE_SCHEMA, upsert_rows: documents.slice(i, i + 32).map(doc => doc.message),
      });
    }
    const chunks = documents.flatMap(doc => doc.chunks);
    for (let i = 0; i < chunks.length; i += 128) {
      await post(namespaces.chunks, '', {
        schema: CHUNK_SCHEMA, distance_metric: 'cosine_distance', upsert_rows: chunks.slice(i, i + 128),
      });
    }
  }
  return { query, upsert };
}
