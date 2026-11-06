#!/usr/bin/env node
/** Offline index maintenance; never delete authoritative memory. Stop the runtime first. */
import {Store} from '../lib/amphoreus-data.js'
import {AmphoreusStore,MemoryStore} from '../lib/index.js'
const [operation,file,role]=process.argv.slice(2)
if(!['check','rebuild'].includes(operation)||!file||!role){console.error('Usage: node scripts/amphoreus-memory-index.mjs check|rebuild DATABASE ROLE (Runtime stopped)');process.exit(2)}
const host=new Store(file)
try{new AmphoreusStore(host);const memory=new MemoryStore(host,role);console.log(JSON.stringify(operation==='rebuild'?memory.rebuildSearch():memory.searchStatus()))}finally{host.close()}
