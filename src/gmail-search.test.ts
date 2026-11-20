import {expect,test} from 'bun:test';
import {chunkFilter,searchMailIndex,type MailQuery} from './gmail-search.ts';
import {matchesGmailFilter} from './gmail-query.ts';
import type {Row} from './gmail-index.ts';
const ns={messages:'messages',chunks:'chunks'};
const row=(id:string):Row=>({id,message_id:id,sort_key:`2026-11-19T00:00:00.000Z:${id}`,labels:[],from_addresses:['anne@example.com'],subject_tokens:' renewal terms ',subject:'Renewal terms',snippet:'Original body'});
test('exact search paginates tied dates without omitting messages and binds cursors to the query',async()=>{
  const rows=['c','b','a'].map(row);
  const query:MailQuery=async(_ns,body)=>({rows:rows.filter(r=>!body.filters||matchesGmailFilter(r,body.filters as unknown[])).slice(0,body.top_k as number)});
  const first=await searchMailIndex({query:'',mode:'gmail',limit:2},{},ns,query);
  expect(first.rows.map(r=>r.id)).toEqual(['c','b']);expect(first.queryComplete).toBe(false);
  const next=await searchMailIndex({query:'',mode:'gmail',limit:2,cursor:first.nextCursor!},{},ns,query);
  expect(next.rows.map(r=>r.id)).toEqual(['a']);expect(next.queryComplete).toBe(true);expect(next.nextCursor).toBeNull();
  await expect(searchMailIndex({query:'different',mode:'gmail',cursor:first.nextCursor!},{},ns,query)).rejects.toThrow('different query');
});
test('semantic retrieval checks full message predicates before allowing chunk hits into results',async()=>{
  const calls:{namespace:string;body:Record<string,unknown>}[]=[];
  const query:MailQuery=async(namespace,body)=>{
    calls.push({namespace,body});
    if(namespace==='chunks')return {rows:[{id:'bad-chunk',message_id:'bad',snippet:'wrong'},{id:'good-chunk',message_id:'good',snippet:'matched passage'}]};
    return {rows:[{...row('good'),subject_tokens:' renewal terms '},{...row('bad'),subject_tokens:' unrelated '}].filter(r=>matchesGmailFilter(r,body.filters as unknown[]))};
  };
  const result=await searchMailIndex({query:'subject:"renewal terms" cancel lease',mode:'semantic'},{},ns,query);
  expect(result.rows.map(r=>r.id)).toEqual(['good']);expect(result.rows[0]!.snippet).toBe('matched passage');expect(result.queryComplete).toBe(false);
  expect(JSON.stringify(calls[0]!.body.filters)).not.toContain('subject_tokens');
  expect(JSON.stringify(calls[1]!.body.filters)).toContain('subject_tokens');
});
test('weakening chunk filters never turns an OR or NOT into an unsafe restriction',()=>{
  const body=['search_tokens','Regex',' invoice '],from=['from_addresses','Contains','a@example.com'];
  expect(chunkFilter(['And',[body,from]])).toEqual(['And',[from]]);
  expect(chunkFilter(['Or',[body,from]])).toBeNull();expect(chunkFilter(['Not',body])).toBeNull();
});
test('Gmail filters do not invoke vectors or fuzzy retrieval',async()=>{
  const calls:unknown[]=[];const query:MailQuery=async(namespace,body)=>{calls.push({namespace,body});return {rows:[]};};
  const result=await searchMailIndex({query:'from:anne@example.com is:unread',mode:'gmail'},{},ns,query);
  expect(result.queryComplete).toBe(true);expect(calls).toHaveLength(1);expect(JSON.stringify(calls)).not.toContain('ANN');
});
test('natural-language search reranks bounded eligible candidates without returning the full message text',async()=>{
  const calls:{namespace:string;body:Record<string,unknown>}[]=[];
  const query:MailQuery=async(namespace,body)=>{
    calls.push({namespace,body});
    if(body.rerank_by)return {rows:[{id:'b',$dist:.98,rerank_text:'Private full message'},{id:'a',$dist:.25,rerank_text:'Private full message'}]};
    if(namespace==='chunks')return {rows:[]};
    return {rows:['a','b'].map(row)};
  };
  const result=await searchMailIndex({query:'from:anne@example.com cloud spending passed the configured budget',mode:'hybrid',limit:1},{},ns,query);
  expect(result.rows.map(r=>r.id)).toEqual(['b']);expect(result.rows[0]!.score).toBe(.98);expect(result.rows[0]).not.toHaveProperty('rerank_text');
  const final=calls.at(-1)!.body;
  expect(final.rerank_by).toEqual({model:'voyage/rerank-3-lite',attribute:'rerank_text',query:'cloud spending passed the configured budget'});
  expect(final.top_k).toBe(2);expect(final.include_attributes).toEqual(['rerank_text']);
  expect(matchesGmailFilter({...row('b'),from_text:'anne@example.com'},final.filters as unknown[])).toBe(true);
  expect(matchesGmailFilter({...row('b'),from_addresses:['someone@example.com']},final.filters as unknown[])).toBe(false);
  expect(matchesGmailFilter(row('outside'),final.filters as unknown[])).toBe(false);
  expect(result.queryComplete).toBe(false);
  expect(result.semanticText).toBe('cloud spending passed the configured budget');
});
test('short fuzzy searches and long strict Gmail queries do not pay for reranking',async()=>{
  const calls:Record<string,unknown>[]=[];
  const query:MailQuery=async(namespace,body)=>{calls.push(body);return {rows:namespace==='chunks'?[]:['a','b'].map(row)};};
  expect((await searchMailIndex({query:'renewla',mode:'hybrid'},{},ns,query)).semanticText).toBeNull();
  expect((await searchMailIndex({query:'cloud spending passed the configured budget',mode:'gmail'},{},ns,query)).semanticText).toBeNull();
  expect(calls.some(body=>body.rerank_by)).toBe(false);
});
test('single natural-language candidates expose only the compiler-derived evidence query',async()=>{
  const query:MailQuery=async namespace=>({rows:namespace==='chunks'?[]:[row('only')]});
  const result=await searchMailIndex({query:'from:anne@example.com the meal costing less than twenty dollars',mode:'hybrid'},{},ns,query);
  expect(result.rows.map(r=>r.id)).toEqual(['only']);expect(result.semanticText).toBe('the meal costing less than twenty dollars');expect(result.queryComplete).toBe(false);
  expect((await searchMailIndex({query:'the price for the meal',mode:'hybrid'},{},ns,query)).semanticText).toBe('the price for the meal');
});
test('verification intent excludes hard predicates and OR without changing ranking queries',async()=>{
  const calls:Record<string,unknown>[]=[];
  const query:MailQuery=async(namespace,body)=>{
    calls.push(body);
    return {rows:body.rerank_by?[{id:'a',$dist:.9},{id:'b',$dist:.8}]:namespace==='chunks'?[]:['a','b'].map(row)};
  };
  const alternatives=await searchMailIndex({query:'the receipt for twenty OR thirty dollars',mode:'hybrid'},{},ns,query);
  expect(alternatives.semanticText).toBeNull();
  expect(calls.at(-1)!.rerank_by).toEqual({model:'voyage/rerank-3-lite',attribute:'rerank_text',query:'the receipt for twenty thirty dollars'});
  const subject=await searchMailIndex({query:'subject:"the receipt for a twenty dollar meal"',mode:'hybrid'},{},ns,query);
  expect(subject.semanticText).toBeNull();
  expect(calls.at(-1)!.rerank_by).toEqual({model:'voyage/rerank-3-lite',attribute:'rerank_text',query:'the receipt for a twenty dollar meal'});
  const mixed=await searchMailIndex({query:'from:anne@example.com +receipt "delivery charge" the meal with the twenty dollar total',mode:'hybrid'},{},ns,query);
  expect(mixed.semanticText).toBe('the meal with the twenty dollar total');
  expect(calls.at(-1)!.rerank_by).toEqual({model:'voyage/rerank-3-lite',attribute:'rerank_text',query:'receipt delivery charge the meal with twenty dollar total'});
});
test('reranking cannot introduce a message outside the eligible candidate set',async()=>{
  const query:MailQuery=async(namespace,body)=>({rows:body.rerank_by?[{id:'outside',$dist:.99}]:namespace==='chunks'?[]:['a','b'].map(row)});
  await expect(searchMailIndex({query:'cloud spending passed the configured budget',mode:'hybrid'},{},ns,query)).rejects.toThrow('Invalid mail reranking result');
});
test('reranking caps model work at thirty messages while preserving the requested retrieval depth',async()=>{
  const rows=Array.from({length:100},(_,i)=>row(String(i)));
  const query:MailQuery=async(namespace,body)=>{
    if(body.rerank_by){expect(body.top_k).toBe(30);return {rows:rows.slice(0,30).reverse().map(r=>({id:r.id,$dist:.5}))};}
    return {rows:namespace==='chunks'?[]:rows};
  };
  const result=await searchMailIndex({query:'cloud spending passed the configured budget',mode:'hybrid',limit:100},{},ns,query);
  expect(result.rows).toHaveLength(100);expect(result.rows[0]!.id).toBe('29');expect(result.rows[30]!.id).toBe('30');
});
