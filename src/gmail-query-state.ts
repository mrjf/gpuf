import {createHash} from 'node:crypto';
import type {Store} from './store.ts';

export const GMAIL_SOURCE_FLAGS=[
  'has:yellow-star','has:orange-star','has:red-star','has:purple-star','has:blue-star','has:green-star',
  'has:red-bang','has:orange-guillemet','has:yellow-bang','has:green-check','has:blue-info','has:purple-question',
  'in:snoozed','is:muted','label:encryptedmail','category:reservations','category:purchases','in:chats','in:archive',
] as const;
export type GmailSourceFlag=typeof GMAIL_SOURCE_FLAGS[number];
export type GmailQuerySnapshot={
  version:1;
  id:string;
  generation:string;
  startedAt:string;
  completedAt:string;
  labels:{id:string;name:string}[];
  memberships:Record<GmailSourceFlag,string[]>;
};
export type GmailQueryContextProjection={
  version:1;
  id:string;
  generation:string;
  snapshotId:string;
  completedAt:string;
  labels:{id:string;name:string}[];
  capabilities:string[];
};
type SnapshotRef=Pick<GmailQuerySnapshot,'id'|'generation'|'completedAt'>;
type FlagProgress={pages:string[];cursor:string|null;complete:boolean};
type Pending={startedAt:string;labels:string|null;flags:Record<GmailSourceFlag,FlagProgress>;snapshot:SnapshotRef|null;changes:{id:string;count:number}|null;patched:number};
type SourceObject={kind:string;payload:Record<string,unknown>;id:string};
export type GmailQueryState={version:2;generation:string;snapshot:SnapshotRef|null;pending:Pending|null};
export type GmailQueryGoogle=(path:string,method:string,body:unknown,signal:AbortSignal)=>Promise<unknown>;
export type GmailQueryStateOptions={
  now?:number;
  refreshAfterMs?:number;
  patchBatchSize?:number;
  applyChanges?:(snapshot:GmailQuerySnapshot,ids:string[],signal:AbortSignal)=>Promise<void>;
};
export type GmailQueryStateAdvance={complete:boolean;snapshot:GmailQuerySnapshot|null;pendingSnapshot:GmailQuerySnapshot|null;changedIds:string[];state:GmailQueryState};
const text=new TextDecoder();
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
const validTime=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const validHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validLabels=(value:unknown):value is {id:string;name:string}[]=>Array.isArray(value)&&value.every(label=>isObject(label)&&typeof label.id==='string'&&!!label.id&&typeof label.name==='string'&&!!label.name);
const key=(root:string)=>`${root.replace(/\/?$/,'/')}query-state.json`;
const contextKey=(root:string)=>`${root.replace(/\/?$/,'/')}query-context.json`;
function snapshotPayload(snapshot:GmailQuerySnapshot){const {id:_id,...payload}=snapshot;return payload;}
function snapshotId(payload:Omit<GmailQuerySnapshot,'id'>){return createHash('sha256').update(JSON.stringify(payload)).digest('hex');}
function contextPayload(snapshot:GmailQuerySnapshot):Omit<GmailQueryContextProjection,'id'>{return {version:1,generation:snapshot.generation,snapshotId:snapshot.id,completedAt:snapshot.completedAt,labels:snapshot.labels,capabilities:capabilities(snapshot)};}
function contextId(payload:Omit<GmailQueryContextProjection,'id'>){return createHash('sha256').update(contextPayload.toString()).update(JSON.stringify(payload)).digest('hex');}
function validateContext(value:unknown):asserts value is GmailQueryContextProjection{
  if(!isObject(value)||value.version!==1||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)||typeof value.generation!=='string'||!value.generation||typeof value.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(value.snapshotId)||!validTime(value.completedAt)||!validLabels(value.labels)||!Array.isArray(value.capabilities)||value.capabilities.length!==GMAIL_SOURCE_FLAGS.length||value.capabilities.some((flag,index)=>flag!==GMAIL_SOURCE_FLAGS[index])||Object.keys(value).length!==7)throw new Error('Malformed Gmail query context');
  const {id,...payload}=value as GmailQueryContextProjection;
  if(contextId(payload)!==id)throw new Error('Gmail query context content hash mismatch');
}
function validSnapshot(value:unknown):value is GmailQuerySnapshot{
  if(!isObject(value)||value.version!==1||typeof value.id!=='string'||typeof value.generation!=='string'||!value.generation||!validTime(value.startedAt)||!validTime(value.completedAt)||!validLabels(value.labels)||!isObject(value.memberships))return false;
  for(const flag of GMAIL_SOURCE_FLAGS){const ids=value.memberships[flag];if(!Array.isArray(ids)||!ids.every(validId)||ids.some((id,i)=>i>0&&ids[i-1]!>=id))return false;}
  if(Object.keys(value.memberships).length!==GMAIL_SOURCE_FLAGS.length)return false;
  return snapshotId(snapshotPayload(value as GmailQuerySnapshot))===value.id;
}
const reference=(snapshot:GmailQuerySnapshot):SnapshotRef=>({id:snapshot.id,generation:snapshot.generation,completedAt:snapshot.completedAt});
const validRef=(value:unknown):value is SnapshotRef=>isObject(value)&&validHash(value.id)&&typeof value.generation==='string'&&!!value.generation&&validTime(value.completedAt)&&Object.keys(value).length===3;
const contentHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceId=(generation:string,startedAt:string,flag?:GmailSourceFlag)=>contentHash({generation,startedAt,...(flag?{flag}:{})});
const objectKey=(root:string,kind:string,id:string)=>`${root.replace(/\/?$/,'/')}query-${kind}/${id}.json`;
function validateState(value:unknown):asserts value is GmailQueryState{
  if(!isObject(value)||value.version!==2||Object.keys(value).length!==4||typeof value.generation!=='string'||!value.generation||!('snapshot'in value)||!('pending'in value)||value.snapshot!==null&&!validRef(value.snapshot))throw new Error('Malformed Gmail query-state checkpoint: version 2 required');
  if(value.pending===null)return;
  const pending=value.pending;
  if(!isObject(pending)||Object.keys(pending).length!==6||!validTime(pending.startedAt)||pending.labels!==null&&!validHash(pending.labels)||!isObject(pending.flags)||pending.snapshot!==null&&!validRef(pending.snapshot)||pending.changes!==null&&(!isObject(pending.changes)||!validHash(pending.changes.id)||!Number.isSafeInteger(pending.changes.count)||Number(pending.changes.count)<0||Object.keys(pending.changes).length!==2)||!Number.isSafeInteger(pending.patched)||Number(pending.patched)<0)throw new Error('Malformed pending Gmail query-state snapshot');
  if(Object.keys(pending.flags).length!==GMAIL_SOURCE_FLAGS.length)throw new Error('Incomplete Gmail query-state flag schema');
  for(const flag of GMAIL_SOURCE_FLAGS){const progress=pending.flags[flag];if(!isObject(progress)||Object.keys(progress).length!==3||!Array.isArray(progress.pages)||!progress.pages.every(validHash)||progress.cursor!==null&&(typeof progress.cursor!=='string'||!progress.cursor)||typeof progress.complete!=='boolean'||(!progress.pages.length&&(progress.cursor!==null||progress.complete))||(progress.pages.length>0&&progress.complete!==(progress.cursor===null)))throw new Error('Malformed Gmail query-state flag progress');}
  if(pending.snapshot!==null&&(pending.snapshot as SnapshotRef).generation!==value.generation)throw new Error('Gmail query-state pending generation mismatch');
  if((pending.snapshot===null)!==(pending.changes===null)||pending.snapshot!==null&&(pending.labels===null||GMAIL_SOURCE_FLAGS.some(flag=>!(pending.flags as Pending['flags'])[flag].complete))||Number(pending.patched)>Number((pending.changes as Pending['changes'])?.count??0))throw new Error('Gmail query-state patch cursor exceeds its changes');
}
export async function readQueryState(store:Store,root:string):Promise<GmailQueryState|null>{
  const bytes=await store.get(key(root));if(!bytes)return null;
  const value:unknown=JSON.parse(text.decode(bytes));validateState(value);return value;
}
export async function readQueryStateSnapshot(store:Store,root:string,generation:string):Promise<GmailQuerySnapshot|null>{
  const state=await readQueryState(store,root);return state?.snapshot?.generation===generation?readSnapshot(store,root,state.snapshot):null;
}
async function readSnapshot(store:Store,root:string,ref:SnapshotRef):Promise<GmailQuerySnapshot>{
  const bytes=await store.get(objectKey(root,'snapshots',ref.id));if(!bytes)throw new Error('Missing Gmail query snapshot');
  const value:unknown=JSON.parse(text.decode(bytes));if(!validSnapshot(value)||value.id!==ref.id||value.generation!==ref.generation||value.completedAt!==ref.completedAt)throw new Error('Malformed referenced Gmail query snapshot');return value;
}
async function putObject(store:Store,root:string,kind:string,payload:Record<string,unknown>,signal:AbortSignal):Promise<string>{
  const id=contentHash(payload);signal.throwIfAborted();await store.put(objectKey(root,kind,id),JSON.stringify({...payload,id}));return id;
}
async function readObject(store:Store,root:string,kind:string,id:string):Promise<Record<string,unknown>>{
  const bytes=await store.get(objectKey(root,kind,id));if(!bytes)throw new Error('Missing Gmail query '+kind+' object');
  const value:unknown=JSON.parse(text.decode(bytes));if(!isObject(value)||value.id!==id)throw new Error('Malformed Gmail query '+kind+' object');const {id:_,...payload}=value;
  if(contentHash(payload)!==id)throw new Error('Gmail query '+kind+' content hash mismatch');return payload;
}
async function assembledSnapshot(store:Store,root:string,generation:string,work:Pending,now:number):Promise<GmailQuerySnapshot>{
  const labels=await readObject(store,root,'labels',work.labels!);
  if(labels.version!==1||labels.source!==sourceId(generation,work.startedAt)||!validLabels(labels.labels))throw new Error('Malformed Gmail query labels source');
  const memberships={} as GmailQuerySnapshot['memberships'];let cursor=0;
  await Promise.all(Array.from({length:4},async()=>{while(cursor<GMAIL_SOURCE_FLAGS.length){
    const flag=GMAIL_SOURCE_FLAGS[cursor++]!,progress=work.flags[flag],source=sourceId(generation,work.startedAt,flag),ids:string[]=[];let previousCursor:string|null=null;
    for(let page=0;page<progress.pages.length;page++){
      const value=await readObject(store,root,'pages/'+source,progress.pages[page]!);
      if(value.version!==1||value.source!==source||value.ordinal!==page||value.previous!==(progress.pages[page-1]??null)||value.cursor!==previousCursor||value.nextCursor!==null&&(typeof value.nextCursor!=='string'||!value.nextCursor)||!Array.isArray(value.ids)||value.ids.length>500||!value.ids.every(validId))throw new Error('Malformed Gmail query membership page');
      ids.push(...value.ids);previousCursor=value.nextCursor as string|null;
    }
    if(!progress.complete||previousCursor!==null)throw new Error('Incomplete Gmail query membership source');
    memberships[flag]=[...new Set(ids)].sort();
  }}));
  const payload:Omit<GmailQuerySnapshot,'id'>={version:1,generation,startedAt:work.startedAt,completedAt:new Date(now).toISOString(),labels:labels.labels,memberships};
  // Canonical flag order makes content identity independent of page-read completion order.
  payload.memberships=Object.fromEntries(GMAIL_SOURCE_FLAGS.map(flag=>[flag,memberships[flag]])) as GmailQuerySnapshot['memberships'];
  return {...payload,id:snapshotId(payload)};
}
async function readChanges(store:Store,root:string,state:GmailQueryState):Promise<string[]>{
  const work=state.pending!,value=await readObject(store,root,'changes',work.changes!.id),ids=value.ids;
  if(value.version!==1||value.sourceId!==(state.snapshot?.generation===state.generation?state.snapshot.id:null)||value.snapshotId!==work.snapshot!.id||!Array.isArray(ids)||ids.length!==work.changes!.count||!ids.every(validId)||ids.some((id,i)=>i>0&&ids[i-1]!>=id))throw new Error('Malformed Gmail query patch changes');
  return ids;
}
export async function readQueryContext(store:Store,root:string,generation:string):Promise<GmailQueryContextProjection|null>{
  const bytes=await store.get(contextKey(root));if(!bytes)return null;
  const value:unknown=JSON.parse(text.decode(bytes));validateContext(value);return value.generation===generation?value:null;
}
export function capabilities(snapshot:GmailQuerySnapshot):string[]{return GMAIL_SOURCE_FLAGS.filter(flag=>Object.hasOwn(snapshot.memberships,flag));}
function contains(sorted:string[],id:string){let lo=0,hi=sorted.length;while(lo<hi){const middle=(lo+hi)>>>1;if(sorted[middle]!<id)lo=middle+1;else hi=middle;}return sorted[lo]===id;}
export function flagsForMessage(snapshot:GmailQuerySnapshot,id:string):string[]{return GMAIL_SOURCE_FLAGS.filter(flag=>contains(snapshot.memberships[flag],id));}
export function queryStateChangedIds(previous:GmailQuerySnapshot,next:GmailQuerySnapshot):string[]{
  const changed=new Set<string>();
  for(const flag of GMAIL_SOURCE_FLAGS){const old=previous.memberships[flag],fresh=next.memberships[flag];let a=0,b=0;while(a<old.length||b<fresh.length){if(a>=old.length){changed.add(fresh[b++]!);continue;}if(b>=fresh.length){changed.add(old[a++]!);continue;}if(old[a]===fresh[b]){a++;b++;}else if(old[a]!<fresh[b]!){changed.add(old[a++]!);}else changed.add(fresh[b++]!);}}
  return [...changed].sort();
}
function pending(now:number):Pending{return {startedAt:new Date(now).toISOString(),labels:null,flags:Object.fromEntries(GMAIL_SOURCE_FLAGS.map((flag):[GmailSourceFlag,FlagProgress]=>[flag,{pages:[],cursor:null,complete:false}])) as Pending['flags'],snapshot:null,changes:null,patched:0};}

