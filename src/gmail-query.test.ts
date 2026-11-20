import {describe,expect,test} from 'bun:test';
import {compileGmailQuery,gmailTokenText,gmailTokens,parseGmailQuery,type GmailQueryContext} from './gmail-query.ts';

const context:GmailQueryContext={me:'morgan@example.test',aliases:['alias@example.test'],labels:[{id:'Label_1',name:'Family Travel'},{id:'Label_2',name:'Projects/Alpha'}],now:Date.parse('2026-11-19T12:00:00Z')};
function row(values:Record<string,unknown>={}){
  const result:Record<string,unknown>={id:'message-1',labels:['INBOX','UNREAD','Label_1'],from_addresses:['alice@example.test'],to_addresses:['morgan@example.test'],cc_addresses:['bob@example.test'],bcc_addresses:[],delivered_to_addresses:['alias@example.test'],received_at:'2026-11-18T12:00:00.000Z',size:1500000,unread:true,has_attachment:true,has_user_labels:true,link_types:['drive','document'],rfc_message_id:'note@example.test',list_ids:['news.example.test'],headers:['x-custom:First Value','x-other:second'],header_names:['x-custom','x-other'],subject:'Holiday plans',body:'A secret birthday party needs a signed rental agreement.',filenames:'Trip-2026.pdf',from_text:'Alice Example alice@example.test',to_text:'Morgan morgan@example.test',cc_text:'Bob bob@example.test',bcc_text:'',...values};
  for(const [source,target]of [['subject','subject_tokens'],['from_text','from_tokens'],['to_text','to_tokens'],['cc_text','cc_tokens'],['bcc_text','bcc_tokens'],['filenames','filenames_tokens']])result[target!]=gmailTokenText(String(result[source!]??''));
  result.search_received_at=Object.hasOwn(values,'search_received_at')?values.search_received_at:result.received_at;
  result.search_tokens=[result.subject,result.body,result.filenames,result.from_text,result.to_text].map(value=>gmailTokenText(String(value??''))).join('\n');
  return result;
}
const matches=(query:string,values:Record<string,unknown>={},options:GmailQueryContext={})=>compileGmailQuery(query,{...context,...options}).matches(row(values));

