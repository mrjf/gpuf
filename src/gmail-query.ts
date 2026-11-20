export type GmailQuery =
  | {kind:'all'}
  | {kind:'term';value:string;quoted:boolean;exact:boolean;field?:string}
  | {kind:'and';children:GmailQuery[]}
  | {kind:'or';children:GmailQuery[]}
  | {kind:'not';child:GmailQuery}
  | {kind:'scope';field:string;child:GmailQuery}
  | {kind:'near';left:GmailQuery;right:GmailQuery;distance:number;ordered:boolean};

export type GmailQueryContext = {
  me?:string;
  aliases?:string[];
  labels?:{id:string;name:string}[];
  now?:number|Date;
  mode?:'strict'|'semantic';
  capabilities?:string[];
};
export type GmailFilter = unknown[];
export type GmailQueryPlan = {
  ast:GmailQuery;
  filter:GmailFilter|null;
  text:string;
  semanticText:string|null;
  requiredFields:string[];
  warnings:string[];
  matches:(row:Record<string,unknown>)=>boolean;
};
export class GmailQueryError extends Error {
  constructor(message:string,readonly position?:number){super(position===undefined?message:`${message} at character ${position+1}`);this.name='GmailQueryError';}
}

type Token = {kind:'word'|'quoted'|'('|')'|'{'|'}'|'-'|'+';value:string;at:number};
const fields=new Set(['from','to','cc','bcc','deliveredto','subject','filename','after','before','older','newer','older_than','newer_than','size','larger','smaller','label','category','in','is','has','list','rfc822msgid','header']);
const escapeRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function gmailTokens(value:string):string[]{return (value.normalize('NFKC').toLowerCase().match(/\p{N}+(?:,\p{N}{3})+(?:\.\p{N}+)*|[\p{L}\p{M}\p{N}]+(?:\.\p{N}+)*/gu)??[]).map(token=>token.replaceAll(',',''));}
export function gmailTokenText(value:string):string{return ` ${gmailTokens(value).join(' ')} `;}

