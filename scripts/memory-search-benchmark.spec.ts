import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir,cpus,platform,arch} from 'node:os'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'
import {expect,it} from 'vitest'
import {Store} from '../src/app/store.ts'
import {AmphoreusStore} from '../src/amphoreus/store.ts'
import {MemoryStore} from '../src/amphoreus/memory.ts'
it('measures real indexed retrieval over 100k synthetic records',()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-100k-')),file=process.env.AMPHOREUS_SEARCH_DATABASE??join(dir,'db.sqlite'),host=new Store(file)
 try{
  new AmphoreusStore(host);const memory=new MemoryStore(host,'synthetic'),now=new Date().toISOString()
  const insert=host.db.prepare('INSERT INTO amphoreus_memory VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),started=performance.now()
  if(Number(host.db.prepare('SELECT count(*) AS n FROM amphoreus_memory').get()!.n)===0)host.atomic(()=>{for(let n=0;n<100000;n++)insert.run(`record-${n}`,'synthetic','input',`Project ${n}`,n%1000===0?`北京大学 项目 preference SketchPad_${n}`:`日常项目 ${n} 会议笔记 common history`,now,now,.3,'complete','{"platform":"qq"}','{}',null)})
  const buildMs=performance.now()-started,queries=['北京大学','北京','ference','SketchPad_9000','项目','会议笔记','common','日常项目 42'],samples:{query:string;ms:number;results:number}[]=[]
  for(let turn=0;turn<5;turn++)for(const query of queries){const at=performance.now(),rows=memory.find({query,limit:8});samples.push({query,ms:performance.now()-at,results:rows.length})}
  const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1]!
  host.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const report={records:100000,platform:platform(),arch:arch(),node:process.version,cpu:cpus()[0]?.model,build_ms:buildMs,database_bytes:statSync(file).size,p95_ms:p95,target_p95_ms:100,target_met:p95<=100,queries:samples,index:memory.searchStatus()}
  if(process.env.AMPHOREUS_SEARCH_REPORT)writeFileSync(process.env.AMPHOREUS_SEARCH_REPORT,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({records:report.records,p95_ms:p95,database_bytes:report.database_bytes,target_met:report.target_met}))
  expect(report.index.consistent).toBe(true);expect(samples.every(s=>s.results<=8)).toBe(true)
 }finally{host.close();rmSync(dir,{recursive:true,force:true})}
})
