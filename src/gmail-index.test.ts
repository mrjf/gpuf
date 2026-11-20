import {test,expect} from 'bun:test';
import {zipSync,strToU8} from 'fflate';
import {indexMessage,newBodyText,refreshIndexMetadata,type GmailMessage,type AttachmentIndexStatus} from './gmail-index.ts';
import {compileGmailQuery} from './gmail-query.ts';

const envelope=['From: Alice Example <alice@example.com>','To: Team: Bob <bob@example.com>, Carol <carol@example.com>;','Cc: Claire <claire@example.com>','Bcc: Private Person <private@example.com>','Subject: Lease renewal','Message-ID: <lease-123@example.com>','Delivered-To: Morgan <morgan@example.net>','Delivered-To: backup@example.net','List-ID: Building owners <building.example.com>','List-Post: <mailto:building@example.com>','X-Calendar-Notification: rsvpWithNote','Date: Tue, 17 Nov 2026 01:00:00 +0000'];
const message=(raw:string):GmailMessage=>({id:'m123',threadId:'thread123',internalDate:'1794877200000',historyId:'100',labelIds:['INBOX','UNREAD','Label_1','CATEGORY_UPDATES'],sizeEstimate:4400,raw:Buffer.from(raw).toString('base64url')});
const plain=(body:string)=>message([...envelope,'Content-Type: text/plain; charset=utf-8','','',body].join('\r\n'));
function multipart(attachments:{name:string;type:string;bytes:Uint8Array;inline?:boolean}[],body='Here are the documents.'){
  return message([...envelope,'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="mailparts"','','--mailparts','Content-Type: text/plain; charset=utf-8','',body,
    ...attachments.flatMap(a=>['--mailparts',`Content-Type: ${a.type}`,`Content-Disposition: ${a.inline?'inline':'attachment'}; filename="${a.name}"`,'Content-Transfer-Encoding: base64','',Buffer.from(a.bytes).toString('base64')]),'--mailparts--',''].join('\r\n'));
}
function alternative(plain:string,html:string){
  return [...envelope,'MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="alternatives"','','--alternatives','Content-Type: text/plain; charset=utf-8','',plain,'--alternatives','Content-Type: text/html; charset=utf-8','',html,'--alternatives--',''].join('\r\n');
}
function pdfWithText(text:string){
  const stream=`BT /F1 12 Tf 30 120 Td (${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('index preserves role-specific identities, headers and Gmail metadata without JSON-word pollution',async()=>{
  const index=await indexMessage({...plain('Welcome to the lease.'),queryFlags:['has:red-star']},'archive/raw.eml');
  expect(index.message.from_addresses).toEqual(['alice@example.com']);
  expect(index.message.to_addresses).toEqual(['bob@example.com','carol@example.com']);
  expect(index.message.cc_addresses).toEqual(['claire@example.com']);
  expect(index.message.bcc_text).toContain('Private Person');
  expect(index.message.people).not.toContain('"address"');
  expect(index.message.delivered_to_addresses).toEqual(['morgan@example.net','backup@example.net']);
  expect(index.message.list_ids).toEqual(['building.example.com','building@example.com']);
  expect(index.message.headers).toContain('x-calendar-notification:rsvpWithNote');
  expect(index.message.size).toBe(4400);
  expect(index.message.raw_size).toBeGreaterThan(0);
  expect(index.message.sort_key).toBe('2026-11-17T01:00:00.000Z:m123');
  expect(index.message.has_user_labels).toBe(true);
  expect(index.message.categories).toEqual(['updates']);
  expect(index.chunks[0]!.query_flags).toEqual(['has:red-star']);
});

test('clean ranking text preserves all original text for exact and positional matching',async()=>{
  const body='We agreed to waive the fee.\n\nOn Tuesday, Bob wrote:\n> Can we leave early?\n> Previous private reference.';
  const index=await indexMessage(plain(body),'archive/raw.eml');
  expect(String(index.message.body).trim()).toBe(body);
  expect(index.message.body_new).toBe('We agreed to waive the fee.');
  expect(index.message.literal).toContain('Previous private reference.');
  expect(index.message.search_tokens).toContain('previous private reference');
  expect(index.chunks[0]!.text).not.toContain('Previous private reference');
  expect(newBodyText('Hello\n-- \nAlice\nAddress')).toBe('Hello');
  expect(newBodyText('Literal -- punctuation\nnew content')).toBe('Literal -- punctuation\nnew content');
});

test('canonical positional text preserves field boundaries and Unicode identifiers',async()=>{
  const source=plain('Party costs 12.50 dollars. café déjà vu');
  source.raw=Buffer.from(Buffer.from(source.raw,'base64url').toString().replace('Subject: Lease renewal','Subject: Garden')).toString('base64url');
  const {message:row}=await indexMessage(source,'archive/raw.eml');
  expect(row.subject_tokens).toBe(' garden ');
  expect(row.search_tokens).toContain('12.50');
  expect(row.search_tokens).toContain('café déjà vu');
  expect(String(row.search_tokens)).not.toContain('garden party');
});

test('both body alternatives remain searchable without joining phrase or proximity boundaries',async()=>{
  const raw=alternative('Shared announcement.\n\nPlain exclusive alpha','<p>beta HTML exclusive unsubscribe.</p><p>Shared announcement.</p>');
  const {message:row}=await indexMessage(message(raw),'archive/raw.eml');
  expect(row.body).toContain('Plain exclusive alpha');
  expect(row.body).toContain('HTML exclusive unsubscribe');
  expect(String(row.body_new).match(/Shared announcement/g)).toHaveLength(1);
  for(const query of ['"HTML exclusive unsubscribe"','"Plain exclusive alpha"','alpha AROUND 0 beta','"alpha beta"']){
    expect(compileGmailQuery(query).matches(row)).toBe(!query.includes('alpha AROUND')&&!query.includes('"alpha beta"'));
  }
  const blank=await indexMessage(message(alternative(' \t\n','<p>The order is ready.</p>')),'archive/raw.eml');
  expect(blank.message.body_new).toBe('The order is ready.');
  expect(compileGmailQuery('"order is ready"').matches(blank.message)).toBe(true);
});

test('HTML alternatives add new ranking content without restoring repeated quoted text',async()=>{
  const raw=alternative('The fee is waived.\n\nOn Monday, Alice wrote:\n> Previous obligation.','<p>The fee is waived.</p><p>Refund timing is confirmed.</p><blockquote><p>Previous obligation.</p></blockquote>');
  const {message:row,chunks}=await indexMessage(message(raw),'archive/raw.eml');
  expect(row.body_new).toBe('The fee is waived.\n\nRefund timing is confirmed.');
  expect(chunks[0]!.text).not.toContain('Previous obligation');
  expect(compileGmailQuery('"Previous obligation"').matches(row)).toBe(true);
});

test('attached messages expose nested subjects, identities, both bodies and supported child attachments',async()=>{
  const inner=alternative('The order is ready.','<p>The order is ready.</p><p>Unsubscribe from shipping updates.</p>');
  const middle=multipart([{name:'receipt.eml',type:'message/rfc822',bytes:Buffer.from(inner)},{name:'terms.txt',type:'text/plain',bytes:strToU8('Refunds take seven days.')}],'Forwarded material.');
  const outer=multipart([{name:'forwarded.eml',type:'message/rfc822',bytes:Buffer.from(middle.raw,'base64url')}],' \n');
  const {message:row,chunks}=await indexMessage(outer,'archive/raw.eml');
  expect(row.attachment_complete).toBe(true);
  expect(JSON.parse(String(row.attachment_status))[0].status).toBe('indexed');
  for(const term of ['order','unsubscribe','"Refunds take seven days"','"Lease renewal"','"alice example com"'])expect(compileGmailQuery(term).matches(row)).toBe(true);
  expect(chunks.some(chunk=>String(chunk.source).includes('forwarded.eml')&&String(chunk.text).includes('order'))).toBe(true);
  expect(compileGmailQuery('"ready the order"').matches(row)).toBe(false);
});

test('nested message extraction retains partial text and exposes depth, count and output limits',async()=>{
  let nested=Buffer.from(plain('Deepest message.').raw,'base64url');
  for(let i=0;i<9;i++)nested=Buffer.from(multipart([{name:'child.eml',type:'message/rfc822',bytes:nested}],`Layer ${i}.`).raw,'base64url');
  const deep=await indexMessage(multipart([{name:'deep.eml',type:'message/rfc822',bytes:nested}]),'archive/raw.eml');
  const deepStatus=JSON.parse(String(deep.message.attachment_status))[0];
  expect(deepStatus.status).toBe('too-large');
  expect(deepStatus.reason).toContain('depth, count, byte or time');
  expect(deep.message.attachment_complete).toBe(false);
  expect(deep.message.literal).toContain('Layer 8.');
  expect(deep.message.literal).not.toContain('Deepest message.');
  const many=await indexMessage(multipart(Array.from({length:65},(_,i)=>({name:`message-${i}.eml`,type:'message/rfc822',bytes:Buffer.from(plain(`Message ${i}.`).raw,'base64url')}))),'archive/raw.eml');
  const states=JSON.parse(String(many.message.attachment_status));
  expect(states.filter((state:AttachmentIndexStatus)=>state.status==='indexed')).toHaveLength(64);
  expect(states[64].status).toBe('too-large');
  const large=await indexMessage(multipart([{name:'large.eml',type:'message/rfc822',bytes:Buffer.from(plain('x'.repeat(2*1024*1024)).raw,'base64url')}]),'archive/raw.eml');
  expect(JSON.parse(String(large.message.attachment_status))[0].status).toBe('too-large');
});

test('PDF, Office and text attachment contents are indexed with source chunks',async()=>{
  const docx=zipSync({'word/document.xml':strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Cancellation &amp; termination terms</w:t></w:r></w:p></w:body></w:document>')});
  const source=multipart([
    {name:'lease.pdf',type:'application/pdf',bytes:pdfWithText('The renewal fee is waived.')},
    {name:'terms.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:docx},
    {name:'notes.txt',type:'text/plain',bytes:strToU8('The deposit is refundable.')},
  ]);
  const index=await indexMessage(source,'archive/raw.eml');
  expect(JSON.parse(String(index.message.attachment_status)).filter((status:AttachmentIndexStatus)=>status.status!=='indexed')).toEqual([]);
  expect(index.message.has_attachment).toBe(true);
  expect(index.message.literal).toContain('The renewal fee is waived.');
  expect(index.message.literal).toContain('Cancellation & termination terms');
  expect(index.message.literal).toContain('The deposit is refundable.');
  expect(index.message.attachment_complete).toBe(true);
  expect(JSON.parse(String(index.message.attachment_status)).map((s:AttachmentIndexStatus)=>s.status)).toEqual(['indexed','indexed','indexed']);
  expect(index.chunks.some(chunk=>String(chunk.source).includes('lease.pdf')&&String(chunk.text).includes('waived'))).toBe(true);
});

test('unsupported or oversized attachments remain visible and do not pretend full coverage',async()=>{
  const oversized=zipSync({'word/document.xml':strToU8('<document>'+ 'x'.repeat(2*1024*1024)+'</document>')});
  const source=multipart([{name:'scan.png',type:'image/png',bytes:new Uint8Array([1,2,3]),inline:true},{name:'large.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:oversized}]);
  const index=await indexMessage(source,'archive/raw.eml');
  const states:AttachmentIndexStatus[]=JSON.parse(String(index.message.attachment_status));
  expect(states[0]!.status).toBe('unsupported');
  expect(states[0]!.reason).toContain('OCR');
  expect(states[1]!.status).toBe('too-large');
  expect(index.message.attachment_complete).toBe(false);
  expect(index.message.attachment_names).toEqual(['scan.png','large.docx']);
});

test('label-only changes preserve semantic input and derived query flags',async()=>{
  const original=await indexMessage({...plain('The landlord approved the request.'),queryFlags:['has:red-star']},'archive/raw.eml');
  const refreshed=refreshIndexMetadata(original,{labelIds:['STARRED','IMPORTANT','CATEGORY_PERSONAL']});
  expect(refreshed.message.unread).toBe(false);
  expect(refreshed.message.in_inbox).toBe(false);
  expect(refreshed.message.starred).toBe(true);
  expect(refreshed.message.important).toBe(true);
  expect(refreshed.message.query_flags).toEqual(['has:red-star']);
  expect(refreshed.chunks.map(chunk=>chunk.text)).toEqual(original.chunks.map(chunk=>chunk.text));
  expect(original.message.unread).toBe(true);
});

test('link predicates use parsed hostnames and inline images count as attachments',async()=>{
  const index=await indexMessage(multipart([{name:'logo.png',type:'image/png',inline:true,bytes:new Uint8Array([1])}],
    'https://docs.google.com/document/d/a https://docs.google.com/spreadsheets/d/b https://docs.google.com/presentation/d/c https://youtu.be/123 https://youtube.com.evil.invalid/watch'), 'archive/raw.eml');
  expect(index.message.has_attachment).toBe(true);
  expect(index.message.link_types).toEqual(['document','drive','presentation','spreadsheet','youtube']);
});

test('Gmail attachment presence includes named CID images used by the HTML body',async()=>{
  const raw=[...envelope,'MIME-Version: 1.0','Content-Type: multipart/related; boundary="related-parts"','','--related-parts','Content-Type: text/html','','<p>See the diagram.</p><img src="cid:diagram">','--related-parts','Content-Type: image/png','Content-Disposition: inline; filename="diagram.png"','Content-ID: <diagram>','Content-Transfer-Encoding: base64','','AQID','--related-parts--'].join('\r\n');
  const index=await indexMessage(message(raw),'archive/raw.eml');
  expect(index.message.attachment_names).toEqual(['diagram.png']);
  expect(index.message.has_attachment).toBe(true);
  expect(index.chunks[0]!.has_attachment).toBe(true);
});

test('snippets and embedding envelope truncation never split a Unicode surrogate pair',async()=>{
  const subject='s'.repeat(999)+'😀 ending',name='n'.repeat(999)+'🚀 person',body='b'.repeat(299)+'🌈 body';
  const raw=[`From: ${name} <alice@example.com>`,`Subject: ${subject}`,'Content-Type: text/plain; charset=utf-8','',body].join('\r\n');
  const index=await indexMessage(message(raw),'archive/raw.eml');
  expect(String(index.message.snippet)).toBe('b'.repeat(299)+'🌈');
  expect(String(index.chunks[0]!.snippet)).toBe('b'.repeat(299)+'🌈');
  expect(String(index.chunks[0]!.text)).toContain('s'.repeat(999)+'😀\n');
  expect(String(index.chunks[0]!.text)).toContain('n'.repeat(999)+'🚀\n');
  for(const row of [index.message,...index.chunks])for(const value of Object.values(row))if(typeof value==='string')expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

test('reranker passage bounds Unicode safely while retaining new intent, identities and attachment evidence',async()=>{
  const body='The landlord agreed to waive the remaining lease obligation.\n'+'😀'.repeat(8000)+'\nOn Tuesday, Bob wrote:\n> Obsolete quoted proposal.';
  const source=multipart([{name:'refund-terms.txt',type:'text/plain',bytes:strToU8('The full security deposit will be returned.')}],body);
  const index=await indexMessage(source,'archive/raw.eml');
  const passage=String(index.message.rerank_text);
  expect(Array.from(passage).length).toBe(6000);
  expect(passage).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  expect(passage).toContain('Lease renewal');
  expect(passage).toContain('alice@example.com');
  expect(passage).toContain('waive the remaining lease obligation');
  expect(passage).toContain('refund-terms.txt: The full security deposit will be returned.');
  expect(passage).not.toContain('Obsolete quoted proposal');
  expect(index.message.literal).toContain('Obsolete quoted proposal');
});

test('Gmail syntax dates use the first valid receipt header while display dates retain internalDate',async()=>{
  const indexed=async(headers:string[])=>indexMessage(message([...envelope,...headers,'Content-Type: text/plain; charset=utf-8','','Receipt date test.'].join('\r\n')),'archive/raw.eml');
  const first=await indexed([
    'Received: from sender.example by mx.google.com; Tue, 17 Nov 2026 04:00:00 +0000',
    'X-Received: by 2002:123:456 with SMTP id abc; Mon, 16 Nov 2026 18:00:00 -0800 (PST)',
    'X-Received: by 2002:123:789 with SMTP id def; Tue, 17 Nov 2026 03:00:00 +0000',
  ]);
  expect(first.message.search_received_at).toBe('2026-11-17T02:00:00.000Z');
  expect(first.chunks[0]!.search_received_at).toBe(first.message.search_received_at);
  expect(first.message.received_at).toBe('2026-11-17T01:00:00.000Z');
  const malformed=await indexed(['X-Received: invalid date; not-a-date','X-Received: by internal; Tue, 17 Nov 2026 03:00:00 +0000']);
  expect(malformed.message.search_received_at).toBe('2026-11-17T03:00:00.000Z');
  const google=await indexed(['Received: from a.example by external.example; Tue, 17 Nov 2026 00:30:00 +0000','Received: from a.example by mx.google.com; Tue, 17 Nov 2026 01:30:00 +0000']);
  expect(google.message.search_received_at).toBe('2026-11-17T01:30:00.000Z');
  for(const headers of [[],['Received: from a.example by mx.google.com.evil.invalid; Tue, 17 Nov 2026 05:00:00 +0000'],['X-Received: no separator','Received: by mx.google.com; invalid']]){
    const noReceipt=await indexed(headers);expect(noReceipt.message.search_received_at).toBe(noReceipt.message.received_at);
  }
});
