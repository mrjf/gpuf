import type { ArchiveSearch } from './types.ts';
import { and, filters, fuse, hash, CHUNK_SCHEMA, type Row } from './gmail-index.ts';
import { compileGmailQuery, gmailTokens, type GmailQueryContext } from './gmail-query.ts';

export type MailQuery = (namespace:string, body:Record<string,unknown>)=>Promise<{rows:Row[]}>;
const attributes=['message_id','thread_id','subject','from_addresses','to_addresses','received_at','sort_key','labels','unread','has_attachment','snippet'];
const RERANK_CANDIDATES=30;
type Cursor={version:1;fingerprint:string;after:string;at:number};
const fingerprint=(input:ArchiveSearch,namespace:string)=>hash(JSON.stringify({namespace,...input,cursor:undefined,limit:undefined}));
function readCursor(input:ArchiveSearch,namespace:string):Cursor|null {
  if(!input.cursor)return null;
  let value:Cursor;
  try{value=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw new Error('Invalid mail search cursor');}
  if(value.version!==1||value.fingerprint!==fingerprint(input,namespace)||typeof value.after!=='string'||!Number.isFinite(value.at))throw new Error('Mail search cursor belongs to a different query or index');
  return value;
}

/** A weaker filter may retrieve extra chunks; eligibility is always checked on their parent messages. */
export function chunkFilter(filter:unknown[]):unknown[]|null {
  const [op,value]=filter;
  if(op==='And'||op==='Or'){
    const children=(value as unknown[][]).map(chunkFilter);
    if(op==='Or'&&children.some(child=>child===null))return null;
    const kept=children.filter((child):child is unknown[]=>child!==null);
    return kept.length?[op,kept]:null;
  }
  if(op==='Not'){const child=chunkFilter(value as unknown[]);return child?['Not',child]:null;}
  const schema=CHUNK_SCHEMA[op as keyof typeof CHUNK_SCHEMA] as Record<string,unknown>|undefined;
  if(!schema)return null;
  if(value==='Regex'&&!schema.regex)return null;
  if(['ContainsAllTokens','ContainsAnyToken','ContainsTokenSequence'].includes(String(value))&&!schema.full_text_search)return null;
  return filter;
}

export const mailRanking=(text:string):unknown[]=>['Sum',[
  ['Product',4,['subject','BM25',text]],
  ['Product',2,['people','BM25',text]],
  ['Product',2,['filenames','BM25',text]],
  ['Product',2,['body_new','BM25',text]],
  ['body','BM25',text],['attachment_text','BM25',text],
]];

function fuzzyRanking(text:string):unknown[]|null {
  const words=[...new Set(gmailTokens(text))].filter(word=>word.length>=6).slice(0,12);
  if(!words.length)return null;
  const options={case_sensitive:false,max_edit_distance:[{min_query_chars:6,distance:1},{min_query_chars:9,distance:2}]};
  return ['Sum',words.flatMap(word=>[['Product',2,['subject','Fuzzy',word,options]],['people','Fuzzy',word,options],['filenames','Fuzzy',word,options],['body_new','Fuzzy',word,options]])];
}

