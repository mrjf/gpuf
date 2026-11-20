import {describe,test,expect,spyOn} from 'bun:test';
class MemoryStore {
  private entries = new Map<string, Uint8Array>();
  async get(key: string) { return this.entries.get(key) ?? null; }
  async put(key: string, body: string) { this.entries.set(key, new TextEncoder().encode(body)); }
  async list(prefix: string) { return [...this.entries.keys()].filter(key => key.startsWith(prefix)).sort(); }
}
import {advanceQueryState,readQueryState,readQueryStateSnapshot,readQueryContext,capabilities,flagsForMessage,GMAIL_SOURCE_FLAGS,type GmailQueryGoogle,type GmailQueryStateOptions} from './gmail-query-state.ts';

const root='archive/test-account/';
const signal=()=>new AbortController().signal;
function fixture(){
  const store=new MemoryStore(),calls:string[]=[],pages=new Map<string,{messages?:{id:string}[];nextPageToken?:string}>();
  let fail:string|null=null;
  pages.set('has:yellow-star',{messages:[{id:'a'},{id:'b'}],nextPageToken:'second'});
  pages.set('has:yellow-star|second',{messages:[{id:'b'},{id:'c'}]});
  pages.set('is:muted',{messages:[{id:'a'}]});
  pages.set('in:archive',{messages:[{id:'c'}]});
  const google:GmailQueryGoogle=async(path,method,body)=>{
    calls.push(path);expect(method).toBe('GET');expect(body).toBeUndefined();
    if(path==='/labels')return {labels:[{id:'Label_1',name:'Family'},{id:'INBOX',name:'INBOX'}]};
    const params=new URL('https://gmail.test'+path).searchParams;
    expect(params.get('maxResults')).toBe('500');expect(params.get('includeSpamTrash')).toBe('true');
    const q=params.get('q')!,key=q+(params.has('pageToken')?'|'+params.get('pageToken'):'');
    if(q===fail)throw new Error('source unavailable');return pages.get(key)??{};
  };
  const advance=(options:GmailQueryStateOptions={})=>advanceQueryState(store,google,root,'generation-a',signal(),{now:Date.parse('2026-11-19T12:00:00Z'),...options});
  async function finish(options:GmailQueryStateOptions={}){for(let i=0;i<30;i++){const value=await advance(options);if(value.complete)return value;}throw new Error('fixture did not finish');}
  return {store,calls,pages,google,advance,finish,setFail:(value:string|null)=>{fail=value;}};
}