describe('Gmail grammar',()=>{
  test('explicit AND binds above OR, which binds above implicit conjunction',()=>{
    expect(matches('holiday OR unknown party')).toBe(true);
    expect(matches('(holiday OR unknown) missing')).toBe(false);
    expect(matches('{missing birthday} AND secret')).toBe(true);
    expect(matches('{missing unknown}')).toBe(false);
    expect(matches('-(holiday OR birthday)')).toBe(false);
    expect(matches('-(missing OR unknown)')).toBe(true);
    expect(matches('holiday OR missing missing')).toBe(false);
    expect(matches('missing holiday OR birthday')).toBe(false);
    expect(matches('holiday AND missing OR birthday')).toBe(true);
    expect(matches('{holiday AND missing birthday}')).toBe(true);
  });
  test('field scopes include their nested groups and phrases',()=>{
    expect(matches('subject:(holiday plans)')).toBe(true);
    expect(matches('subject:{holiday birthday}')).toBe(true);
    expect(matches('subject:(holiday birthday)')).toBe(false);
    expect(matches('subject:"holiday plans"')).toBe(true);
    expect(matches('subject:"plans holiday"')).toBe(false);
    expect(matches('from:(alice OR nobody)')).toBe(true);
    expect(matches('-from:(alice OR nobody)')).toBe(false);
  });
  test('rejects ambiguous/incomplete input instead of silently weakening it',()=>{
    for(const query of ['"unfinished','()','{}','foo OR','AND foo','from:','from: OR foo','subject:','filename: OR foo','foo )','(foo','+(-foo)','foo AROUND x bar','foo AROUND 1001 bar','foo AROUND 3'])expect(()=>parseGmailQuery(query)).toThrow();
    expect(()=>parseGmailQuery('('.repeat(33)+'word'+')'.repeat(33))).toThrow('too deeply');
  });
  test('hyphenated tokens, colons and escaped quotations survive lexing',()=>{
    expect(matches('filename:Trip-2026.pdf')).toBe(true);
    expect(matches('header:X-Custom:First')).toBe(true);
    expect(matches('"say \\"hello\\""',{body:'say "hello"'})).toBe(true);
    expect(matches('+AND',{body:'salt and pepper'})).toBe(true);
    expect(matches('+OR',{body:'salt or pepper'})).toBe(true);
    expect(matches('-AND',{body:'salt and pepper'})).toBe(false);
    expect(matches('+AROUND',{body:'look around'})).toBe(true);
  });
  test('URL schemes and unknown colon prefixes remain literal searchable terms',()=>{
    const url='https://www.example.test/resources/stair-remodel/';
    expect(parseGmailQuery(url)).toEqual({kind:'term',value:url,quoted:false,exact:true});
    expect(parseGmailQuery('status:approved')).toEqual({kind:'term',value:'status:approved',quoted:false,exact:true});
    expect(parseGmailQuery('status:')).toEqual({kind:'term',value:'status:',quoted:false,exact:false});
    for(const query of [url,`"${url}"`,url.replace('https://','')])expect(matches(query,{body:url})).toBe(true);
    expect(matches('https://missing.example.test/resources/stair-remodel/',{body:url})).toBe(false);
    for(const query of ['status:approved','"status:approved"','"status: approved"','status:'])expect(matches(query,{body:'Status: approved for delivery.'})).toBe(true);
    expect(matches('nonexistent:approved',{body:'Status: approved for delivery.'})).toBe(false);
    expect(matches('subject:holiday status:approved',{body:'Status: approved for delivery.'})).toBe(true);
    expect(matches('subject:missing status:approved',{body:'Status: approved for delivery.'})).toBe(false);
    expect(()=>compileGmailQuery('after:invalid')).toThrow('Invalid Gmail date');
    expect(()=>compileGmailQuery('has:unknown')).toThrow('Unknown Gmail content');
  });
  test('colon compounds require adjacent tokens within one field in strict and semantic modes',()=>{
    for(const mode of ['strict','semantic'] as const){
      expect(matches('status:approved',{body:'Status: approved for delivery.'},{mode})).toBe(true);
      expect(matches('status:approved',{body:'Status pending, approved later.'},{mode})).toBe(false);
      expect(matches('status:approved',{subject:'Status',body:'approved for delivery.'},{mode})).toBe(false);
      expect(matches('https://example.test/path',{body:'https request for example.test then path'},{mode})).toBe(false);
    }
    expect(matches('status approved',{body:'Status pending, approved later.'})).toBe(true);
    expect(matches('status:',{body:'Status pending, approved later.'})).toBe(true);
    const plan=compileGmailQuery('https://example.test/path status:approved the meal with the twenty dollar total',{mode:'semantic'});
    expect(plan.semanticText).toBe('the meal with the twenty dollar total');
    expect(compileGmailQuery('https://example.test/a/long/compound/path',{mode:'semantic'}).semanticText).toBeNull();
  });
});

