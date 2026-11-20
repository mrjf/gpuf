# Gmail-compatible search on turbopuffer

**[Copy the agent instructions →](https://raw.githubusercontent.com/mrjf/gpuf/main/AGENT-INSTRUCTIONS.md)**

Paste this line into your coding agent:

```text
Implement Gmail-compatible email search in my project. Follow https://raw.githubusercontent.com/mrjf/gpuf/main/AGENT-INSTRUCTIONS.md and use the reference indexing and search code it links to. Adapt it to my project's language and run the tests.
```

A search such as `to:me has:attachment subject:"delivery receipt" -is:unread` asks which messages satisfy **every** condition. Parse those conditions into database filters, apply them to individual messages, and page through the matches newest first. For a question such as “which parcel arrived on Tuesday?”, the same index also supports ranked retrieval over message text and attachment passages.

## Run the reference

```sh
git clone https://github.com/mrjf/gpuf.git
cd gpuf
bun install --frozen-lockfile
bun test src
bun run demo
```

The reference uses Bun (tested with 1.4.4). The offline demo decodes a synthetic email, builds its message and passage rows, and checks a sender-plus-subject query. To exercise turbopuffer, set `TURBOPUFFER_API_KEY` and `TURBOPUFFER_REGION` in your shell, then run `bun run examples/demo.ts --live`. It creates a fresh pair of synthetic namespaces, writes both schemas, checks strict and semantic retrieval, and prints the namespace names for inspection. Use a region with native embedding support. [Runnable example](examples/demo.ts) · [turbopuffer regions](https://turbopuffer.com/docs/regions) · [Native embedding](https://turbopuffer.com/docs/embedding)

| File | Use it for |
| --- | --- |
| [gmail-index.ts](src/gmail-index.ts) | Both schemas, MIME and attachment decoding, row construction, positional text, chunking, label patches |
| [gmail-query.ts](src/gmail-query.ts) | Tokenizer, parser, filter compiler, in-memory predicate evaluator |
| [gmail-search.ts](src/gmail-search.ts) | Strict listings, cursors, BM25, fuzzy search, passage retrieval, fusion and reranking |
| [gmail-query-state.ts](src/gmail-query-state.ts) | Source-derived labels and special-state memberships, resumable refresh and publication |
| [turbopuffer.ts](src/turbopuffer.ts) | Namespace naming, batched upserts and the REST query adapter |

## What goes in the index

Give each mailbox and index generation two namespaces. A message can change folders, acquire a star, or receive a reply in the same thread. Keeping one row per **message ID** gives each result its own date, labels and attachments. Keep the thread ID for opening the conversation. The second namespace contains passages keyed by message ID, section ordinal and Unicode code-point offset. Keep the original RFC 822 bytes in durable storage so either index can be rebuilt.

| Message representation | What it makes possible |
| --- | --- |
| Lowercased addresses by role, participants, Delivered-To, RFC Message-ID, headers and list IDs | Exact identity and header predicates. Gmail syntax `to:` searches To, Cc and Bcc. |
| Labels, categories, source flags, booleans, sizes and dates | Filter before pagination. `received_at` comes from Gmail’s `internalDate`. `search_received_at` uses the first valid X-Received timestamp, then a Google Received timestamp, then the internal date. |
| Full plain text, rendered HTML, names, filenames and attachment text | Find material in quoted replies and alternate MIME parts. Keep attachment extraction statuses alongside the text. |
| Canonical text streams for each searchable source | Match terms, ordered phrases and proximity using the same tokenizer at write and query time. A phrase can’t start in the subject and end in the body. |
| `body_new` and `rerank_text` | Rank newly written material without repeatedly rewarding quoted replies. Bound the reranker input to 6,000 code points, including up to 1,200 for attachments. |

The positional tokenizer uses Unicode NFKC and lowercase, keeps decimal numbers together, and converts `1,500` to `1500`. Full-text ranking fields separately pin turbopuffer’s `word_v4` tokenizer with stemming and stopword removal disabled. Preserve both representations in a port. The exact field names, types, regex and fuzzy indexes are executable declarations at the top of the indexer. [Schema and row builder](src/gmail-index.ts) · [Tokenizer](src/gmail-query.ts)

Attachment extraction covers supported text and HTML, text-bearing PDFs, supported Office/OpenDocument XML, and nested RFC 822 messages. Inline MIME attachments count for `has:attachment`. Each part records `indexed`, `unsupported`, `too-large`, or `failed`. Images and scanned PDFs need an additional OCR stage. The reference caps extracted text at 2 MiB per attachment and budgets 7 MiB for searchable source text per message.

Split newly written body text and each extracted attachment section into 3,000-code-point passages, stepping forward 2,600 at a time. Prefix the embedding input with subject and participants, plus the attachment source where applicable. The chunk schema uses native `voyage/voyage-4`, 1,024 dimensions, f16 and cosine distance. Chunk filter metadata lets the search planner narrow passage retrieval before checking the parent message.

## Import a mailbox and keep it current

The repository supplies the transformation, query logic, and batch writer. Connect your application's OAuth, durable store and background worker at these points.

1. **Select the mailbox.** Derive namespace names from an authenticated, stable account ID and an indexing generation. Capture a Gmail history ID **before** enumerating old mail. Use read-only Gmail access for listing, raw message reads, labels and history. [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)
2. **Archive a page.** List message IDs with `includeSpamTrash=true` and a fixed upper time boundary. Persist the pending page and next token. Fetch each message with `format=raw`. Preserve its base64url RFC 822 bytes, IDs, labels, internal date, history ID and size estimate. Save the original before indexing. [Gmail message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
3. **Write both indexes.** Call `indexMessage(rawMessage, archiveKey)` once per message, then `client.upsert(namespaces, indexedMessages)` for the page. Batch up to 32 message rows and 128 passages per request. Commit the checkpoint only after all writes succeed. Stable row IDs let a failed page replay. For a content replacement, compare the old and new chunk IDs and delete obsolete IDs before acknowledging the update. [Batch writer](src/turbopuffer.ts) · [turbopuffer writes](https://turbopuffer.com/docs/write)
4. **Keep source state current.** The 19 predicates in `GMAIL_SOURCE_FLAGS` include colored stars, archive, snooze, mute, purchases and chats. For instance, Gmail’s archive membership cannot reliably be inferred from the absence of the Inbox label. Drive `advanceQueryState` with a durable get/put store, a read-only Gmail request adapter and one serialized writer per mailbox. Add `flagsForMessage(snapshot, id)` to every incoming message as `queryFlags`. On refresh, use the `applyChanges` callback to patch changed parents and their chunks before publishing the new snapshot. Use its label map and capabilities as query context. [Membership synchronizer](src/gmail-query-state.ts)
5. **Replay history.** Ingest new messages, patch labels on both namespaces, and remove permanently deleted messages and their known chunk IDs from search. Advance the history ID after the last page commits. On an expired history cursor (HTTP 404), take a new baseline, reconcile the full ID listing, and reuse archived originals. Honor quota backoff. When the tokenizer, schema or extraction changes, build a new generation from originals and switch readers after validating coverage.

## Execute a search

```ts
import { searchMailIndex } from './src/gmail-search.ts';
import { connect, namespacesFor } from './src/turbopuffer.ts';

const client = connect(region, apiKey);
const namespaces = namespacesFor(authenticatedMailboxId);
const context = { me: mailboxAddress, aliases, labels, capabilities };
const page = await searchMailIndex({
  mode: 'gmail', query: 'from:lee@example.org has:attachment', limit: 10,
}, context, namespaces, client.query);
```

The application supplies the values above. Labels are `{id, name}` pairs. Supply only source capabilities backed by a committed snapshot. Validate public inputs at the boundary, including a page limit of 1–100. To continue, pass `page.nextCursor` with the same query, mode and mailbox. The cursor binds the query and generation and fixes the clock for relative dates. It does not freeze subsequent mailbox changes.

| Mode | Matching and ordering |
| --- | --- |
| `gmail` | Compile the expression to hard predicates. Exclude Spam and Trash by default. Sort descending by `sort_key` (receipt timestamp plus message ID), fetch one extra row, and keyset-page until exhausted. |
| `exact` | Use `text` for a case-sensitive literal substring, including punctuation. Return chronological pages. |
| `words` | Use weighted BM25. A supplied Gmail `query` also enforces its literal predicates. |
| `semantic` | Search embedded passages and check the full predicate on each parent before returning it. |
| `hybrid` | Combine lexical, fuzzy and semantic candidates. Preserve explicit fields, quotes, exclusions and proximity. |

The parser supports implicit AND, explicit `AND` and `OR`, brace alternatives, scoped parentheses, exclusions, quotes, `+word`, and ordered or unordered `AROUND`. It compiles address, subject, filename, size, date, label, category, state, location, link, list, RFC Message-ID and header operators. Unknown colon prefixes such as `status:approved` remain literal text. A malformed recognized operator or missing required source capability raises an error. [Compiler](src/gmail-query.ts) · [Operator test cases](src/gmail-query.test.ts)

BM25 weights subject **4**, people, filenames and new body **2** each, and full body and attachment text **1** each. Hybrid adds fuzzy matching for words of six or more characters. Each branch asks for `min(1000, max(100, 6 × limit))` candidates. Collapse passage hits by message, enforce the parent predicate, then fuse ranks with `1 / (60 + rank)` per unique message per branch. Eligible longer queries rerank up to 30 candidates using `voyage/rerank-3-lite`. Ranked results are bounded. Report `queryComplete` separately from the application’s `backfillComplete`. [Search planner](src/gmail-search.ts)

Compatibility targets Gmail API **message** results. Gmail’s UI also expands conversations and may infer additional aliases. This implementation uses UTC midnight for calendar dates, while Google documents PST. Use epoch seconds for unambiguous boundary tests. Gmail’s size estimate, tokenization and certain brace expressions also produce observable differences. [Google’s operator guide](https://support.google.com/mail/answer/7190?hl=en) · [Gmail API and UI differences](https://developers.google.com/workspace/gmail/api/guides/filtering)

## How we tested compatibility

1. **Test the compiler and row builder together.** Run `bun test src`. The synthetic fixtures cover positive and negative operator cases, MIME alternatives, PDF/Office/nested attachments, fields split across phrase boundaries, Cc/Bcc, dates, tied timestamps, cursor reuse, parent eligibility and replay after interrupted state updates. The offline evaluator gives a fast oracle for a port. Also run the live fixture to exercise the actual database.
2. **Freeze the corpus and cases.** Record the index generation, mailbox ID census, source date and ingestion coverage privately. Sample real messages and derive field, phrase, date, attachment, exclusion and no-match cases with known targets. Include both positive and empty controls. Freeze separate holdout queries before tuning.
3. **Compare complete message-ID sets.** Submit the identical expression to Gmail `users.messages.list(q=…)` and strict index search. Follow every page on both sides and deduplicate IDs. Respect Gmail's default Spam/Trash scope. For a partial index, intersect the complete Gmail result with the frozen ID census and report out-of-corpus matches separately. Report missing and extra IDs, both-empty cases, errors, and incomplete traversals. A page cap, repeated cursor or failed request leaves the comparison incomplete.
4. **Evaluate ranking separately.** For typo and paraphrase queries, record known-target rank and top-three usefulness. Read source evidence, blind the two ranked lists as A/B, allow ties and insufficient evidence, and include plausible queries with no correct answer. Ranked top-k overlap cannot establish strict equality.

The recorded development suite had **664 queries** covering 613 strict syntax cases, 33 typos and 18 paraphrases. On a frozen **2,976-message** corpus, **607 of 613** strict result sets agreed after rebuilding the message index. **569** queries were empty on both sides in the original diagnostic, so aggregate agreement alone overstates positive operator coverage. The six remaining discrepancies included three brace expressions, quoted history, a subject word and an unsubscribe match. This was a partial-corpus development run. No private queries, identifiers or mail are required to run the repository tests.

## How fast was it compared with Gmail?

On November 20, 2026, we timed the first page an application could display. Each side returned up to **ten message summaries**. Gmail used one message-list call followed by a batched metadata read. The index used one strict search with stored summary fields. Both were timed from the same client through the same application transport, through receipt and decoding of the response.

| First-page latency, successful pairs | Median | p95 |
| --- | ---: | ---: |
| turbopuffer-backed strict search | **361 ms** | **531 ms** |
| Gmail API with message summaries | **1,338 ms** | **5,192 ms** |

The index returned the page first in all **15 completed pairs**. Of 24 attempts per side, the index completed 24 and Gmail completed 15. The table includes only pairs where both succeeded. All 15 had ten results on each side. Twelve pairs had identical ID sets. Summing the ID overlap within each pair gives **147 shared hits out of 150**. Backfill was incomplete throughout. With 15 pairs, nearest-rank p95 is the slowest completed request. This run measures four repeated API queries and leaves Gmail web UI latency and full-mailbox performance open.

**Repeat the speed test**

1. From one client, use `in:inbox`, `in:sent`, `has:attachment` and `subject:receipt`. Run six rounds. Rotate the starting query by one each round and alternate which backend goes first for each query. Run requests serially with a 30-second deadline and no retries. Include the first round. The run used ordinary service caches throughout.
2. Request ten summaries from each backend. For Gmail, list up to ten IDs, then batch `messages.get(format=metadata)` for From, To, Subject, Date, labels, thread ID and snippet. For the index, call `searchMailIndex` with `mode: 'gmail'` and `limit: 10` through the application. Start a monotonic timer before the request and stop after decoding the summaries.
3. Record both elapsed times, returned counts, ID-set overlap, coverage and failures. For completed pairs, sort each side’s durations and report the entries at ranks `ceil(0.50 × n)` and `ceil(0.95 × n)`. Keep failed requests in the attempt counts. For a broader benchmark, repeat on a fully synchronized corpus and report cold starts, steady-state latency, and time to enumerate all pages separately.

A separate **IDs-only** Gmail baseline across 664 queries had a first-page median of **366 ms** and p95 of **1,330 ms**. It skipped summary hydration and allowed up to 500 IDs per page. Use that baseline for the cost of finding IDs. Use the paired table above for the cost of displaying a page of results.