async function publishContext(store:Store,root:string,snapshot:GmailQuerySnapshot,signal:AbortSignal):Promise<void>{
  const payload=contextPayload(snapshot),context={...payload,id:contextId(payload)},serialized=JSON.stringify(context);
  signal.throwIfAborted();
  await store.put(`${root.replace(/\/?$/,'/')}query-contexts/${context.id}.json`,serialized);
  signal.throwIfAborted();
  await store.put(contextKey(root),serialized);
}

/** Read-only observations are ephemeral until a whole refresh is ready; losing them repeats GETs. */
async function collectRefresh(google:GmailQueryGoogle,generation:string,now:number,signal:AbortSignal):Promise<{work:Pending;objects:SourceObject[];snapshot:GmailQuerySnapshot}>{
  const work=pending(now),objects:SourceObject[]=[],memberships={} as GmailQuerySnapshot['memberships'];
  const controller=new AbortController(),bounded=AbortSignal.any([signal,controller.signal]),deadline=Date.now()+90000;
  const timer=setTimeout(()=>controller.abort(new Error('Gmail query refresh time budget exceeded')),90000);
  let pages=0,bytes=0,next=0,labels:GmailQuerySnapshot['labels']=[];
  const jobs:(GmailSourceFlag|null)[]=[null,...GMAIL_SOURCE_FLAGS];
  const check=()=>{bounded.throwIfAborted();if(Date.now()>deadline)throw new Error('Gmail query refresh time budget exceeded');};
  const capture=(kind:string,payload:Record<string,unknown>)=>{const id=contentHash(payload);objects.push({kind,payload,id});return id;};
  const read=async(path:string)=>{
    check();if(++pages>2048)throw new Error('Gmail query refresh page budget exceeded');
    const value=await google(path,'GET',undefined,bounded);check();
    if(!isObject(value))throw new Error('Malformed Gmail query-state response');
    bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>32*1024*1024)throw new Error('Gmail query refresh byte budget exceeded');
    return value;
  };
  try{
    const outcomes=await Promise.allSettled(Array.from({length:4},async()=>{
      try{while(next<jobs.length){
        const flag=jobs[next++];
        if(flag===null){
          const response=await read('/labels');if(!validLabels(response.labels))throw new Error('Gmail did not return its label names');
          labels=response.labels.map(({id,name})=>({id,name})).sort((a,b)=>a.id.localeCompare(b.id));
          work.labels=capture('labels',{version:1,source:sourceId(generation,work.startedAt),labels});continue;
        }
        const progress=work.flags[flag!],source=sourceId(generation,work.startedAt,flag!),ids:string[]=[],cursors=new Set<string>();
        do{
          const params=new URLSearchParams({q:flag!,maxResults:'500',includeSpamTrash:'true',...(progress.cursor?{pageToken:progress.cursor}:{})});
          const response=await read(`/messages?${params}`),messages=response.messages??[];
          if(!Array.isArray(messages)||messages.length>500||!messages.every(message=>isObject(message)&&validId(message.id)))throw new Error('Malformed Gmail query-state message list');
          if(response.nextPageToken!==undefined&&(typeof response.nextPageToken!=='string'||!response.nextPageToken))throw new Error('Malformed Gmail query-state page cursor');
          const cursor=response.nextPageToken as string|undefined;
          if(cursor&&cursors.has(cursor))throw new Error('Gmail query-state pagination did not advance');
          if(cursor)cursors.add(cursor);
          const messageIds=messages.map(message=>message.id as string);
          const id=capture('pages/'+source,{version:1,source,ordinal:progress.pages.length,previous:progress.pages.at(-1)??null,cursor:progress.cursor,nextCursor:cursor??null,ids:messageIds});
          progress.pages.push(id);progress.cursor=cursor??null;progress.complete=!cursor;ids.push(...messageIds);
        }while(!progress.complete);
        memberships[flag!]=[...new Set(ids)].sort();
      }}catch(error){controller.abort(error);throw error;}
    }));
    const failed=outcomes.find((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');if(failed)throw failed.reason;
    check();
    const payload:Omit<GmailQuerySnapshot,'id'>={version:1,generation,startedAt:work.startedAt,completedAt:new Date(now).toISOString(),labels,memberships:Object.fromEntries(GMAIL_SOURCE_FLAGS.map(flag=>[flag,memberships[flag]])) as GmailQuerySnapshot['memberships']};
    return {work,objects,snapshot:{...payload,id:snapshotId(payload)}};
  }finally{clearTimeout(timer);}
}

async function persistSources(store:Store,root:string,objects:SourceObject[],signal:AbortSignal):Promise<void>{
  let next=0;
  const outcomes=await Promise.allSettled(Array.from({length:4},async()=>{while(next<objects.length){const object=objects[next++]!;signal.throwIfAborted();await store.put(objectKey(root,object.kind,object.id),JSON.stringify({...object.payload,id:object.id}));}}));
  const failed=outcomes.find((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');if(failed)throw failed.reason;
}

/** The archive's serial writer calls this; all resumable progress is committed to its bucket. */
export async function advanceQueryState(store:Store,google:GmailQueryGoogle,root:string,generation:string,signal:AbortSignal,options:GmailQueryStateOptions={}):Promise<GmailQueryStateAdvance>{
  if(!generation)throw new Error('Gmail query-state generation is required');
  const now=options.now??Date.now(),refreshAfterMs=options.refreshAfterMs??300000,patchBatch=options.patchBatchSize??100;
  if(!Number.isFinite(now)||refreshAfterMs<0||!Number.isInteger(patchBatch)||patchBatch<1||patchBatch>1000)throw new Error('Invalid Gmail query-state advancement options');
  signal.throwIfAborted();
  let state=await readQueryState(store,root);
  let created=false,prepared:GmailQuerySnapshot|null=null,changed:string[]|null=null,published:GmailQuerySnapshot|null=null;
  if(!state){state={version:2,generation,snapshot:null,pending:pending(now)};created=true;}
  else if(state.generation!==generation){state={version:2,generation,snapshot:state.snapshot,pending:pending(now)};created=true;}
  else if(!state.pending){
    if(state.snapshot&&now-Date.parse(state.snapshot.completedAt)<refreshAfterMs)return {complete:true,snapshot:await readSnapshot(store,root,state.snapshot),pendingSnapshot:null,changedIds:[],state};
    if(state.snapshot?.generation===generation){
      published=await readSnapshot(store,root,state.snapshot);
      const collected=await collectRefresh(google,generation,now,signal);prepared=collected.snapshot;changed=queryStateChangedIds(published,prepared);
      if(changed.length)await persistSources(store,root,collected.objects,signal);
      signal.throwIfAborted();await store.put(objectKey(root,'snapshots',prepared.id),JSON.stringify(prepared));
      if(!changed.length){
        await publishContext(store,root,prepared,signal);
        state.snapshot=reference(prepared);signal.throwIfAborted();await store.put(key(root),JSON.stringify(state));
        return {complete:true,snapshot:prepared,pendingSnapshot:null,changedIds:[],state};
      }
      const changesId=await putObject(store,root,'changes',{version:1,sourceId:published.id,snapshotId:prepared.id,ids:changed},signal);
      state.pending={...collected.work,snapshot:reference(prepared),changes:{id:changesId,count:changed.length}};created=true;
    }else{state.pending=pending(now);created=true;}
  }
  const work=state.pending!;
  const save=async()=>{signal.throwIfAborted();await store.put(key(root),JSON.stringify(state));};
  const previous=async()=>published??(state.snapshot?.generation===generation?(published=await readSnapshot(store,root,state.snapshot)):null);
  const result=async():Promise<GmailQueryStateAdvance>=>({complete:state.pending===null&&state.snapshot?.generation===generation,snapshot:await previous(),pendingSnapshot:state.pending?.snapshot?(prepared??await readSnapshot(store,root,state.pending.snapshot)):null,changedIds:state.pending?.changes?(changed??await readChanges(store,root,state)).slice(state.pending.patched):[],state});
  // A restart must see the new refresh before any source request is allowed to advance it.
  if(created)await save();
  if(!work.snapshot){
    const jobs:{flag:GmailSourceFlag|null;promise:Promise<unknown>}[]=[];
    if(work.labels===null)jobs.push({flag:null,promise:google('/labels','GET',undefined,signal)});
    for(const flag of GMAIL_SOURCE_FLAGS){
      if(jobs.length===4)break;
      const progress=work.flags[flag];if(progress.complete)continue;
      const params=new URLSearchParams({q:flag,maxResults:'500',includeSpamTrash:'true',...(progress.cursor?{pageToken:progress.cursor}:{})});
      jobs.push({flag,promise:google(`/messages?${params}`,'GET',undefined,signal)});
    }
    const outcomes=await Promise.allSettled(jobs.map(job=>job.promise));let failure:unknown;
    for(let i=0;i<outcomes.length;i++){
      const outcome=outcomes[i]!,flag=jobs[i]!.flag;
      if(outcome.status==='rejected'){failure??=outcome.reason;continue;}
      try{
        const response=outcome.value;if(!isObject(response))throw new Error('Malformed Gmail query-state response');
        if(flag===null){if(!validLabels(response.labels))throw new Error('Gmail did not return its label names');work.labels=await putObject(store,root,'labels',{version:1,source:sourceId(generation,work.startedAt),labels:response.labels.map(({id,name})=>({id,name})).sort((a,b)=>a.id.localeCompare(b.id))},signal);continue;}
        const messages=response.messages??[];
        if(!Array.isArray(messages)||messages.length>500||!messages.every(message=>isObject(message)&&validId(message.id)))throw new Error('Malformed Gmail query-state message list');
        if(response.nextPageToken!==undefined&&(typeof response.nextPageToken!=='string'||!response.nextPageToken))throw new Error('Malformed Gmail query-state page cursor');
        const progress=work.flags[flag],cursor=response.nextPageToken as string|undefined;
        if(cursor&&cursor===progress.cursor)throw new Error('Gmail query-state pagination did not advance');
        const source=sourceId(generation,work.startedAt,flag);
        const id=await putObject(store,root,'pages/'+source,{version:1,source,ordinal:progress.pages.length,previous:progress.pages.at(-1)??null,cursor:progress.cursor,nextCursor:cursor??null,ids:messages.map(message=>message.id as string)},signal);
        progress.pages.push(id);progress.cursor=cursor??null;progress.complete=!cursor;
      }catch(error){failure??=error;}
    }
    if(jobs.length)await save();
    if(failure)throw failure;
    if(work.labels!==null&&GMAIL_SOURCE_FLAGS.every(flag=>work.flags[flag].complete)){
      prepared=await assembledSnapshot(store,root,generation,work,now);
      signal.throwIfAborted();await store.put(objectKey(root,'snapshots',prepared.id),JSON.stringify(prepared));
      const old=await previous();changed=old?queryStateChangedIds(old,prepared):[];
      const changesId=await putObject(store,root,'changes',{version:1,sourceId:old?.id??null,snapshotId:prepared.id,ids:changed},signal);
      work.snapshot=reference(prepared);work.changes={id:changesId,count:changed.length};await save();
    }
  }
  if(!work.snapshot)return result();
  prepared??=await readSnapshot(store,root,work.snapshot);changed??=await readChanges(store,root,state);
  if(work.patched<changed.length){
    if(!options.applyChanges)return result();
    const ids=changed.slice(work.patched,work.patched+patchBatch);
    await options.applyChanges(prepared,ids,signal);
    work.patched+=ids.length;await save();
    if(work.patched<changed.length)return result();
  }
  await publishContext(store,root,prepared,signal);
  state.snapshot=work.snapshot;state.pending=null;await save();published=prepared;return result();
}