describe('exact text and positions',()=>{
  test('canonical words preserve decimals, Unicode and normalized accents',()=>{
    expect(gmailTokens('01.2047-100 CAFÉ e\u0301lan')).toEqual(['01.2047','100','café','élan']);
    expect(gmailTokens('$1,500 12,345.67 1.500 1 500 12-345')).toEqual(['1500','12345.67','1.500','1','500','12','345']);
    for(const query of ['+1,500','+1500','"1,500"','"1500"'])expect(matches(query,{body:'Save up to $1,500'})).toBe(true);
    for(const query of ['+500','+1.500','"1 500"'])expect(matches(query,{body:'Save up to $1,500'})).toBe(false);
    expect(matches('Winter AROUND 12 500',{subject:'Winter savings up to $1,500',body:''})).toBe(false);
    expect(matches('Winter AROUND 12 1500',{subject:'Winter savings up to $1,500',body:''})).toBe(true);
    expect(matches('+secret')).toBe(true);
    expect(matches('+secrets')).toBe(false);
    expect(matches('+Maya’s',{body:'Maya is coming; there is an s elsewhere.'})).toBe(false);
    expect(matches('+Maya’s',{body:'Maya’s birthday'})).toBe(true);
    expect(matches('"secret birthday"')).toBe(true);
    expect(matches('"secret party"')).toBe(false);
    expect(matches('café',{body:'A CAFÉ visit'})).toBe(true);
    expect(matches('01.2047-100',{body:'Reference 01.2047 100'})).toBe(true);
  });
  test('phrases do not cross unrelated source fields',()=>{
    expect(matches('"plans a secret"')).toBe(false);
    expect(matches('plans secret')).toBe(true);
  });
  test('AROUND uses bounded token gaps and respects order when quoted',()=>{
    expect(matches('secret AROUND 0 birthday')).toBe(true);
    expect(matches('birthday AROUND 0 secret')).toBe(true);
    expect(matches('secret AROUND 0 party')).toBe(false);
    expect(matches('secret AROUND 1 party')).toBe(true);
    expect(matches('"secret AROUND 1 party"')).toBe(true);
    expect(matches('"party AROUND 1 secret"')).toBe(false);
    expect(matches('plans AROUND 100 secret')).toBe(false);
    expect(matches('subject:(holiday AROUND 0 plans)')).toBe(true);
    expect(()=>compileGmailQuery('subject:holiday AROUND 2 secret')).toThrow('same field');
  });
  test('semantic mode relaxes only positive unscoped nonexact terms',()=>{
    expect(matches('a different concept from:alice',{},{mode:'semantic'})).toBe(true);
    expect(matches('a different concept from:bob',{},{mode:'semantic'})).toBe(false);
    expect(matches('a different concept -secret',{},{mode:'semantic'})).toBe(false);
    expect(matches('a different concept +missing',{},{mode:'semantic'})).toBe(false);
    expect(matches('a different concept "missing phrase"',{},{mode:'semantic'})).toBe(false);
    expect(matches('a different concept subject:missing',{},{mode:'semantic'})).toBe(false);
    expect(compileGmailQuery('a different concept -secret from:alice',context).text).toBe('a different concept');
  });
});

describe('semantic verification intent',()=>{
  const plan=(query:string)=>compileGmailQuery(query,{...context,mode:'semantic'});
  test('free alternatives cannot become one conjunction of required facts',()=>{
    for(const query of [
      '(the receipt for twenty dollars) OR (the receipt for thirty dollars)',
      '{receipt invoice} for a meal under twenty dollars',
      'the receipt for twenty OR thirty dollars',
      'the receipt for twenty dollars (paid OR subject:pending)',
    ])expect(plan(query).semanticText).toBeNull();
    expect(plan('(subject:receipt OR filename:invoice) the meal costing less than twenty dollars').semanticText).toBe('the meal costing less than twenty dollars');
  });
  test('hard scopes, phrases, exact words, negation and proximity never become verifier requirements',()=>{
    for(const query of [
      'subject:"a very long statement about the amount owed"',
      'subject:(a very long statement about the amount owed)',
      'filename:"a very long invoice file name pdf"',
      '"a very long phrase about the amount owed"',
      '+one +two +three +four +five',
      'one AROUND 4 two three AROUND 4 four five AROUND 4 six',
      '-(a very long statement about the amount owed)',
    ])expect(plan(query).semanticText).toBeNull();
    expect(plan('from:alice@example.test +receipt "delivery charge" subject:invoice -cancelled the meal costing less than twenty dollars').semanticText).toBe('the meal costing less than twenty dollars');
  });
  test('conjunctive intent retains original order and repeated natural-language words',()=>{
    const query='from:alice@example.test the (meal with the) twenty dollar total';
    expect(plan(query).semanticText).toBe('the meal with the twenty dollar total');
    expect(plan(query).text).toBe('the meal with twenty dollar total');
    expect(plan('subject:invoice "payment made" +confirmed for the meal').semanticText).toBeNull();
    expect(plan('-(cancelled OR refunded) the meal with the twenty dollar total').semanticText).toBe('the meal with the twenty dollar total');
  });
});