function lex(query:string):Token[]{
  const result:Token[]=[];
  for(let at=0;at<query.length;){
    if(/\s/.test(query[at]!)){at++;continue;}
    const start=at,ch=query[at]!;
    if('(){}-+'.includes(ch)){result.push({kind:ch as Token['kind'],value:ch,at:at++});continue;}
    if(ch==='"'){
      let value='';at++;
      while(at<query.length&&query[at]!=='"'){
        if(query[at]==='\\'&&at+1<query.length&&['"','\\'].includes(query[at+1]!))at++;
        value+=query[at++];
      }
      if(at===query.length)throw new GmailQueryError('Unclosed quotation',start);
      at++;if(!value.trim())throw new GmailQueryError('An exact phrase cannot be empty',start);
      result.push({kind:'quoted',value,at:start});continue;
    }
    let value='';
    while(at<query.length&&!/[\s(){}"]/.test(query[at]!))value+=query[at++];
    result.push({kind:'word',value,at:start});
  }
  return result;
}

const combine=(kind:'and'|'or',children:GmailQuery[]):GmailQuery=>children.length===0?{kind:'all'}:children.length===1?children[0]!:{kind,children};
export function parseGmailQuery(query:string):GmailQuery {
  if(query.length>8192)throw new GmailQueryError('Search queries are limited to 8192 characters');
  const tokens=lex(query);let at=0,depth=0;
  const peek=()=>tokens[at];
  const word=(value:string)=>peek()?.kind==='word'&&peek()?.value===value;
  const end=()=>!peek()||peek()?.kind===')'||peek()?.kind==='}';
  function expression(implicitOr=false):GmailQuery{
    const groups:GmailQuery[]=[];
    while(!end()){
      const alternatives:GmailQuery[]=[explicitAnd()];
      while(word('OR')){
        at++;if(end())throw new GmailQueryError('OR needs a right operand',tokens[at-1]!.at);
        alternatives.push(explicitAnd());
      }
      groups.push(combine('or',alternatives));
    }
    return combine(implicitOr?'or':'and',groups);
  }
  function explicitAnd():GmailQuery{
    const terms:GmailQuery[]=[near()];
    while(word('AND')){
      at++;if(end()||word('OR'))throw new GmailQueryError('AND needs a right operand',tokens[at-1]!.at);
      terms.push(near());
    }
    return combine('and',terms);
  }
  function near():GmailQuery{
    let left=unary();
    while(word('AROUND')){
      const op=tokens[at++]!,distance=tokens[at++];
      if(distance?.kind!=='word'||!/^\d+$/.test(distance.value)||Number(distance.value)>1000)throw new GmailQueryError('AROUND needs a distance from 0 through 1000',op.at);
      if(end())throw new GmailQueryError('AROUND needs a right operand',op.at);
      left={kind:'near',left,right:unary(),distance:Number(distance.value),ordered:false};
    }
    return left;
  }
  function unary():GmailQuery{
    const token=tokens[at++];if(!token)throw new GmailQueryError('Expected a search term');
    if((token.kind==='+'||token.kind==='-')&&peek()?.kind==='word'&&['AND','OR','AROUND'].includes(peek()!.value)){
      const child:GmailQuery={kind:'term',value:tokens[at++]!.value,quoted:false,exact:true};
      return token.kind==='-'?{kind:'not',child}:child;
    }
    if(token.kind==='-')return {kind:'not',child:unary()};
    if(token.kind==='+'){
      const child=unary();if(child.kind!=='term')throw new GmailQueryError('+ needs a word or phrase',token.at);
      return {...child,exact:true};
    }
    if(token.kind==='('||token.kind==='{'){
      if(++depth>32)throw new GmailQueryError('Search groups are nested too deeply',token.at);
      const closing=token.kind==='('?')':'}';
      if(peek()?.kind===closing)throw new GmailQueryError('A search group cannot be empty',token.at);
      const node=expression(token.kind==='{');
      if(peek()?.kind!==closing)throw new GmailQueryError(`Expected ${closing}`,token.at);
      at++;depth--;return node;
    }
    if(token.kind==='quoted'){
      if(/\bAROUND\s+\d+\b/.test(token.value)){
        const child=parseGmailQuery(token.value);
        if(child.kind!=='near')throw new GmailQueryError('An ordered AROUND expression needs two terms',token.at);
        return {...child,ordered:true};
      }
      return {kind:'term',value:token.value,quoted:true,exact:true};
    }
    if(token.kind!=='word'||['AND','OR','AROUND'].includes(token.value))throw new GmailQueryError('Expected a search term',token.at);
    const scoped=/^([A-Za-z_][A-Za-z_\d]*):(.*)$/.exec(token.value);
    if(scoped&&fields.has(scoped[1]!.toLowerCase())){
      const field=scoped[1]!.toLowerCase(),value=scoped[2]!;
      if(value)return {kind:'term',field,value,quoted:false,exact:false};
      if(end()||word('AND')||word('OR'))throw new GmailQueryError(`${field}: needs a value`,token.at);
      return {kind:'scope',field,child:unary()};
    }
    return {kind:'term',value:token.value,quoted:false,exact:!!scoped?.[2]};
  }
  const ast=expression();
  if(at!==tokens.length)throw new GmailQueryError('Unexpected closing group',tokens[at]!.at);
  return ast;
}

const labelAliases:Record<string,string>={inbox:'INBOX',sent:'SENT',draft:'DRAFT',drafts:'DRAFT',spam:'SPAM',trash:'TRASH',unread:'UNREAD',read:'UNREAD',starred:'STARRED',important:'IMPORTANT',chat:'CHAT',chats:'CHAT'};
const categories:Record<string,string>={primary:'CATEGORY_PERSONAL',social:'CATEGORY_SOCIAL',promotions:'CATEGORY_PROMOTIONS',updates:'CATEGORY_UPDATES',forums:'CATEGORY_FORUMS',reservations:'CATEGORY_RESERVATIONS',purchases:'CATEGORY_PURCHASES'};
const stars=new Set(['yellow-star','orange-star','red-star','purple-star','blue-star','green-star','red-bang','orange-guillemet','yellow-bang','green-check','blue-info','purple-question']);
const tokenFields:Record<string,string>={from:'from_tokens',to:'to_tokens',cc:'cc_tokens',bcc:'bcc_tokens',subject:'subject_tokens',filename:'filenames_tokens'};

function dateValue(value:string):string{
  if(/^\d+$/.test(value)){const time=Number(value)*1000;if(Number.isFinite(time)&&time<=8640000000000000)return new Date(time).toISOString();}
  const ymd=/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value),mdy=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const year=Number(ymd?.[1]??mdy?.[3]),month=Number(ymd?.[2]??mdy?.[1]),day=Number(ymd?.[3]??mdy?.[2]);
  const date=new Date(Date.UTC(year,month-1,day));
  if(!Number.isFinite(date.getTime())||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new GmailQueryError(`Invalid Gmail date ${value}; use YYYY/MM/DD or epoch seconds`);
  return date.toISOString();
}
function relativeDate(value:string,now:number):string{
  const match=/^(\d+)([dmy])$/i.exec(value);if(!match)throw new GmailQueryError(`Invalid relative date ${value}; use a number followed by d, m, or y`);
  const days=Number(match[1])*({d:1,m:30,y:365}[match[2]!.toLowerCase()]!);
  const time=now-days*86400000;if(!Number.isFinite(time)||Math.abs(time)>8640000000000000)throw new GmailQueryError('Relative date is out of range');return new Date(time).toISOString();
}
function sizeValue(value:string):number{
  const match=/^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(value);if(!match)throw new GmailQueryError(`Invalid message size ${value}`);
  const bytes=Number(match[1])*1024**({ '':0,k:1,m:2,g:3}[match[2]!.toLowerCase()]!);
  if(!Number.isSafeInteger(bytes))throw new GmailQueryError('Message size must be a whole number of bytes in range');return bytes;
}
function atomValues(node:GmailQuery,scope?:string):{value:string;field?:string} {
  if(node.kind==='scope')return atomValues(node.child,node.field);
  if(node.kind!=='term')throw new GmailQueryError('AROUND operands must be words or phrases');
  return {value:node.value,field:node.field??scope};
}
function hasLocation(node:GmailQuery,scope?:string,negated=false):boolean{
  if(node.kind==='not')return hasLocation(node.child,scope,!negated);
  if(node.kind==='scope')return hasLocation(node.child,node.field,negated);
  if(node.kind==='and'||node.kind==='or')return node.children.some(child=>hasLocation(child,scope,negated));
  return node.kind==='term'&&!negated&&(node.field??scope)==='in'&&['anywhere','spam','trash'].includes(node.value.toLowerCase());
}
function simplify(kind:'And'|'Or',children:(GmailFilter|null)[]):GmailFilter|null{
  if(kind==='Or'&&children.includes(null))return null;
  const present=children.filter((v):v is GmailFilter=>v!==null);
  return present.length===0?null:present.length===1?present[0]!: [kind,present];
}
function tokenFilter(field:string,value:string,phrase:boolean):GmailFilter{
  const tokens=gmailTokens(value);if(!tokens.length)throw new GmailQueryError('Search text contains no searchable words');
  const make=(words:string[])=>[field,'Regex',`(^| )${words.map(escapeRegex).join(' ')}( |$)`];
  return phrase?make(tokens):simplify('And',tokens.map(word=>make([word])))!;
}

/** Ranking terms can include hard predicates and alternatives; a verifier needs one conjunctive free intent. */
export function gmailSemanticText(ast:GmailQuery):string|null {
  const terms:string[]=[];let alternative=false;
  function visit(node:GmailQuery,underOr=false):void {
    if(node.kind==='and'||node.kind==='or'){
      for(const child of node.children)visit(child,underOr||node.kind==='or');
    }else if(node.kind==='term'&&!node.field&&!node.quoted&&!node.exact){
      if(underOr)alternative=true;
      else terms.push(node.value);
    }
  }
  visit(ast);
  const text=terms.join(' ');
  return !alternative&&gmailTokens(text).length>=5?text:null;
}

export function compileGmailQuery(query:string|GmailQuery,context:GmailQueryContext={}):GmailQueryPlan{
  const ast=typeof query==='string'?parseGmailQuery(query):query,terms:string[]=[];
  const now=context.now instanceof Date?context.now.getTime():context.now??Date.now();
  if(!Number.isFinite(now))throw new GmailQueryError('Invalid search clock');
  const sourceFlag=(operator:string):GmailFilter=>{
    if(!context.capabilities?.includes(operator))throw new GmailQueryError(`${operator} requires metadata that Gmail has not supplied to this archive`);
    return ['query_flags','Contains',operator];
  };
  function compile(node:GmailQuery,scope?:string,negative=false):GmailFilter|null{
    if(node.kind==='all')return null;
    if(node.kind==='and'||node.kind==='or')return simplify(node.kind==='and'?'And':'Or',node.children.map(child=>compile(child,scope,negative)));
    if(node.kind==='not'){const child=compile(node.child,scope,true);return child?['Not',child]:['id','Eq',''];}
    if(node.kind==='scope')return compile(node.child,node.field,negative);
    if(node.kind==='near'){
      const left=atomValues(node.left,scope),right=atomValues(node.right,scope);
      if(left.field!==right.field)throw new GmailQueryError('AROUND operands must search the same field');
      if(left.field&&!tokenFields[left.field])throw new GmailQueryError(`AROUND is not supported for ${left.field}:`);
      const field=left.field?tokenFields[left.field]!:'search_tokens',a=gmailTokens(left.value),b=gmailTokens(right.value);
      if(!a.length||!b.length)throw new GmailQueryError('AROUND operands must contain searchable words');
      const one=(first:string[],second:string[])=>`${first.map(escapeRegex).join(' ')}(?: [^ \\n]+){0,${node.distance}} ${second.map(escapeRegex).join(' ')}`;
      const pattern=node.ordered?one(a,b):`(?:${one(a,b)}|${one(b,a)})`;
      if(!negative)terms.push(left.value,right.value);
      return simplify('Or',(left.field==='to'?['to_tokens','cc_tokens','bcc_tokens']:[field]).map(field=>[field,'Regex',`(^| )${pattern}( |$)`]));
    }
    const field=node.field??scope,value=node.value,lower=value.toLowerCase();
    if(!field){
      if(!negative)terms.push(value);
      if(context.mode==='semantic'&&!negative&&!node.exact&&!node.quoted)return null;
      return tokenFilter('search_tokens',value,node.quoted||node.exact);
    }
    if(['from','to','cc','bcc'].includes(field)){
      return simplify('Or',(field==='to'?['to','cc','bcc']:[field]).map(role=>{
        if(lower==='me'){
          if(!context.me)throw new GmailQueryError(`${field}:me needs the connected account identity`);
          return [`${role}_addresses`,'ContainsAny',[...new Set([context.me,...(context.aliases??[])].map(address=>address.toLowerCase()))]];
        }
        if(lower.startsWith('@'))return [`${role}_text`,'Regex',`(?i)${escapeRegex(lower)}(?:$|[^a-z0-9_.-])`];
        if(value.includes('@'))return [`${role}_addresses`,'ContainsAny',context.me?.toLowerCase()===lower?[...new Set([lower,...(context.aliases??[]).map(address=>address.toLowerCase())])]:[lower.replace(/^<|>$/g,'')]];
        return tokenFilter(tokenFields[role]!,value,node.quoted||node.exact);
      }));
    }
    if(field==='subject'||field==='filename'){
      if(!negative)terms.push(value);
      return tokenFilter(tokenFields[field]!,value,node.quoted||node.exact);
    }
    if(field==='deliveredto'){
      if(lower==='me'){
        if(!context.me)throw new GmailQueryError('deliveredto:me needs the connected account identity');
        return ['delivered_to_addresses','ContainsAny',[context.me,...(context.aliases??[])].map(address=>address.toLowerCase())];
      }
      return ['delivered_to_addresses','Contains',lower];
    }
    if(field==='rfc822msgid')return ['rfc_message_id','Eq',value.replace(/^<|>$/g,'')];
    if(field==='list')return ['list_ids','Regex',`(?i)${escapeRegex(value.replace(/^<|>$/g,'')).replaceAll('@','[.@]')}`];
    if(field==='header'){
      const colon=value.indexOf(':'),name=(colon<0?value:value.slice(0,colon)).toLowerCase();
      if(!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name))throw new GmailQueryError('Invalid header name');
      return colon<0?['header_names','Contains',name]:['headers','Regex',`(?i)^${escapeRegex(name)}:.*${escapeRegex(value.slice(colon+1))}`];
    }
    if(['after','before','older','newer','older_than','newer_than'].includes(field)){
      const relative=field.endsWith('_than'),epoch=!relative&&/^\d+$/.test(value);
      const cutoff=relative?relativeDate(value,now):dateValue(value),op=['after','newer','newer_than'].includes(field)?relative?'Gt':'Gte':epoch?'Lte':'Lt';
      return ['And',[['search_received_at','NotEq',null],['search_received_at',op,cutoff]]];
    }
    if(['size','larger','smaller'].includes(field))return ['And',[['size','NotEq',null],['size',field==='smaller'?'Lt':'Gt',sizeValue(value)]]];
    if(field==='label'){
      if(lower==='encryptedmail')return sourceFlag('label:encryptedmail');
      const label=labelAliases[lower]??context.labels?.find(label=>label.id===value||label.name.toLowerCase()===lower)?.id;
      if(lower==='read')return ['Not',['labels','Contains','UNREAD']];
      return label?['labels','Contains',label]:['id','Eq',''];
    }
    if(field==='category'){
      if(lower==='reservations'||lower==='purchases')return sourceFlag(`category:${lower}`);
      const label=categories[lower];if(!label)throw new GmailQueryError(`Unknown Gmail category ${value}`);return ['labels','Contains',label];
    }
    if(field==='in'){
      if(lower==='anywhere'||lower==='all')return null;
      if(lower==='archive')return sourceFlag('in:archive');
      if(lower==='snoozed')return sourceFlag('in:snoozed');
      if(lower==='chat'||lower==='chats')return sourceFlag('in:chats');
      const label=labelAliases[lower];if(!label)throw new GmailQueryError(`Unknown Gmail location ${value}`);
      return lower==='read'?['Not',['labels','Contains',label]]:['labels','Contains',label];
    }
    if(field==='is'){
      if(lower==='muted')return sourceFlag('is:muted');
      if(lower==='snoozed')return sourceFlag('in:snoozed');
      if(lower==='chat')return sourceFlag('in:chats');
      if(lower==='read')return ['unread','Eq',false];
      if(lower==='unread')return ['unread','Eq',true];
      if(['starred','important','sent','draft','drafts','chat'].includes(lower))return ['labels','Contains',labelAliases[lower]!];
      throw new GmailQueryError(`Unknown Gmail state ${value}`);
    }
    if(field==='has'){
      if(lower==='attachment')return ['has_attachment','Eq',true];
      if(lower==='userlabels'||lower==='nouserlabels')return ['has_user_labels','Eq',lower==='userlabels'];
      if(['youtube','drive','document','spreadsheet','presentation'].includes(lower))return ['link_types','Contains',lower];
      if(stars.has(lower))return sourceFlag(`has:${lower}`);
      throw new GmailQueryError(`Unknown Gmail content condition ${value}`);
    }
    throw new GmailQueryError(`Unknown Gmail operator ${field}:`);
  }
  const expression=compile(ast),filter=simplify('And',[expression,...(hasLocation(ast)?[]:[['Not',['labels','ContainsAny',['SPAM','TRASH']]]])]);
  const requiredFields=new Set<string>();
  function collect(condition:GmailFilter){if(condition[0]==='And'||condition[0]==='Or')for(const child of condition[1] as GmailFilter[])collect(child);else if(condition[0]==='Not')collect(condition[1] as GmailFilter);else requiredFields.add(condition[0] as string);}
  if(filter)collect(filter);
  return {ast,filter,text:[...new Set(terms)].join(' '),semanticText:gmailSemanticText(ast),requiredFields:[...requiredFields].sort(),warnings:[],matches:row=>filter===null||matchesGmailFilter(row,filter)};
}

export function matchesGmailFilter(row:Record<string,unknown>,filter:GmailFilter):boolean{
  const [field,op,input]=filter;
  if(field==='And')return (op as GmailFilter[]).every(child=>matchesGmailFilter(row,child));
  if(field==='Or')return (op as GmailFilter[]).some(child=>matchesGmailFilter(row,child));
  if(field==='Not')return !matchesGmailFilter(row,op as GmailFilter);
  const actual=row[field as string]??null;
  if(op==='Eq')return actual===input;
  if(op==='NotEq')return actual!==input;
  if(op==='In')return (input as unknown[]).includes(actual);
  if(op==='NotIn')return !(input as unknown[]).includes(actual);
  if(op==='Contains')return Array.isArray(actual)&&actual.includes(input);
  if(op==='ContainsAny')return Array.isArray(actual)&&(input as unknown[]).some(value=>actual.includes(value));
  if(op==='Regex'){
    const expression=String(input),ignoreCase=expression.startsWith('(?i)'),regex=new RegExp(ignoreCase?expression.slice(4):expression,ignoreCase?'iu':'u');
    return (Array.isArray(actual)?actual:[actual]).some(value=>typeof value==='string'&&regex.test(value));
  }
  if((typeof actual!=='string'&&typeof actual!=='number')||(typeof input!=='string'&&typeof input!=='number'))return false;
  if(op==='Gt')return actual>input;
  if(op==='Gte')return actual>=input;
  if(op==='Lt')return actual<input;
  if(op==='Lte')return actual<=input;
  throw new GmailQueryError(`Unsupported local filter ${String(op)}`);
}