describe('durable Gmail query metadata',()=>{
  test('resumes flag pages with bounded source calls and publishes only complete snapshots',async()=>{
    const f=fixture();const first=await f.advance();
    expect(first.complete).toBe(false);expect(first.snapshot).toBeNull();expect(f.calls).toHaveLength(4);
    expect(await readQueryContext(f.store,root,'generation-a')).toBeNull();
    expect(await readQueryStateSnapshot(f.store,root,'generation-a')).toBeNull();
    const checkpoint=await readQueryState(f.store,root);
    expect(checkpoint!.pending!.flags['has:yellow-star'].cursor).toBe('second');
    let previous=f.calls.length;
    for(let i=0;i<10;i++){
      const turn=await f.advance();expect(f.calls.length-previous).toBeLessThanOrEqual(4);previous=f.calls.length;
      if(turn.complete){
        expect(turn.snapshot!.memberships['has:yellow-star']).toEqual(['a','b','c']);
        expect(flagsForMessage(turn.snapshot!,'a')).toEqual(['has:yellow-star','is:muted']);
        expect(flagsForMessage(turn.snapshot!,'c')).toEqual(['has:yellow-star','in:archive']);
        expect(flagsForMessage(turn.snapshot!,'absent')).toEqual([]);
        expect(capabilities(turn.snapshot!)).toHaveLength(GMAIL_SOURCE_FLAGS.length);
        expect(turn.snapshot!.labels).toEqual([{id:'INBOX',name:'INBOX'},{id:'Label_1',name:'Family'}]);
        expect(await f.store.get(root+`query-snapshots/${turn.snapshot!.id}.json`)).not.toBeNull();
        expect((await readQueryState(f.store,root))!.pending).toBeNull();return;
      }
    }
    throw new Error('snapshot never completed');
  });
  test('commits successful siblings when a source page fails and retries only unfinished work',async()=>{
    const f=fixture();f.setFail('has:red-star');
    await expect(f.advance()).rejects.toThrow('source unavailable');
    const saved=await readQueryState(f.store,root);
    expect(saved!.pending!.labels).not.toBeNull();
    expect(saved!.pending!.flags['has:orange-star'].complete).toBe(true);
    expect(saved!.pending!.flags['has:red-star'].complete).toBe(false);
    f.setFail(null);const done=await f.finish();expect(done.complete).toBe(true);
    expect(f.calls.filter(path=>path==='/labels')).toHaveLength(1);
    expect(f.calls.filter(path=>decodeURIComponent(path).includes('q=has:orange-star'))).toHaveLength(1);
  });
  test('refresh promotion waits for resumable index patch acknowledgements',async()=>{
    const f=fixture(),old=await f.finish(),oldId=old.snapshot!.id;
    f.pages.set('has:yellow-star',{messages:[{id:'b'},{id:'d'}]});
    const later=Date.parse('2026-11-19T12:10:00Z');let pending=await f.advance({now:later});
    for(let i=0;i<20&&!pending.pendingSnapshot;i++)pending=await f.advance({now:later});
    expect(pending.complete).toBe(false);expect(pending.snapshot!.id).toBe(oldId);
    expect(pending.changedIds).toEqual(['a','c','d']);
    expect((await readQueryStateSnapshot(f.store,root,'generation-a'))!.id).toBe(oldId);
    expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(oldId);
    let fail=true;const patches:string[][]=[];
    const applyChanges:NonNullable<GmailQueryStateOptions['applyChanges']>=async(next,ids)=>{
      patches.push(ids);expect(flagsForMessage(next,'d')).toEqual(['has:yellow-star']);
      if(fail)throw new Error('index unavailable');
    };
    await expect(f.advance({now:later,patchBatchSize:2,applyChanges})).rejects.toThrow('index unavailable');
    expect((await readQueryState(f.store,root))!.pending!.patched).toBe(0);
    expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(oldId);
    fail=false;const partial=await f.advance({now:later,patchBatchSize:2,applyChanges});
    expect(partial.complete).toBe(false);expect(partial.changedIds).toEqual(['d']);
    expect((await readQueryState(f.store,root))!.pending!.patched).toBe(2);
    expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(oldId);
    const done=await f.advance({now:later,patchBatchSize:2,applyChanges});
    expect(done.complete).toBe(true);expect(done.snapshot!.id).not.toBe(oldId);
    expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(done.snapshot!.id);
    expect(patches).toEqual([['a','c'],['a','c'],['d']]);
  });
  test('the query context is a small source-bound projection read without membership state',async()=>{
    const f=fixture(),done=await f.finish();
    const get=f.store.get.bind(f.store),reads:string[]=[];
    f.store.get=async(key)=>{reads.push(key);return get(key);};
    const context=await readQueryContext(f.store,root,'generation-a');
    expect(reads).toEqual([root+'query-context.json']);
    expect(context!.snapshotId).toBe(done.snapshot!.id);
    expect(context!.labels).toEqual(done.snapshot!.labels);
    expect(context!.capabilities).toEqual([...GMAIL_SOURCE_FLAGS]);
    expect(Object.hasOwn(context!,'memberships')).toBe(false);
    expect(await get(root+`query-contexts/${context!.id}.json`)).toEqual(await get(root+'query-context.json'));
    expect(await readQueryContext(f.store,root,'different-generation')).toBeNull();
  });
  test('source and projection write failures do not advertise uncommitted context',async()=>{
    for(const boundary of ['query-contexts/','query-context.json']){
      const f=fixture(),old=await f.finish(),later=Date.parse('2026-11-19T12:10:00Z');
      f.pages.set('has:yellow-star',{messages:[{id:'b'},{id:'d'}]});
      let pending=await f.advance({now:later});
      for(let i=0;i<20&&!pending.pendingSnapshot;i++)pending=await f.advance({now:later});
      const put=f.store.put.bind(f.store);let patched=false;
      f.store.put=async(key,body)=>{
        if(key.startsWith(root+boundary))throw new Error('projection commit unavailable');
        if(key===root+'query-context.json')expect(patched).toBe(true);
        return put(key,body);
      };
      const applyChanges:NonNullable<GmailQueryStateOptions['applyChanges']>=async()=>{patched=true;};
      await expect(f.advance({now:later,applyChanges})).rejects.toThrow('projection commit unavailable');
      expect(patched).toBe(true);
      expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(old.snapshot!.id);
      expect((await readQueryState(f.store,root))!.snapshot!.id).toBe(old.snapshot!.id);
      f.store.put=put;const done=await f.advance({now:later,applyChanges});
      expect(done.complete).toBe(true);
      expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(done.snapshot!.id);
    }
  });
  test('initial snapshot failure retains fetched page pointers without exposing an uncommitted prepared snapshot',async()=>{
    const f=fixture();
    const put=f.store.put.bind(f.store);
    f.store.put=async(key,body)=>{if(key.startsWith(root+'query-snapshots/'))throw new Error('snapshot unavailable');return put(key,body);};
    await expect(f.finish()).rejects.toThrow('snapshot unavailable');
    const state=await readQueryState(f.store,root);
    expect(state!.pending!.snapshot).toBeNull();expect(Object.values(state!.pending!.flags).every(flag=>flag.complete)).toBe(true);
    expect(await readQueryContext(f.store,root,'generation-a')).toBeNull();
    const calls=f.calls.length;f.store.put=put;
    const done=await f.advance();
    expect(done.complete).toBe(true);expect(f.calls).toHaveLength(calls);
  });
  test('membership pages are immutable source-bound objects and checkpoints contain only compact references',async()=>{
    const f=fixture();
    f.pages.set('has:yellow-star',{messages:Array.from({length:500},(_,i)=>({id:'large-membership-message-'+i})),nextPageToken:'second'});
    await f.advance();
    const bytes=(await f.store.get(root+'query-state.json'))!,checkpoint=new TextDecoder().decode(bytes);
    expect(bytes.length).toBeLessThan(4000);expect(checkpoint).not.toContain('large-membership-message-');
    expect(checkpoint).not.toContain('memberships');
    const state=await readQueryState(f.store,root);expect(state!.version).toBe(2);expect(state!.pending!.flags['has:yellow-star'].pages).toHaveLength(1);
    const pageKey=(await f.store.list(root+'query-pages/')).find(key=>key.endsWith(state!.pending!.flags['has:yellow-star'].pages[0]+'.json'))!;
    const page=JSON.parse(new TextDecoder().decode((await f.store.get(pageKey))!));
    expect(page.ids).toHaveLength(500);expect(page.source).toMatch(/^[a-f0-9]{64}$/);expect(page.cursor).toBeNull();expect(page.nextCursor).toBe('second');
    await f.store.put(pageKey,JSON.stringify({...page,ids:['tampered']}));
    await expect(f.finish()).rejects.toThrow('content hash');
  });
  test('query context rejects tampering and missing projections do not read full state',async()=>{
    const f=fixture();expect(await readQueryContext(f.store,root,'generation-a')).toBeNull();await f.finish();
    const context=await readQueryContext(f.store,root,'generation-a');
    await f.store.put(root+'query-context.json',JSON.stringify({...context,labels:[{id:'Label_2',name:'Tampered'}]}));
    await expect(readQueryContext(f.store,root,'generation-a')).rejects.toThrow('content hash');
    await f.store.put(root+'query-context.json',JSON.stringify({...context,capabilities:[]}));
    await expect(readQueryContext(f.store,root,'generation-a')).rejects.toThrow('Malformed');
  });
  test('fresh snapshots do not poll Gmail, and a new generation never uses old capabilities',async()=>{
    const f=fixture();await f.finish();const before=f.calls.length;
    expect((await f.advance()).complete).toBe(true);expect(f.calls).toHaveLength(before);
    expect(await readQueryStateSnapshot(f.store,root,'new-generation')).toBeNull();
    const turn=await advanceQueryState(f.store,f.google,root,'new-generation',signal());
    expect(turn.complete).toBe(false);expect(turn.snapshot).toBeNull();
    expect(turn.state.snapshot!.generation).toBe('generation-a');
  });
  test('write failures cannot acknowledge fetched pages and aborted turns cannot advance checkpoints',async()=>{
    const f=fixture(),put=f.store.put.bind(f.store);let writes=0;
    f.store.put=async(key,body)=>{if(++writes===2)throw new Error('bucket unavailable');await put(key,body);};
    await expect(f.advance()).rejects.toThrow('bucket unavailable');
    expect((await readQueryState(f.store,root))!.pending!.labels).toBeNull();
    f.store.put=put;await f.finish();
    const before=f.calls.length,abort=new AbortController();abort.abort();
    await expect(advanceQueryState(f.store,f.google,root,'generation-a',abort.signal)).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
  });
  test('stale or malformed checkpoints fail rather than silently migrating',async()=>{
    const f=fixture();await f.store.put(root+'query-state.json',JSON.stringify({version:0}));
    await expect(f.advance()).rejects.toThrow('Malformed');
    await f.store.put(root+'query-state.json',JSON.stringify({version:1,generation:'generation-a',snapshot:null,pending:null}));
    await expect(f.advance()).rejects.toThrow('version 2 required');
  });
  test('unchanged steady refresh commits four objects and polls no earlier than five minutes',async()=>{
    const f=fixture(),old=await f.finish(),later=Date.parse(old.snapshot!.completedAt)+300000,put=f.store.put.bind(f.store),writes:string[]=[];
    f.store.put=async(key,body)=>{writes.push(key);return put(key,body);};
    const before=f.calls.length;await f.advance({now:later-1});expect(f.calls).toHaveLength(before);expect(writes).toHaveLength(0);
    let active=0,peak=0;
    const google:GmailQueryGoogle=async(...args)=>{active++;peak=Math.max(peak,active);try{await Bun.sleep(0);return await f.google(...args);}finally{active--;}};
    const done=await advanceQueryState(f.store,google,root,'generation-a',signal(),{now:later,applyChanges:async()=>{throw new Error('Unchanged membership must not patch');}});
    expect(done.complete).toBe(true);expect(done.snapshot!.memberships).toEqual(old.snapshot!.memberships);
    expect(done.snapshot!.completedAt).toBe(new Date(later).toISOString());expect(done.snapshot!.id).not.toBe(old.snapshot!.id);
    expect(peak).toBeLessThanOrEqual(4);expect(peak).toBe(4);
    expect(writes).toHaveLength(4);expect(writes.some(key=>key.includes('query-pages/')||key.includes('query-labels/')||key.includes('query-changes/'))).toBe(false);
    expect(writes.at(-1)).toBe(root+'query-state.json');
    expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(done.snapshot!.id);
    expect((await readQueryState(f.store,root))!.version).toBe(2);
  });
  test('failed steady reads or snapshot commits retain the old committed freshness and repeat only unacknowledged GETs',async()=>{
    for(const failure of ['source','snapshot']){
      const f=fixture(),old=await f.finish(),later=Date.parse(old.snapshot!.completedAt)+300000,put=f.store.put.bind(f.store),writes:string[]=[];
      f.store.put=async(key,body)=>{writes.push(key);if(failure==='snapshot'&&key.includes('query-snapshots/'))throw new Error('snapshot unavailable');return put(key,body);};
      if(failure==='source')f.setFail('is:muted');
      await expect(f.advance({now:later})).rejects.toThrow(failure==='source'?'source unavailable':'snapshot unavailable');
      const state=await readQueryState(f.store,root);expect(state!.pending).toBeNull();expect(state!.snapshot!.id).toBe(old.snapshot!.id);
      expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(old.snapshot!.id);
      if(failure==='source')expect(writes).toHaveLength(0);
      const before=f.calls.length;f.store.put=put;f.setFail(null);const done=await f.advance({now:later});
      expect(done.complete).toBe(true);expect(f.calls.length).toBeGreaterThan(before);
    }
  });
  test('label-only refresh updates the source-bound context without index patches',async()=>{
    const f=fixture(),old=await f.finish(),later=Date.parse(old.snapshot!.completedAt)+300000;
    const google:GmailQueryGoogle=async(path,...args)=>path==='/labels'?{labels:[{id:'INBOX',name:'INBOX'},{id:'Label_1',name:'Renamed Family'}]}:f.google(path,...args);
    const done=await advanceQueryState(f.store,google,root,'generation-a',signal(),{now:later,applyChanges:async()=>{throw new Error('Label names do not change memberships');}});
    expect(done.complete).toBe(true);expect(done.snapshot!.memberships).toEqual(old.snapshot!.memberships);
    expect((await readQueryContext(f.store,root,'generation-a'))!.labels).toContainEqual({id:'Label_1',name:'Renamed Family'});
  });
  test('unchanged promotion failures do not advance the checkpoint and can repeat read-only collection',async()=>{
    for(const boundary of ['query-contexts/','query-context.json','query-state.json']){
      const f=fixture(),old=await f.finish(),later=Date.parse(old.snapshot!.completedAt)+300000,put=f.store.put.bind(f.store);
      f.store.put=async(key,body)=>{if(key.startsWith(root+boundary))throw new Error('promotion unavailable');return put(key,body);};
      await expect(f.advance({now:later})).rejects.toThrow('promotion unavailable');
      const state=await readQueryState(f.store,root);expect(state!.pending).toBeNull();expect(state!.snapshot!.id).toBe(old.snapshot!.id);
      const context=await readQueryContext(f.store,root,'generation-a');
      if(boundary!=='query-state.json')expect(context!.snapshotId).toBe(old.snapshot!.id);
      expect(await f.store.get(root+`query-snapshots/${context!.snapshotId}.json`)).not.toBeNull();
      const calls=f.calls.length;f.store.put=put;const done=await f.advance({now:later});
      expect(done.complete).toBe(true);expect(f.calls.length).toBeGreaterThan(calls);
      expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(done.snapshot!.id);
    }
  });
  test('changed steady refresh commits the existing source chain before external patches and replays a lost patch ACK',async()=>{
    const f=fixture(),old=await f.finish(),later=Date.parse(old.snapshot!.completedAt)+300000;
    f.pages.set('has:yellow-star',{messages:[{id:'d'}]});
    const prepared=await f.advance({now:later});expect(prepared.complete).toBe(false);expect(prepared.pendingSnapshot).not.toBeNull();
    const state=await readQueryState(f.store,root);expect(state!.pending!.labels).not.toBeNull();expect(Object.values(state!.pending!.flags).every(flag=>flag.complete)).toBe(true);
    for(const progress of Object.values(state!.pending!.flags))for(const page of progress.pages)expect((await f.store.list(root+'query-pages/')).some(key=>key.endsWith(page+'.json'))).toBe(true);
    const put=f.store.put.bind(f.store),callsBefore=f.calls.length,patches:string[][]=[];let fail=true;
    f.store.put=async(key,body)=>{if(fail&&key===root+'query-state.json'&&JSON.parse(String(body)).pending?.patched>0)throw new Error('patch ACK unavailable');return put(key,body);};
    const applyChanges:NonNullable<GmailQueryStateOptions['applyChanges']>=async(next,ids)=>{
      const committed=await readQueryState(f.store,root);expect(committed!.pending!.snapshot!.id).toBe(next.id);
      expect(await f.store.get(root+`query-snapshots/${next.id}.json`)).not.toBeNull();patches.push(ids);
    };
    await expect(f.advance({now:later,applyChanges})).rejects.toThrow('patch ACK unavailable');
    expect((await readQueryState(f.store,root))!.pending!.patched).toBe(0);
    expect((await readQueryContext(f.store,root,'generation-a'))!.snapshotId).toBe(old.snapshot!.id);
    fail=false;expect((await f.advance({now:later,applyChanges})).complete).toBe(true);
    expect(patches).toHaveLength(2);expect(patches[0]).toEqual(patches[1]);expect(f.calls).toHaveLength(callsBefore);
  });
  test('steady refresh rejects cursor cycles and cancellation without writing partial progress',async()=>{
    for(const kind of ['cycle','abort']){
      const f=fixture(),old=await f.finish(),abort=new AbortController(),put=f.store.put.bind(f.store);let writes=0;
      f.store.put=async(...args)=>{writes++;return put(...args);};
      if(kind==='cycle'){f.pages.set('has:yellow-star',{nextPageToken:'one'});f.pages.set('has:yellow-star|one',{nextPageToken:'two'});f.pages.set('has:yellow-star|two',{nextPageToken:'one'});}
      const google:GmailQueryGoogle=async(...args)=>{const value=await f.google(...args);if(kind==='abort')abort.abort(new Error('refresh cancelled'));return value;};
      await expect(advanceQueryState(f.store,google,root,'generation-a',abort.signal,{now:Date.parse(old.snapshot!.completedAt)+300000})).rejects.toThrow(kind==='cycle'?'did not advance':'refresh cancelled');
      expect(writes).toBe(0);expect((await readQueryState(f.store,root))!.snapshot!.id).toBe(old.snapshot!.id);
    }
  });
  test('steady refresh enforces page, byte and time budgets without publishing partial observations',async()=>{
    for(const kind of ['page','byte','time']){
      const f=fixture(),old=await f.finish(),put=f.store.put.bind(f.store);let calls=0,writes=0,clock=Date.now();
      f.store.put=async(...args)=>{writes++;return put(...args);};
      const now=kind==='time'?spyOn(Date,'now').mockImplementation(()=>clock):null;
      const google:GmailQueryGoogle=async(path,...args)=>{
        calls++;
        if(kind==='time')clock+=90001;
        if(kind==='byte')return {labels:[{id:'INBOX',name:'INBOX'}],padding:'x'.repeat(32*1024*1024)};
        if(kind==='page'&&new URL('https://gmail.test'+path).searchParams.get('q')==='has:yellow-star')return {messages:[],nextPageToken:'cursor-'+calls};
        return f.google(path,...args);
      };
      try{await expect(advanceQueryState(f.store,google,root,'generation-a',signal(),{now:Date.parse(old.snapshot!.completedAt)+300000})).rejects.toThrow(`${kind} budget exceeded`);}finally{now?.mockRestore();}
      expect(calls).toBeLessThanOrEqual(2048);expect(writes).toBe(0);
      expect((await readQueryState(f.store,root))!.snapshot!.id).toBe(old.snapshot!.id);
    }
  });
});
