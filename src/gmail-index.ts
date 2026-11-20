import PostalMime, {addressParser, type Address, type Attachment, type Email} from './vendor/postal-mime/postal-mime.js';
import { htmlToText } from './vendor/postal-mime/text-format.js';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { Parser } from 'htmlparser2';
import { getDocumentProxy } from 'unpdf';
import { gmailTokens, gmailTokenText } from './gmail-query.ts';
import type { ArchiveSearch } from './types.ts';

export const hash = (value:string|Uint8Array) => createHash('sha256').update(value).digest('hex');
const fts = {type:'string',full_text_search:{tokenizer:'word_v4',stemming:false,remove_stopwords:false,max_token_length:254},filterable:false};
const text = {...fts,regex:true};
const fuzzyText = {...text,fuzzy:true};
const tokenText = {type:'string',filterable:false,regex:true};
const stored = {type:'string',filterable:false};
export const MAIL_FIELDS = {
  message_id:{type:'string'},thread_id:{type:'string'},rfc_message_id:{type:'string'},
  from_addresses:{type:'[]string'},to_addresses:{type:'[]string'},cc_addresses:{type:'[]string'},bcc_addresses:{type:'[]string'},participants:{type:'[]string'},
  delivered_to_addresses:{type:'[]string'},list_ids:{type:'[]string',regex:true},header_names:{type:'[]string'},
  labels:{type:'[]string'},categories:{type:'[]string'},query_flags:{type:'[]string'},link_types:{type:'[]string'},attachment_types:{type:'[]string'},
  received_at:{type:'datetime'},search_received_at:{type:'datetime'},sent_at:{type:'datetime'},sort_key:{type:'string'},unread:{type:'bool'},has_attachment:{type:'bool'},has_user_labels:{type:'bool'},
  important:{type:'bool'},starred:{type:'bool'},in_spam:{type:'bool'},in_trash:{type:'bool'},in_inbox:{type:'bool'},in_sent:{type:'bool'},in_drafts:{type:'bool'},
  size:{type:'uint'},raw_size:{type:'uint'},
  subject:fuzzyText,people:fuzzyText,filenames:fuzzyText,body:text,body_new:fuzzyText,
  from_text:text,to_text:text,cc_text:text,bcc_text:text,list_text:text,
  headers:{type:'[]string',filterable:false,regex:true},attachment_names:{type:'[]string',filterable:false,regex:true,fuzzy:true},
  attachment_text:{type:'[]string',filterable:false,full_text_search:fts.full_text_search},
  attachment_status:stored,attachment_complete:{type:'bool'},
  literal:text,search_tokens:tokenText,subject_tokens:tokenText,from_tokens:tokenText,to_tokens:tokenText,cc_tokens:tokenText,bcc_tokens:tokenText,filenames_tokens:tokenText,
  archive_key:stored,snippet:stored,rerank_text:stored,
};
export const MESSAGE_SCHEMA = MAIL_FIELDS;
const postalDirectory = new URL('./vendor/postal-mime/', import.meta.url);
const generationHash = createHash('sha256');
for (const file of ['./gmail-index.ts', './gmail-query.ts', '../bun.lock']) {
  generationHash.update(readFileSync(new URL(file, import.meta.url)));
}
for (const name of readdirSync(postalDirectory).filter(name => name.endsWith('.js')).sort()) {
  generationHash.update(readFileSync(new URL(name, postalDirectory)));
}
export const INDEX_GENERATION = generationHash.digest('hex').slice(0, 12);
const chunkKeys = ['message_id','thread_id','rfc_message_id','from_addresses','to_addresses','cc_addresses','bcc_addresses','participants','delivered_to_addresses','list_ids','labels','categories','query_flags','link_types','attachment_types','received_at','search_received_at','sent_at','sort_key','unread','has_attachment','has_user_labels','important','starred','in_spam','in_trash','in_inbox','in_sent','in_drafts','size','raw_size','archive_key','snippet'] as const;
export const CHUNK_SCHEMA = {...Object.fromEntries(chunkKeys.map(key=>[key,MAIL_FIELDS[key]])),subject:stored,source:stored,text:{type:'string',filterable:false,embed:{model:'voyage/voyage-4',dims:1024,dtype:'f16'}}};
export type GmailMessage = {id:string;threadId:string;labelIds?:string[];queryFlags?:string[];internalDate:string;historyId:string;sizeEstimate?:number;raw:string};
export type Row = Record<string,unknown> & {id:string};
export type IndexedMessage = {version:1;message:Row;chunks:Row[]};
export type AttachmentIndexStatus = {name:string;type:string;status:'indexed'|'unsupported'|'too-large'|'failed';characters:number;reason?:string};
const unique = (values:string[]) => [...new Set(values)];
const addresses = (list:Address[] = []):string[] => unique(list.flatMap(a => 'group' in a ? addresses(a.group) : a.address ? [a.address.toLowerCase()] : []));
const names = (list:Address[] = []):string => list.flatMap(a=>'group' in a ? [a.name,names(a.group)] : [a.name,a.address]).filter(Boolean).join('\n');
const headerValues = (mail:Email,key:string) => mail.headers.filter(h=>h.key===key).map(h=>h.value);
function searchReceiptTime(mail:Email,internalDate:string):string {
  const googleReceived=headerValues(mail,'received').filter(value=>{
    const host=value.match(/\bby\s+([^\s;()]+)/i)?.[1]?.toLowerCase();
    return !!host&&(host==='google.com'||host.endsWith('.google.com')||host==='gmail.com'||host.endsWith('.gmail.com'));
  });
  for(const value of [...headerValues(mail,'x-received'),...googleReceived]){
    const separator=value.lastIndexOf(';');if(separator<0)continue;
    const timestamp=Date.parse(value.slice(separator+1).trim());
    if(Number.isFinite(timestamp))return new Date(timestamp).toISOString();
  }
  return internalDate;
}
const MAX_EXTRACT_BYTES=2*1024*1024, MAX_ZIP_BYTES=16*1024*1024, MAX_SEARCH_BYTES=7*1024*1024;
const textPrefix=(value:string,limit:number)=>{let result='',length=0;for(const point of value){if(length++===limit)break;result+=point;}return result;};
function rerankText(subject:string,people:string,body:string,filenames:string,attachments:{name:string;text:string}[]):string {
  const header=`Subject: ${textPrefix(subject,500)}\nPeople: ${textPrefix(people,500)}\nBody:\n`;
  const excerpts=attachments.slice(0,3).map(part=>`${textPrefix(part.name,100)}: ${textPrefix(part.text,400)}`).join('\n');
  const attachmentText=textPrefix(excerpts||filenames,1200);
  const suffix=attachmentText?`\nAttachments:\n${attachmentText}`:'';
  return header+textPrefix(body,6000-Array.from(header+suffix).length)+suffix;
}