export async function searchMailIndex(input:ArchiveSearch,context:GmailQueryContext,namespaces:{messages:string;chunks:string},query:MailQuery):Promise<{rows:Row[];nextCursor:string|null;queryComplete:boolean;semanticText:string|null}> {
  const mode=input.mode??(input.query!==undefined?'gmail':'hybrid'),limit=input.limit??20;
  const cursor=readCursor(input,namespaces.messages),at=cursor?.at??Date.now();
  const expression=input.query??(mode==='gmail'?input.text??'':undefined);
  const plan=expression===undefined?null:compileGmailQuery(expression,{...context,now:at,mode:mode==='hybrid'||mode==='semantic'?'semantic':'strict'});
  const conditions=filters(input) as unknown[][];
  if(plan?.filter)conditions.push(plan.filter);
  const text=(plan?.text??input.text??'').trim();
  const listing=mode==='gmail'||mode==='exact'||!text;
  if(listing){
    if(cursor)conditions.push(['sort_key','Lt',cursor.after]);
    const response=await query(namespaces.messages,{...and(conditions),rank_by:['sort_key','desc'],top_k:limit+1,include_attributes:attributes});
    const more=response.rows.length>limit,rows=response.rows.slice(0,limit);
    const after=rows.at(-1)?.sort_key;
    if(more&&typeof after!=='string')throw new Error('Search index is missing its pagination key');
    const nextCursor=more?Buffer.from(JSON.stringify({version:1,fingerprint:fingerprint(input,namespaces.messages),after:after as string,at} satisfies Cursor)).toString('base64url'):null;
    return {rows:rows.map(row=>({...row,score:1})),nextCursor,queryComplete:!more,semanticText:null};
  }
  if(cursor)throw new Error('Ranked mail search has no exhaustive cursor; use gmail mode for a complete listing');
  const depth=Math.min(1000,Math.max(100,limit*6));
  const lexical=mode==='semantic'?null:query(namespaces.messages,{...and(conditions),rank_by:mailRanking(text),top_k:depth,include_attributes:attributes});
  const fuzzy=mode==='hybrid'?fuzzyRanking(text):null;
  const fuzzyResults=fuzzy?query(namespaces.messages,{...and(conditions),rank_by:fuzzy,top_k:depth,include_attributes:attributes}):null;
  const semantic=mode==='hybrid'||mode==='semantic'?query(namespaces.chunks,{...and(conditions.map(chunkFilter).filter((f):f is unknown[]=>f!==null)),rank_by:['text','ANN',['Embed',text]],top_k:depth,include_attributes:['message_id','snippet']}):null;
  const [words,typos,passages]=await Promise.all([lexical,fuzzyResults,semantic]);
  let semanticRows:Row[]=[];
  if(passages?.rows.length){
    const ids=[...new Set(passages.rows.map(row=>String(row.message_id)))];
    const parents=await query(namespaces.messages,{...and([...conditions,['id','In',ids]]),rank_by:['id','asc'],top_k:ids.length,include_attributes:attributes});
    const byId=new Map(parents.rows.map(row=>[row.id,row]));
    semanticRows=passages.rows.flatMap(row=>{const parent=byId.get(String(row.message_id));return parent?[{...parent,snippet:row.snippet??parent.snippet}]:[];});
  }
  const rerank=(mode==='hybrid'||mode==='semantic')&&gmailTokens(text).length>=5;
  const semanticText=mode==='hybrid'||mode==='semantic'?(plan?plan.semanticText:gmailTokens(text).length>=5?text:null):null;
  const candidates=fuse([words?.rows??[],typos?.rows??[],semanticRows],rerank?Math.max(limit,RERANK_CANDIDATES):limit);
  if(!rerank||candidates.length<2)return {rows:candidates.slice(0,limit),nextCursor:null,queryComplete:false,semanticText};
  const byId=new Map(candidates.slice(0,RERANK_CANDIDATES).map(row=>[row.id,row]));
  const reranked=await query(namespaces.messages,{
    ...and([...conditions,['id','In',[...byId.keys()]]]),rank_by:['id','asc'],top_k:byId.size,
    include_attributes:['rerank_text'],rerank_by:{model:'voyage/rerank-3-lite',attribute:'rerank_text',query:text},
  });
  const rows=reranked.rows.slice(0,limit).map(row=>{
    const candidate=byId.get(row.id);
    if(!candidate||typeof row.$dist!=='number'||!Number.isFinite(row.$dist))throw new Error('Invalid mail reranking result');
    return {...candidate,score:row.$dist};
  });
  return {rows:[...rows,...candidates.filter(row=>!byId.has(row.id))].slice(0,limit),nextCursor:null,queryComplete:false,semanticText};
}