describe('Gmail fields',()=>{
  test('addresses, display names and account aliases',()=>{
    expect(matches('from:alice@example.test')).toBe(true);
    expect(matches('from:alice@example.test.evil')).toBe(false);
    expect(matches('from:"Alice Example"')).toBe(true);
    expect(matches('from:Example')).toBe(true);
    expect(matches('from:@example.test')).toBe(true);
    expect(matches('from:@example.test',{from_text:'alice@example.test.evil'})).toBe(false);
    expect(matches('to:me')).toBe(true);
    expect(matches('to:me',{to_addresses:['alias@example.test']})).toBe(true);
    expect(matches('to:morgan@example.test',{to_addresses:['alias@example.test']})).toBe(true);
    expect(matches('cc:bob@example.test')).toBe(true);
    expect(matches('bcc:bob@example.test')).toBe(false);
    expect(matches('deliveredto:me')).toBe(true);
    expect(matches('deliveredto:alias@example.test')).toBe(true);
  });
  test('label names, system labels and categories',()=>{
    expect(matches('label:"Family Travel"')).toBe(true);
    expect(matches('label:Label_1')).toBe(true);
    expect(matches('label:unknown')).toBe(false);
    expect(matches('label:inbox')).toBe(true);
    expect(matches('-label:"Family Travel"')).toBe(false);
    for(const [value,id] of Object.entries({primary:'PERSONAL',social:'SOCIAL',promotions:'PROMOTIONS',updates:'UPDATES',forums:'FORUMS'}))expect(matches(`category:${value}`,{labels:[`CATEGORY_${id}`]})).toBe(true);
    for(const value of ['reservations','purchases'])expect(matches(`category:${value}`,{query_flags:[`category:${value}`]},{capabilities:[`category:${value}`]})).toBe(true);
  });
  test('to searches every recipient role while cc and bcc remain specific',()=>{
    expect(matches('to:bob@example.test')).toBe(true);
    expect(matches('-to:bob@example.test')).toBe(false);
    expect(matches('to:Bob')).toBe(true);
    expect(matches('to:me',{to_addresses:[],cc_addresses:['morgan@example.test']})).toBe(true);
    expect(matches('to:me',{to_addresses:[],cc_addresses:[],bcc_addresses:['alias@example.test']})).toBe(true);
    const blind={to_addresses:[],cc_addresses:[],bcc_addresses:['hidden@blind.test'],to_text:'',cc_text:'',bcc_text:'Hidden Recipient hidden@blind.test'};
    for(const query of ['to:hidden@blind.test','to:@blind.test','to:"Hidden Recipient"','to:(Hidden Recipient)'])expect(matches(query,blind)).toBe(true);
    expect(matches('to:(Hidden AROUND 0 Recipient)',blind)).toBe(true);
    expect(matches('cc:hidden@blind.test',blind)).toBe(false);
    expect(matches('bcc:hidden@blind.test',blind)).toBe(true);
    expect(matches('cc:morgan@example.test')).toBe(false);
    expect(matches('to:alice@example.test')).toBe(false);
  });
  test('default scope and explicit locations',()=>{
    expect(matches('holiday',{labels:['SPAM']})).toBe(false);
    expect(matches('holiday',{labels:['TRASH']})).toBe(false);
    expect(matches('in:anywhere holiday',{labels:['SPAM']})).toBe(true);
    expect(matches('in:spam holiday',{labels:['SPAM']})).toBe(true);
    expect(matches('in:trash holiday',{labels:['TRASH']})).toBe(true);
    expect(matches('-in:spam holiday',{labels:['TRASH']})).toBe(false);
    expect(matches('in:sent',{labels:['SENT']})).toBe(true);
    expect(matches('in:drafts',{labels:['DRAFT']})).toBe(true);
  });
  test('archive membership is independent of visible folder labels',()=>{
    const capabilities=['in:archive'];
    for(const labels of [[],['SENT'],['TRASH'],['DRAFT']]){
      expect(matches('in:anywhere in:archive',{labels,query_flags:['in:archive']},{capabilities})).toBe(true);
      expect(matches('in:anywhere in:archive',{labels,query_flags:[]},{capabilities})).toBe(false);
    }
    expect(()=>compileGmailQuery('in:archive',context)).toThrow('metadata');
  });
  test('state, attachments and linked content',()=>{
    expect(matches('is:unread')).toBe(true);
    expect(matches('is:read')).toBe(false);
    expect(matches('is:starred',{labels:['STARRED']})).toBe(true);
    expect(matches('is:important',{labels:['IMPORTANT']})).toBe(true);
    expect(matches('has:attachment has:userlabels')).toBe(true);
    expect(matches('has:nouserlabels')).toBe(false);
    expect(matches('has:drive has:document')).toBe(true);
    for(const value of ['spreadsheet','presentation','youtube'])expect(matches(`has:${value}`,{link_types:[value]})).toBe(true);
    expect(matches('filename:pdf')).toBe(true);
    expect(matches('filename:txt')).toBe(false);
  });
  test('header names, literal values, mailing lists and message IDs',()=>{
    expect(matches('header:X-Custom')).toBe(true);
    expect(matches('header:X-Custom:First')).toBe(true);
    expect(matches('header:X-Custom:second')).toBe(false);
    expect(matches('header:"X-Custom:First Value"')).toBe(true);
    expect(matches('list:news@example.test')).toBe(true);
    expect(matches('rfc822msgid:note@example.test')).toBe(true);
    expect(matches('rfc822msgid:<note@example.test>')).toBe(true);
  });
  test('date strings use the observed Gmail UTC boundary and timestamp comparisons are typed',()=>{
    expect(matches('after:2026/11/18 before:2026/11/19')).toBe(true);
    expect(matches('newer:11/18/2026 older:11/19/2026')).toBe(true);
    expect(matches('after:2026/11/18',{received_at:'2026-11-17T23:59:59.000Z'})).toBe(false);
    expect(matches('after:2026/11/18',{received_at:'2026-11-18T00:00:01.000Z'})).toBe(true);
    expect(matches('newer:11/18/2026 before:11/19/2026',{received_at:'2026-11-18T00:01:00.000Z'})).toBe(true);
    expect(matches('before:2026/11/18',{received_at:'2026-11-17T23:59:59.000Z'})).toBe(true);
    expect(matches('before:2026/11/18',{received_at:'2026-11-18T00:00:01.000Z'})).toBe(false);
    expect(matches('after:2024/02/29 before:2024/03/01',{received_at:'2024-02-29T12:00:00.000Z'})).toBe(true);
    expect(matches('after:2026/12/31 before:2027/01/01',{received_at:'2026-12-31T23:59:59.000Z'})).toBe(true);
    expect(matches('before:2027/01/01',{received_at:'2027-01-01T00:00:01.000Z'})).toBe(false);
    expect(matches('after:2027/01/01 before:2027/01/02',{search_received_at:'2027-01-01T00:00:00.000Z'})).toBe(true);
    expect(matches('after:2027/01/01 before:2027/01/01',{search_received_at:'2027-01-01T00:00:00.000Z'})).toBe(false);
    expect(matches('after:0')).toBe(true);
    expect(matches('before:2027/01/01',{received_at:null})).toBe(false);
    expect(matches('newer_than:2d older_than:12d')).toBe(false);
    expect(matches('newer_than:2d')).toBe(true);
    expect(matches('older_than:1y')).toBe(false);
    expect(()=>compileGmailQuery('after:2026/02/30')).toThrow('Invalid Gmail date');
    expect(()=>compileGmailQuery('after:2025/02/29')).toThrow('Invalid Gmail date');
  });
  test('epoch bounds include their receipt second and use search receipt time',()=>{
    const timestamp=Date.parse('2026-11-18T12:00:05.000Z')/1000;
    const value={received_at:'2026-11-18T12:00:00.000Z',search_received_at:'2026-11-18T12:00:05.000Z'};
    expect(matches(`after:${timestamp} before:${timestamp}`,value)).toBe(true);
    expect(matches(`newer:${timestamp} older:${timestamp}`,value)).toBe(true);
    expect(matches(`after:${timestamp+1}`,value)).toBe(false);
    expect(matches(`before:${timestamp-1}`,value)).toBe(false);
    expect(matches(`after:${timestamp}`,{search_received_at:null})).toBe(false);
  });
  test('sizes compare bytes and exclude unavailable sizes',()=>{
    expect(matches('size:1000000 larger:1M smaller:2M')).toBe(true);
    expect(matches('larger:2M')).toBe(false);
    expect(matches('smaller:2M',{size:null})).toBe(false);
    expect(()=>compileGmailQuery('size:enormous')).toThrow('Invalid message size');
  });
  test('unavailable Gmail UI metadata fails visibly',()=>{
    for(const query of ['in:snoozed','is:muted','has:yellow-star','has:purple-question','label:encryptedmail'])expect(()=>compileGmailQuery(query,context)).toThrow('metadata');
    for(const query of ['has:yellow-star','in:snoozed','is:muted','label:encryptedmail'])expect(matches(query,{query_flags:[query]},{capabilities:[query]})).toBe(true);
  });
  test('reports all parent fields required for constraining chunk retrieval',()=>{
    expect(compileGmailQuery('from:alice after:2026/01/01 "rental agreement"',context).requiredFields).toEqual(['from_tokens','labels','search_received_at','search_tokens']);
  });
});