export function labelMetadata(labelIds:string[]) {
  const labels=unique(labelIds);
  return {labels,categories:labels.filter(label=>label.startsWith('CATEGORY_')).map(label=>label.slice(9).toLowerCase()),
    unread:labels.includes('UNREAD'),has_user_labels:labels.some(label=>label.startsWith('Label_')),important:labels.includes('IMPORTANT'),starred:labels.includes('STARRED'),
    in_spam:labels.includes('SPAM'),in_trash:labels.includes('TRASH'),in_inbox:labels.includes('INBOX'),in_sent:labels.includes('SENT'),in_drafts:labels.includes('DRAFT')};
}
export function refreshIndexMetadata(index:IndexedMessage,gmail:Pick<GmailMessage,'labelIds'|'queryFlags'>):IndexedMessage {
  const patch={...labelMetadata(gmail.labelIds??[]),...(gmail.queryFlags?{query_flags:unique(gmail.queryFlags)}:{})};
  return {...index,message:{...index.message,...patch},chunks:index.chunks.map(chunk=>({...chunk,...patch}))};
}

export function newBodyText(body:string):string {
  const lines=body.replace(/\r\n?/g,'\n').split('\n');
  const result:string[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i]!;
    if(/^-- $/.test(line)||/^_{5,}\s*$/.test(line)||/^-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}$/i.test(line))break;
    if(/^On .{3,200}wrote:\s*$/i.test(line)&&lines.slice(i+1,i+4).some(next=>/^\s*>/.test(next)))break;
    if(/^\s*>/.test(line))continue;
    if(/^Sent from my (?:iPhone|iPad|Android)\s*$/i.test(line))continue;
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

