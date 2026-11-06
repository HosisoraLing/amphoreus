/** Rebuildable bigram index. Encoded terms cannot inject FTS MATCH syntax. */
import type {Store} from '../app/store.ts'
export function searchTokens(value:unknown):string {
 const chars=Array.from(String(value??'').normalize('NFKC').toLowerCase()),tokens=new Set<string>()
 for(let n=1;n<chars.length;n++)tokens.add(`g${chars[n-1]!.codePointAt(0)!.toString(16)}x${chars[n]!.codePointAt(0)!.toString(16)}`)
 return [...tokens].join(' ')
}
export function searchMatch(query:string,expand=true):string|undefined {
 const terms=[...new Set([query,...expand?query.split(/\s+/):[]])].filter(Boolean).slice(0,12)
 if(terms.some(term=>Array.from(term.normalize('NFKC')).length<2))return undefined
 return terms.map(term=>'('+searchTokens(term).split(' ').slice(0,64).map(token=>`"${token}"`).join(' AND ')+')').join(' OR ')
}
export function selectiveMatch(host:Pick<Store,'db'>,query:string,expand=true){
 const match=searchMatch(query,expand)
 if(!match)return undefined
 const terms=expand?[query,...query.split(/\s+/)]:[query]
 for(const term of terms){
  const tokens=searchTokens(term).split(' ').slice(0,64)
  const row=host.db.prepare(`SELECT min(doc) AS count,count(*) AS found FROM amphoreus_memory_vocab WHERE term IN (${tokens.map(()=>'?').join(',')})`).get(...tokens)
  // Broad posting-list intersections cost more than the compatible phrase scan.
  if(Number(row?.found)===tokens.length&&Number(row?.count)>10000)return undefined
 }
 return match
}
export function installSearchIndex(host:Pick<Store,'db'|'atomic'>,rebuild:boolean){
 host.db.function('amphoreus_search_tokens',{deterministic:true},searchTokens)
 host.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS amphoreus_memory_fts USING fts5(title,text,source,origins);
 CREATE VIRTUAL TABLE IF NOT EXISTS amphoreus_memory_vocab USING fts5vocab(amphoreus_memory_fts,'row');
 CREATE TRIGGER IF NOT EXISTS amphoreus_memory_fts_insert AFTER INSERT ON amphoreus_memory BEGIN
 INSERT INTO amphoreus_memory_fts(rowid,title,text,source,origins) VALUES(new.rowid,amphoreus_search_tokens(new.title),amphoreus_search_tokens(new.text),amphoreus_search_tokens(new.source),amphoreus_search_tokens(COALESCE(new.data ->> '$.origins',''))); END;
 CREATE TRIGGER IF NOT EXISTS amphoreus_memory_fts_update AFTER UPDATE ON amphoreus_memory BEGIN
 DELETE FROM amphoreus_memory_fts WHERE rowid=old.rowid;
 INSERT INTO amphoreus_memory_fts(rowid,title,text,source,origins) VALUES(new.rowid,amphoreus_search_tokens(new.title),amphoreus_search_tokens(new.text),amphoreus_search_tokens(new.source),amphoreus_search_tokens(COALESCE(new.data ->> '$.origins',''))); END;
 CREATE TRIGGER IF NOT EXISTS amphoreus_memory_fts_delete AFTER DELETE ON amphoreus_memory BEGIN DELETE FROM amphoreus_memory_fts WHERE rowid=old.rowid; END;`)
 if(rebuild)rebuildSearchIndex(host)
}
export function rebuildSearchIndex(host:Pick<Store,'db'|'atomic'>){
 return host.atomic(()=>{
  host.db.exec(`DELETE FROM amphoreus_memory_fts;
    INSERT INTO amphoreus_memory_fts(rowid,title,text,source,origins) SELECT rowid,amphoreus_search_tokens(title),amphoreus_search_tokens(text),amphoreus_search_tokens(source),amphoreus_search_tokens(COALESCE(data ->> '$.origins','')) FROM amphoreus_memory;
    INSERT INTO amphoreus_memory_fts(amphoreus_memory_fts) VALUES('integrity-check');`)
  const status=searchIndexStatus(host)
  if(!status.consistent)throw Error('Memory search index is inconsistent; original memory preserved')
  return status
 })
}
export function searchIndexStatus(host:Pick<Store,'db'>){
 const originals=Number(host.db.prepare('SELECT count(*) AS n FROM amphoreus_memory').get()!.n)
 const indexed=Number(host.db.prepare('SELECT count(*) AS n FROM amphoreus_memory_fts').get()!.n)
 const missing=Number(host.db.prepare('SELECT count(*) AS n FROM amphoreus_memory m WHERE NOT EXISTS(SELECT 1 FROM amphoreus_memory_fts f WHERE f.rowid=m.rowid)').get()!.n)
 return{originals,indexed,missing,consistent:originals===indexed&&missing===0}
}