function mergeBodyText(primary:string,alternative:string,excluded:string=''):string {
  const key=(value:string)=>gmailTokens(value).join(' ');
  const blocks=(value:string)=>value.trim().split(/\n\s*\n/).filter(part=>part.trim());
  const known=new Set([primary,excluded,...blocks(primary),...blocks(excluded),...excluded.split('\n')].map(key).filter(Boolean));
  const extra=blocks(alternative).filter(part=>{const normalized=key(part);if(!normalized||known.has(normalized))return false;known.add(normalized);return true;});
  return [primary.trim(),...extra].filter(Boolean).join('\n\n');
}
function messageBody(mail:Email):{sources:string[];body:string;fresh:string} {
  const plain=(mail.text??'').trim(),html=htmlToText(mail.html??'').trim();
  const sources=unique([plain,html].filter(Boolean));
  return {sources,body:mergeBodyText(plain,html),fresh:mergeBodyText(newBodyText(plain),newBodyText(html),plain)};
}

function decodeText(bytes:Uint8Array):string {
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes);
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function documentXmlText(xml:string):string {
  const parts:string[]=[];
  const parser=new Parser({ontext(value){parts.push(value);},onclosetag(name){if(/(?:^|:)(?:p|tr|row|si|text:p|text:h)$/.test(name))parts.push('\n');}}, {xmlMode:true,decodeEntities:true});
  parser.end(xml);
  return parts.join('').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function attachmentBytes(attachment:Attachment):Uint8Array {
  const content=attachment.content;
  if(typeof content==='string')return Buffer.from(content,attachment.encoding==='base64'?'base64':'utf8');
  return content instanceof Uint8Array?content:new Uint8Array(content);
}
type AttachmentWork={messages:number;bytes:number;deadline:number};
async function extractAttachment(attachment:Attachment,budget:number,work:AttachmentWork,depth=0):Promise<{parts:string[];status:AttachmentIndexStatus}> {
  const bytes=attachmentBytes(attachment),name=attachment.filename??'',type=attachment.mimeType.toLowerCase();
  const status:AttachmentIndexStatus={name,type,status:'unsupported',characters:0};
  const extension=name.toLowerCase().split('.').at(-1)??'';
  const office=['docx','pptx','xlsx','odt','ods','odp'].includes(extension)||/officedocument|opendocument/.test(type);
  const pdf=type==='application/pdf'||extension==='pdf';
  const email=type==='message/rfc822'||extension==='eml';
  const textual=type.startsWith('text/')||/^application\/(?:json|xml|csv|javascript|x-ndjson|ld\+json)$/.test(type)||['txt','md','csv','tsv','json','xml','html','htm','ics','log'].includes(extension);
  if(!office&&!textual&&!pdf&&!email)return {parts:[],status:{...status,reason:type.startsWith('image/')?'Image OCR is not installed':'No extractor for this attachment type'}};
  const limit=Math.min(MAX_EXTRACT_BYTES,budget);
  if(limit<=0||bytes.byteLength>(office||pdf||email?MAX_ZIP_BYTES:limit))return {parts:[],status:{...status,status:'too-large',reason:'Attachment extraction byte budget exceeded'}};
  try{
    let parts:string[],incomplete:AttachmentIndexStatus|undefined;
    if(email){
      if(!work.deadline)work.deadline=Date.now()+15000;
      if(depth>=8||work.messages>=64||bytes.byteLength>work.bytes||Date.now()>work.deadline)return {parts:[],status:{...status,status:'too-large',reason:'Nested email depth, count, byte or time budget exceeded'}};
      work.messages++;work.bytes-=bytes.byteLength;
      const nested:Email=await PostalMime.parse(bytes),body=messageBody(nested);
      if(Date.now()>work.deadline)return {parts:[],status:{...status,status:'too-large',reason:'Nested email extraction time budget exceeded'}};
      parts=[nested.subject??'',names(nested.from?[nested.from]:[]),names(nested.to),names(nested.cc),names(nested.bcc),nested.date??'',...body.sources].filter(part=>part.trim());
      let remaining=limit-parts.reduce((n,part)=>n+Buffer.byteLength(part)+1,0);
      if(remaining<0)return {parts:[],status:{...status,status:'too-large',reason:'Nested email text exceeds extraction byte budget'}};
      for(const child of nested.attachments){
        if(Date.now()>work.deadline){incomplete={...status,status:'too-large',reason:'Nested email extraction time budget exceeded'};break;}
        const extracted=await extractAttachment(child,remaining,work,depth+1);
        for(const part of extracted.parts){remaining-=Buffer.byteLength(part)+1;parts.push(part);}
        if(extracted.status.status!=='indexed'&&!incomplete)incomplete={...extracted.status,reason:`Nested attachment ${child.filename??child.mimeType}: ${extracted.status.reason??extracted.status.status}`};
      }
    }else if(pdf){
      const document=await getDocumentProxy(bytes.slice(),{maxImageSize:1_048_576,disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,verbosity:0});
      try{
        if(document.numPages>250)return {parts:[],status:{...status,status:'too-large',reason:'PDF exceeds the 250 page extraction limit'}};
        parts=[];let length=0;const deadline=depth?Math.min(work.deadline,Date.now()+15000):Date.now()+15000;
        for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
          if(Date.now()>deadline)return {parts:[],status:{...status,status:'too-large',reason:'PDF extraction time budget exceeded'}};
          const page=await document.getPage(pageNumber);
          const content=await page.getTextContent();
          const value=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('').trim();
          length+=Buffer.byteLength(value);
          if(length>limit)return {parts:[],status:{...status,status:'too-large',reason:'PDF text exceeds extraction byte budget'}};
          parts.push(value);page.cleanup();
        }
        if(!parts.some(part=>part.trim()))return {parts:[],status:{...status,status:'unsupported',reason:'PDF has no extractable text; image OCR is not installed'}};
      }finally{await document.loadingTask.destroy();}
    }else if(office){
      let expanded=0,rejected=false;
      const files=unzipSync(bytes,{filter:file=>{
        const selected=/^(?:word\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml|ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml|xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml|content\.xml)$/.test(file.name);
        if(!selected)return false;
        expanded+=file.originalSize;
        if(file.originalSize>limit||expanded>limit){rejected=true;return false;}
        return true;
      }});
      if(rejected)return {parts:[],status:{...status,status:'too-large',reason:'Expanded document exceeds extraction byte budget'}};
      parts=Object.entries(files).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([,value])=>documentXmlText(decodeText(value))).filter(Boolean);
      if(!Object.keys(files).length)return {parts:[],status:{...status,status:'failed',reason:'Document archive contains no supported content parts'}};
    }else{
      const decoded=decodeText(bytes);
      parts=[type==='text/html'||['html','htm'].includes(extension)?htmlToText(decoded):decoded];
    }
    if(parts.reduce((n,part)=>n+Buffer.byteLength(part)+1,0)>limit)return {parts:[],status:{...status,status:'too-large',reason:'Extracted text exceeds extraction byte budget'}};
    return {parts,status:{...status,status:incomplete?.status??'indexed',...(incomplete?{reason:incomplete.reason}:{}),characters:parts.reduce((n,part)=>n+Array.from(part).length,0)}};
  }catch(error){return {parts:[],status:{...status,status:'failed',reason:error instanceof Error?error.message:'Attachment extraction failed'}};}
}
function linkedTypes(mail:Email,body:string):string[] {
  const source=[mail.html??'',body].join('\n'),types=new Set<string>();
  for(const match of source.matchAll(/https?:\/\/[^\s<>"']+/gi)){
    let url:URL;try{url=new URL(match[0]);}catch{continue;}
    const host=url.hostname.toLowerCase(),path=url.pathname;
    if(host==='youtu.be'||host==='youtube.com'||host.endsWith('.youtube.com'))types.add('youtube');
    if(host==='drive.google.com'||host==='docs.google.com')types.add('drive');
    if(host==='docs.google.com'){
      if(path.startsWith('/document/'))types.add('document');
      if(path.startsWith('/spreadsheets/'))types.add('spreadsheet');
      if(path.startsWith('/presentation/'))types.add('presentation');
    }
  }
  return [...types].sort();
}

export async function indexMessage(gmail:GmailMessage,archiveKey:string):Promise<IndexedMessage> {
  if(!/^[a-zA-Z0-9_-]+$/.test(gmail.id)||!gmail.threadId||!/^\d+$/.test(gmail.internalDate)||!gmail.raw)throw new Error('Malformed Gmail raw message');
  const bytes=Buffer.from(gmail.raw,'base64url');
  const mail:Email=await PostalMime.parse(bytes);
  const {body,fresh:bodyNew,sources:bodySources}=messageBody(mail);
  const subject=mail.subject??'';
  const from=addresses(mail.from?[mail.from]:[]),to=addresses(mail.to),cc=addresses(mail.cc),bcc=addresses(mail.bcc);
  const roleText={from_text:names(mail.from?[mail.from]:[]),to_text:names(mail.to),cc_text:names(mail.cc),bcc_text:names(mail.bcc)};
  const people=Object.values(roleText).filter(Boolean).join('\n');
  const labels=unique(gmail.labelIds??[]);
  const attachmentNames=mail.attachments.map(a=>a.filename??'').filter(Boolean),filenames=attachmentNames.join('\n');
  const received=new Date(Number(gmail.internalDate)).toISOString();
  const sent=mail.date && Number.isFinite(Date.parse(mail.date)) ? new Date(mail.date).toISOString() : null;
  const baseText=[subject,people,filenames,...bodySources].join('\n');
  let remaining=MAX_SEARCH_BYTES-Buffer.byteLength(baseText);
  if(remaining<0)throw new Error(`Decoded message ${gmail.id} exceeds the searchable text size limit`);
  const attachmentParts:{name:string;text:string}[]=[],statuses:AttachmentIndexStatus[]=[];
  const work:AttachmentWork={messages:0,bytes:MAX_ZIP_BYTES,deadline:0};
  for(const attachment of mail.attachments){
    const extracted=await extractAttachment(attachment,remaining,work);
    statuses.push(extracted.status);
    for(const part of extracted.parts){remaining-=Buffer.byteLength(part)+1;attachmentParts.push({name:attachment.filename??'',text:part});}
  }
  const delivered=unique(headerValues(mail,'delivered-to').flatMap(value=>addresses(addressParser(value))));
  const listValues=[...headerValues(mail,'list-id'),...headerValues(mail,'list-post')];
  const listIds=unique(listValues.flatMap(value=>[...value.matchAll(/<([^>]+)>/g)].map(match=>match[1]!.replace(/^mailto:/i,'').split('?')[0]!.toLowerCase())));
  const common={message_id:gmail.id,thread_id:gmail.threadId,rfc_message_id:(mail.messageId??'').replace(/^<|>$/g,''),from_addresses:from,to_addresses:to,cc_addresses:cc,bcc_addresses:bcc,
    participants:unique([...from,...to,...cc,...bcc]),delivered_to_addresses:delivered,list_ids:listIds,
    ...labelMetadata(labels),query_flags:unique(gmail.queryFlags??[]),link_types:linkedTypes(mail,body),attachment_types:unique(mail.attachments.map(a=>a.mimeType.toLowerCase())),
    received_at:received,search_received_at:searchReceiptTime(mail,received),sent_at:sent,sort_key:`${received}:${gmail.id}`,has_attachment:mail.attachments.length>0,
    size:gmail.sizeEstimate??bytes.byteLength,raw_size:bytes.byteLength,subject,archive_key:archiveKey,snippet:textPrefix(bodyNew||body,300)};
  const sources=[subject,people,...attachmentNames,...bodySources,...attachmentParts.map(part=>part.text)];
  const message:Row={id:gmail.id,...common,...roleText,body,body_new:bodyNew,people,filenames,rerank_text:rerankText(subject,people,bodyNew,filenames,attachmentParts),list_text:listValues.join('\n'),headers:mail.headers.map(h=>`${h.key}:${h.value}`),header_names:unique(mail.headers.map(h=>h.key)),
    attachment_names:attachmentNames,attachment_text:attachmentParts.map(part=>part.text),attachment_status:JSON.stringify(statuses),attachment_complete:statuses.every(item=>item.status==='indexed'),
    literal:sources.join('\n'),search_tokens:sources.map(gmailTokenText).join('\n'),subject_tokens:gmailTokenText(subject),from_tokens:gmailTokenText(roleText.from_text),to_tokens:gmailTokenText(roleText.to_text),cc_tokens:gmailTokenText(roleText.cc_text),bcc_tokens:gmailTokenText(roleText.bcc_text),filenames_tokens:attachmentNames.map(gmailTokenText).join('\n')};
  const chunks:Row[]=[];
  const sections=[{name:'body',text:bodyNew},...attachmentParts.map((part,i)=>({name:`attachment:${i}:${part.name}`,text:part.text}))];
  const envelope=Object.fromEntries(chunkKeys.map(key=>[key,common[key]]));
  for(let section=0;section<sections.length;section++){
    const source=sections[section]!;const chars=Array.from(source.text);
    for(let offset=0;offset<Math.max(1,chars.length);offset+=2600){
      const part=chars.slice(offset,offset+3000).join('');
      chunks.push({id:`${gmail.id}-${section}-${offset}`,...envelope,subject,source:source.name,snippet:textPrefix(part,300),text:`Subject: ${textPrefix(subject,1000)}\nPeople: ${textPrefix(people,1000)}\n${source.name==='body'?'':`Attachment: ${source.name}\n`}${part}`});
      if(offset+3000>=chars.length)break;
    }
  }
  return {version:1,message,chunks};
}
export function filters(input:ArchiveSearch):unknown[] {
  const result:unknown[]=[];
  for(const [key,field] of [['from','from_addresses'],['to','to_addresses'],['participant','participants']] as const)if(input[key])result.push([field,'Contains',input[key]!.toLowerCase()]);
  if(input.thread)result.push(['thread_id','Eq',input.thread]);
  if(input.messageId)result.push(['rfc_message_id','Eq',input.messageId.replace(/^<|>$/g,'')]);
  for(const label of input.labels??[])result.push(['labels','Contains',label]);
  if(input.after)result.push(['received_at','Gte',input.after]);
  if(input.before)result.push(['received_at','Lt',input.before]);
  if(input.unread!==undefined)result.push(['unread','Eq',input.unread]);
  if(input.hasAttachment!==undefined)result.push(['has_attachment','Eq',input.hasAttachment]);
  if(input.mode==='exact' && input.text)result.push(['literal','Regex',input.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')]);
  return result;
}
export const and = (conditions:unknown[]) => conditions.length ? {filters:['And',conditions]} : {};
export function fuse(rankings:Row[][],limit:number):Row[] {
  const found=new Map<string,{row:Row;score:number}>();
  for(const ranking of rankings){const seen=new Set<string>();let rank=0;for(const row of ranking){const id=String(row.message_id??row.id);if(seen.has(id))continue;seen.add(id);rank++;const old=found.get(id);found.set(id,{row:old?.row??row,score:(old?.score??0)+1/(60+rank)});}}
  return [...found.values()].sort((a,b)=>b.score-a.score).slice(0,limit).map(({row,score})=>({...row,id:String(row.message_id??row.id),score}));
}
